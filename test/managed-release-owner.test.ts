/** Native strict Journal integration; no simulated store or skipped Host interop. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GraphError, freezeJSON } from '../src/core/graph/canonical.js';
import { changeEvent, resolveFacts, RevisionState } from '../src/core/graph/events.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import type { JSONObject } from '../src/core/graph/model.js';
import { replayReleases } from '../src/managed-releases.js';
import { LocalServingCoordinator } from '../src/application/managed-serving.js';
import {
  FileJournalReleaseOwner,
  releaseJournalProjector,
} from '../src/server/managed-releases.js';
import { FileJournal, CommitUnknown } from '../src/server/managed-journal.js';
import { barrier, nativeReleaseFixture, seedDigest } from './managed-release-fixtures.js';

const schemaPath =
  process.env.CONTEXTURE_MANAGED_SCHEMA ??
  path.join(
    process.env.CONTEXTURE_PYTHON_REFERENCE ??
      fileURLToPath(new URL('../../contexture-mcp/', import.meta.url)),
    'spec/managed/schemas/managed.schema.json',
  );
const schema: unknown = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

function store(fault?: (stage: string) => void) {
  const f = nativeReleaseFixture();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'contexture-ts-release-'));
  fs.chmodSync(base, 0o700);
  const root = path.join(base, 'store'),
    projector = releaseJournalProjector(f.graphs);
  const open = () =>
    FileJournal.open(root, { schema, projector, ...(fault === undefined ? {} : { fault }) });
  let journal: FileJournal;
  try {
    journal = open();
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true });
    throw error;
  }
  journal.append([f.seed], { actor_ref: 'actor' });
  const owner = (writer: FileJournal) =>
    new FileJournalReleaseOwner(writer, {
      graphID: 'graph',
      targetID: 'target',
      host: f.host,
      history: f.history,
      compilation: f.compilation,
    });
  return {
    f,
    base,
    root,
    open,
    journal,
    owner,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
function serving(s: ReturnType<typeof store>, owner: FileJournalReleaseOwner) {
  return new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: owner,
    provider: owner.servingProvider(s.f.provider),
    observation: owner,
  });
}

test('real Journal release receipts are actor-scoped, CAS fenced, replayed and retry-stable', () => {
  const s = store();
  let journal = s.journal;
  try {
    let owner = s.owner(journal);
    const request = s.f.request(),
      first = owner.request(request),
      sequence = journal.watermark;
    assert.deepEqual(owner.request(request), first);
    assert.equal(journal.watermark, sequence);
    s.f.setApproval(false);
    const compileCalls = s.f.counts().proofCalls;
    assert.deepEqual(owner.request(request), first);
    assert.equal(s.f.counts().proofCalls, compileCalls);
    assert.equal(journal.watermark, sequence);
    s.f.setApproval(true);
    assert.throws(() => owner.request(s.f.request({ reason: 'different' })), {
      code: 'idempotency_conflict',
    });
    assert.throws(() => owner.request(s.f.request({ idempotency_key: 'next' })), {
      code: 'revision_conflict',
    });
    s.f.setActor('other-actor');
    const second = owner.request(s.f.request({ expected_desired_epoch: '1', policy: 'latest' }));
    assert.equal((second.release as JSONObject).release_epoch, '2');
    s.f.setActor('actor');
    assert.deepEqual(owner.request(request), first);
    const checkpoint = journal.checkpoint();
    assert.equal((checkpoint.desired_releases as JSONObject[])[0]?.release_epoch, '2');
    journal.close();
    journal = s.open();
    owner = s.owner(journal);
    assert.deepEqual(owner.request(request), first);
    assert.equal(owner.capture()?.release_epoch, '2');
    assert.deepEqual(
      replayReleases(freezeJSON(journal.records()) as readonly JSONObject[]).release_operations.map(
        (op) => op.status,
      ),
      ['requested', 'superseded', 'requested'],
    );
    assert.equal(s.f.counts().handlers + s.f.counts().decoders + s.f.counts().nativeValidators, 0);
  } finally {
    journal.close();
    s.cleanup();
  }
});

test('all current identity/admission/approval checks precede commit; reentrant or changed evidence cannot append', () => {
  const s = store();
  try {
    const owner = s.owner(s.journal),
      sequence = s.journal.watermark;
    s.f.setPermit(false);
    assert.throws(() => owner.request(s.f.request()), GraphError);
    s.f.setPermit(true);
    s.f.setApproval(false);
    assert.throws(() => owner.request(s.f.request()), GraphError);
    s.f.setApproval(true);
    s.f.setBeforeFence((admission) => {
      if (admission.operation === 'release.request') s.f.setApproval(false);
    });
    assert.throws(() => owner.request(s.f.request()), GraphError);
    assert.equal(s.journal.watermark, sequence);
    s.f.setApproval(true);
    s.f.setBeforeFence(() => {
      assert.throws(() => owner.capture(), { code: 'resource_busy' });
    });
    owner.request(s.f.request());
    s.f.setBeforeFence(undefined);
  } finally {
    s.journal.close();
    s.cleanup();
  }
});

test('requested immutable history is compiled exactly, never substituted with graph head', () => {
  const s = store();
  try {
    const raw = s.f.definition.asJSON() as JSONObject;
    const changed = GraphDefinition.fromJSON({
      ...raw,
      nodes: (raw.nodes as readonly JSONObject[]).map((node) =>
        node.node_id === 'root' ? { ...node, description: 'new head' } : node,
      ),
    });
    const base = new RevisionState(s.f.definition, '1');
    s.journal.append(
      [
        changeEvent(base, resolveFacts(base, changed), {
          commandDigest: seedDigest,
          reason: 'head advanced',
        }),
      ],
      { actor_ref: 'actor' },
    );
    const owner = s.owner(s.journal);
    owner.request(s.f.request());
    assert.equal(owner.capture()?.snapshot.revision, '1');
    assert.equal(owner.capture()?.snapshot.definitionDigest, s.f.definition.definitionDigest);
    const bad = new FileJournalReleaseOwner(s.journal, {
      graphID: 'graph',
      targetID: 'target',
      host: s.f.host,
      compilation: s.f.compilation,
      history: {
        read(_graph, _revision, view) {
          return {
            snapshot: new RevisionState(changed, '2'),
            storeID: view.storeID,
            journalSeq: '1',
            recordHash: view.records[0]!.record_hash as string,
          };
        },
      },
    });
    assert.throws(() => bad.capture(), { code: 'contract_mismatch' });
  } finally {
    s.journal.close();
    s.cleanup();
  }
});

test('durable ready/observed facts follow real local adoption; replay never restores an active pointer', async () => {
  const s = store();
  let journal = s.journal;
  const owner = s.owner(journal),
    coordinator = serving(s, owner);
  try {
    owner.request(s.f.request());
    const result = await coordinator.prepare();
    assert.equal(result.status, 'local_observed');
    const state = replayReleases(freezeJSON(journal.records()) as readonly JSONObject[]);
    assert.equal(state.prepare_attempt_history[0]?.status, 'ready');
    assert.equal(state.observations_history[0]?.boot_id, coordinator.bootID);
    const watermark = journal.watermark;
    assert.equal((await coordinator.retryObservation()).status, 'local_observed');
    assert.equal(journal.watermark, watermark);
    journal.checkpoint();
    await coordinator.shutdown();
    journal.close();
    journal = s.open();
    const recovered = s.owner(journal),
      restarted = serving(s, recovered);
    assert.equal(restarted.current, undefined);
    assert.equal(
      replayReleases(freezeJSON(journal.records()) as readonly JSONObject[]).observations_history
        .length,
      1,
    );
    assert.equal((await restarted.prepare()).status, 'local_observed');
    const boots = replayReleases(
      freezeJSON(journal.records()) as readonly JSONObject[],
    ).observations_history.map((item) => item.boot_id);
    assert.equal(new Set(boots).size, 2);
    await restarted.shutdown();
    assert.equal(s.f.counts().handlers + s.f.counts().decoders + s.f.counts().nativeValidators, 0);
  } finally {
    await coordinator.shutdown();
    journal.close();
    s.cleanup();
  }
});

test('late prepared exact release persists a terminal fact but cannot replace newer desired intent', async () => {
  const s = store(),
    entered = barrier<void>(),
    finish = barrier<void>();
  const owner = s.owner(s.journal);
  const coordinator = new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: owner,
    observation: owner,
    provider: owner.servingProvider({
      async prepare(attempt, signal) {
        const ready = await s.f.provider.prepare(attempt, signal);
        if (attempt.release.release_epoch === '1') {
          entered.resolve();
          await finish.promise;
        }
        return ready;
      },
    }),
  });
  try {
    owner.request(s.f.request());
    const late = coordinator.prepare();
    await entered.promise;
    owner.request(
      s.f.request({ expected_desired_epoch: '1', idempotency_key: 'next', policy: 'latest' }),
    );
    assert.equal((await coordinator.prepare()).status, 'local_observed');
    const current = coordinator.current;
    finish.resolve();
    assert.equal((await late).status, 'superseded');
    assert.equal(coordinator.current, current);
    const state = replayReleases(freezeJSON(s.journal.records()) as readonly JSONObject[]);
    assert.equal(state.prepare_attempt_history.length, 2);
    assert.equal(state.observations_history.length, 1);
    assert.equal((state.observations_history[0]?.release as JSONObject).release_epoch, '2');
  } finally {
    finish.resolve();
    await coordinator.shutdown();
    s.journal.close();
    s.cleanup();
  }
});

for (const stage of ['record.temp_written', 'record.renamed']) {
  test(`observation failure at ${stage} keeps serving, freezes swaps and deduplicates after real close/reopen`, async () => {
    let armed = false;
    const s = store((hit) => {
      if (armed && hit === stage) {
        armed = false;
        throw new Error('injected observation failure');
      }
    });
    let journal = s.journal;
    const owner = s.owner(journal),
      coordinator = serving(s, owner);
    try {
      owner.request(s.f.request());
      s.f.setBeforeFence((admission) => {
        if (admission.operation === 'release.observe') armed = true;
      });
      const result = await coordinator.prepare();
      s.f.setBeforeFence(undefined);
      assert.equal(result.status, 'serving_unobserved');
      assert(result.error instanceof Error);
      if (stage === 'record.renamed') assert(result.error instanceof CommitUnknown);
      const active = coordinator.current;
      assert(active);
      assert.equal(active.generation.resourceState, 'prepared');
      assert.equal(owner.swapsFrozen, true);
      assert.throws(() => coordinator.prepare(), { code: 'resource_busy' });
      const lease = coordinator.lease();
      lease.resources.close();
      assert.equal(s.f.counts().disposals, 0);
      journal.close();
      journal = s.open();
      owner.recover(journal);
      assert.equal((await coordinator.retryObservation()).status, 'local_observed');
      assert.equal(coordinator.current, active);
      assert.equal(owner.swapsFrozen, false);
      const state = replayReleases(freezeJSON(journal.records()) as readonly JSONObject[]);
      assert.equal(state.observations_history.length, 1);
      const sequence = journal.watermark;
      await coordinator.retryObservation();
      assert.equal(journal.watermark, sequence);
      const unrelatedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'contexture-ts-other-release-'));
      fs.chmodSync(unrelatedBase, 0o700);
      const unrelated = FileJournal.open(path.join(unrelatedBase, 'store'), {
        schema,
        projector: releaseJournalProjector(s.f.graphs),
      });
      try {
        assert.throws(() => owner.recover(unrelated), { code: 'contract_mismatch' });
      } finally {
        unrelated.close();
        fs.rmSync(unrelatedBase, { recursive: true, force: true });
      }
    } finally {
      await coordinator.shutdown();
      journal.close();
      s.cleanup();
    }
  });
}

test('provider failure produces only the supported terminal failed fact, never start/pending facts', async () => {
  const s = store(),
    owner = s.owner(s.journal);
  const coordinator = new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: owner,
    observation: owner,
    provider: owner.servingProvider({
      async prepare() {
        throw new Error('resource acquisition failed');
      },
    }),
  });

  try {
    owner.request(s.f.request());
    assert.equal((await coordinator.prepare()).status, 'failed');
    const state = replayReleases(freezeJSON(s.journal.records()) as readonly JSONObject[]);
    assert.deepEqual(
      state.prepare_attempt_history.map((item) => item.status),
      ['failed'],
    );
    assert.equal(state.observations_history.length, 0);
    assert.equal(coordinator.current, undefined);
    const tags = s.journal
      .records()
      .flatMap((record) => (record.events as JSONObject[]).map((event) => event.type));
    assert.deepEqual(tags, [
      'GraphChangeCommitted',
      'ReleaseRequested',
      'ReleasePreparationFailed',
    ]);
  } finally {
    await coordinator.shutdown();
    s.journal.close();
    s.cleanup();
  }
});

test('revoked final swap approval leaves LKG intact and never rewrites durable ready as failed', async () => {
  const s = store(),
    owner = s.owner(s.journal),
    coordinator = serving(s, owner);
  try {
    owner.request(s.f.request());
    assert.equal((await coordinator.prepare()).status, 'local_observed');
    const active = coordinator.current;
    owner.request(s.f.request({ expected_desired_epoch: '1', idempotency_key: 'next' }));
    s.f.setBeforeFence((admission) => {
      if (admission.operation === 'release.swap') s.f.setApproval(false);
    });
    assert.equal((await coordinator.prepare()).status, 'failed');
    assert.equal(coordinator.current, active);
    s.f.setApproval(true);
    s.f.setBeforeFence(undefined);
    const state = replayReleases(freezeJSON(s.journal.records()) as readonly JSONObject[]);
    assert.deepEqual(
      state.prepare_attempt_history.map((item) => item.status),
      ['ready', 'ready'],
    );
    assert.equal(state.observations_history.length, 1);
  } finally {
    await coordinator.shutdown();
    s.journal.close();
    s.cleanup();
  }
});
