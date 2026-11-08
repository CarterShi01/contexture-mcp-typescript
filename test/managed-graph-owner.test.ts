/** Actual strict FileJournal authoring/history/release integration; no in-memory store fallback. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  FileJournalGraphOwner,
  SynchronousJournalSerialization,
  graphJournalProjector,
} from '../src/server/managed-graph.js';
import type { GraphPreview } from '../src/server/managed-graph.js';
import { FileJournal, CommitUnknown } from '../src/server/managed-journal.js';
import { FileJournalReleaseOwner } from '../src/server/managed-releases.js';
import { LocalServingCoordinator } from '../src/application/managed-serving.js';
import {
  GraphError,
  canonicalDigest,
  canonicalJSON,
  freezeJSON,
} from '../src/core/graph/canonical.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import type { JSONObject } from '../src/core/graph/model.js';
import { DEFAULT_LIMITS, GraphJournalProjection } from '../src/managed-graph.js';
import { StructuralPlan } from '../src/core/graph/compiler.js';
import { prepareGeneration } from '../src/application/managed-generation.js';
import { graphFixture } from './managed-graph-fixtures.js';

const schemaPath =
  process.env.CONTEXTURE_MANAGED_SCHEMA ??
  path.join(
    process.env.CONTEXTURE_PYTHON_REFERENCE ??
      fileURLToPath(new URL('../../contexture-mcp/', import.meta.url)),
    'spec/managed/schemas/managed.schema.json',
  );
const schema: unknown = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const expiresAt = '2026-11-07T04:30:00Z';
function store(fault?: (stage: string) => void) {
  const f = graphFixture(),
    serial = new SynchronousJournalSerialization();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'contexture-ts-graph-owner-'));
  fs.chmodSync(base, 0o700);
  const root = path.join(base, 'store');
  const open = () =>
    FileJournal.open(root, {
      schema,
      projector: graphJournalProjector(),
      ...(fault === undefined ? {} : { fault }),
    });
  let journal: FileJournal;
  try {
    journal = open();
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true });
    throw error;
  }
  const make = (writer: FileJournal) =>
    new FileJournalGraphOwner(writer, {
      host: f.host,
      serialization: serial,
      clock: f.clock,
    });
  return {
    f,
    base,
    root,
    open,
    journal,
    make,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
function boot(s: ReturnType<typeof store>, owner: FileJournalGraphOwner) {
  const preview = owner.previewBootstrap(s.f.bootstrap(), { expiresAt });
  return { preview, receipt: owner.commit(preview) };
}

test('unchanged accepted cut reuses only semantic projection and still admits each read', (t) => {
  const original = FileJournal.prototype.records;
  let fullReads = 0;
  const cursors: string[] = [];
  t.mock.method(FileJournal.prototype, 'records', function (this: FileJournal, after = '0') {
    if (after === '0') fullReads++;
    cursors.push(after);
    return original.call(this, after);
  });
  const s = store(),
    owner = s.make(s.journal);
  try {
    boot(s, owner);
    const before = fullReads;
    for (let index = 0; index < 10; index++)
      assert.equal(owner.read('graph').definitionDigest, s.f.definition.definitionDigest);
    assert.equal(fullReads, before);
    const preview = owner.preview(s.f.transaction(), { expiresAt });
    owner.commit(preview, { approvalRef: 'approved' });
    assert.equal(fullReads, before);
    assert.equal(cursors.at(-1), '1');
    s.f.setAllowed(false);
    assert.throws(() => owner.read('graph'), GraphError);
    assert.equal(fullReads, before);
    s.f.setAllowed(true);
    owner.close();
    const reopened = s.make(s.journal);
    try {
      assert.ok(fullReads > before);
      assert.equal(reopened.read('graph').revision, '2');
    } finally {
      reopened.close();
    }
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

test('real approved bootstrap writes accepted seed/receipt and reopens exact history without replay callbacks', () => {
  const s = store();
  let journal = s.journal,
    owner = s.make(journal);
  try {
    const { preview, receipt } = boot(s, owner);
    assert.equal(preview.receipt.request_digest, s.f.seedDigest);
    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.actor_ref, 'tenant-actor');
    assert.equal(journal.watermark, '1');
    assert.equal(owner.read('graph').definitionDigest, s.f.definition.definitionDigest);
    assert.deepEqual(owner.export('graph', '1'), canonicalJSON(s.f.definition.asJSON()));
    assert.throws(() => owner.commit(preview.receipt as unknown as GraphPreview), GraphError);
    assert.throws(() => s.make(journal), { code: 'resource_busy' });
    const checkpoint = journal.checkpoint();
    assert.equal((checkpoint.graphs as JSONObject[])[0]?.head, '1');
    owner.close();
    journal.close();
    journal = s.open();
    const before = s.f.counts();
    owner = s.make(journal);
    assert.deepEqual(s.f.counts(), before);
    s.f.setTime('2027-01-01T00:00:00Z');
    s.f.setApproval(false);
    s.f.setAuthority('2');
    assert.deepEqual(owner.commit(preview), receipt);
    assert.equal(journal.watermark, '1');
    assert.deepEqual(journal.readCheckpoint(), checkpoint);
  } finally {
    owner.close();
    journal.close();
    s.cleanup();
  }
});

test('preview CAS, conflicting payload, original actor-scoped retry, noop and immutable historical snapshots', () => {
  const s = store(),
    owner = s.make(s.journal);
  try {
    boot(s, owner);
    const original = owner.read('graph', '1');
    const first = owner.preview(s.f.transaction(), { expiresAt });
    const stale = owner.preview(s.f.transaction({ idempotency_key: 'other-key' }), { expiresAt });
    const conflict = owner.preview(
      s.f.transaction({
        commands: [
          {
            op: 'update_node',
            node_id: 'root',
            set_fields: { description: 'conflict' },
            unset_fields: [],
          },
        ],
      }),
      { expiresAt },
    );
    const result = owner.commit(first);
    assert.equal(result.revision, '2');
    assert.equal(owner.read('graph').definition.nodes.root?.description, 'changed');
    assert.equal(original.definition.nodes.root?.description, 'original');
    assert.deepEqual(owner.commit(first), result);
    assert.throws(() => owner.commit(stale), { code: 'revision_conflict' });
    assert.throws(() => owner.commit(conflict), { code: 'idempotency_conflict' });
    assert.equal(s.journal.watermark, '2');
    s.f.setActor('other');
    assert.equal(owner.receipt('graph', 'edit'), null);
    assert.throws(() => owner.commit(first), { code: 'approval_stale' });
    s.f.setActor('actor');
    const noop = owner.preview(s.f.transaction({ base_revision: '2', idempotency_key: 'noop' }), {
      expiresAt,
    });
    assert.equal(owner.commit(noop).status, 'noop');
    assert.equal(owner.read('graph').revision, '2');
    assert.equal(s.journal.watermark, '3');
    assert.equal(owner.history('graph').records.length, 3);
    assert.deepEqual(owner.receipt('graph', 'edit'), result);
    s.journal.checkpoint();
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

test('independent bootstrap/roots authority, exact approval, current decision, expiry and reentry all fence writes', () => {
  const s = store(),
    owner = s.make(s.journal);
  try {
    s.f.setPermissions([]);
    assert.throws(() => owner.previewBootstrap(s.f.bootstrap(), { expiresAt }), {
      code: 'permission_denied',
    });
    s.f.setPermissions(['graph.bootstrap', 'graph.roots']);
    for (const kind of ['subject', 'actor', 'expiry'] as const) {
      s.f.setBadProof(kind);
      assert.throws(() => owner.previewBootstrap(s.f.bootstrap(), { expiresAt }), {
        code: 'approval_stale',
      });
    }
    s.f.setBadProof(undefined);
    const stale = owner.previewBootstrap(s.f.bootstrap(), { expiresAt });
    s.f.setAuthority('2');
    assert.throws(() => owner.commit(stale), { code: 'approval_stale' });
    assert.equal(s.journal.watermark, '0');
    const fresh = owner.previewBootstrap(s.f.bootstrap(), { expiresAt });
    s.f.setAllowed(false);
    assert.throws(() => owner.commit(fresh), { code: 'permission_denied' });
    s.f.setAllowed(true);
    s.f.setBeforeDecision((admission) => {
      if (admission.operation === 'graph.bootstrap') {
        assert.throws(() => owner.read('graph'), { code: 'resource_busy' });
        s.f.setTime('2026-11-07T04:30:00Z');
      }
    });
    assert.throws(() => owner.commit(fresh), { code: 'approval_stale' });
    assert.equal(s.journal.watermark, '0');
    s.f.setBeforeDecision(undefined);
    s.f.setTime('2026-11-07T04:00:00Z');
    boot(s, owner);
    s.f.setPermissions(['graph.bootstrap']);
    assert.throws(
      () =>
        owner.preview(
          s.f.transaction({
            commands: [
              { op: 'remove_root', node_id: 'root' },
              { op: 'add_root', node_id: 'root', plane: 'model', position: 0 },
            ],
          }),
          { expiresAt },
        ),
      { code: 'permission_denied' },
    );
    assert.equal(s.journal.watermark, '1');
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

test('current full-read scope gates receipts, exact history and staged canonical bootstrap blobs', () => {
  const s = store(),
    owner = s.make(s.journal);
  try {
    const ref = s.journal.putBlob(canonicalJSON(s.f.definition.asJSON()), 'application/json');
    const cap = owner.previewBootstrap(s.f.bootstrap({ seed: { blob: ref } }), { expiresAt });
    owner.commit(cap);
    assert.equal(owner.read('graph', '1').definitionDigest, s.f.definition.definitionDigest);
    s.f.setAllowed(false);
    assert.throws(() => owner.read('graph'), { code: 'permission_denied' });
    assert.throws(() => owner.history('graph'), { code: 'permission_denied' });
    assert.throws(() => owner.receipt('graph', 'bootstrap'), { code: 'permission_denied' });
    s.f.setAllowed(true);
    assert.equal(s.journal.watermark, '1');
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

for (const stage of ['record.temp_written', 'record.renamed']) {
  test(`real graph append failure at ${stage} freezes the owner and recovers original receipts without blind append`, () => {
    let armed = false;
    const s = store((hit) => {
      if (armed && hit === stage) {
        armed = false;
        throw new Error('injected authoring append failure');
      }
    });
    let journal = s.journal;
    const owner = s.make(journal);
    try {
      boot(s, owner);
      const original = owner.read('graph'),
        preview = owner.preview(s.f.transaction(), { expiresAt });
      armed = true;
      assert.throws(() => owner.commit(preview), Error);
      assert.equal(owner.writesStopped, true);
      assert.throws(() => owner.read('graph'), CommitUnknown);
      assert.equal(original.definition.nodes.root?.description, 'original');
      journal.close();
      journal = s.open();
      owner.recover(journal);
      assert.equal(owner.writesStopped, false);
      const result = owner.commit(preview);
      assert.equal(result.revision, '2');
      assert.equal(journal.watermark, '2');
      assert.equal(owner.read('graph').definition.nodes.root?.description, 'changed');
      assert.deepEqual(owner.commit(preview), result);
      journal.checkpoint();
    } finally {
      owner.close();
      journal.close();
      s.cleanup();
    }
  });
}

test('owner supplies real historical release proof/shared Host serialization and complete mixed checkpoint', async () => {
  const s = store(),
    owner = s.make(s.journal);
  const compile = (definition: GraphDefinition) =>
    StructuralPlan.compile(definition, {
      no_execution_registry_digest: `sha256:${'a'.repeat(64)}`,
      compiler_contract_version: 'candidate-1',
      compiler_build: 'build',
      app_dependency_contract: { dependency_contract_id: 'app', build: 'build' },
      environment_compatibility: ['node-24'],
      locale: 'en',
    });
  let coordinator: LocalServingCoordinator | undefined;
  try {
    boot(s, owner);
    const original = owner.read('graph', '1'),
      plan = compile(original.definition);
    owner.commit(owner.preview(s.f.transaction(), { expiresAt }));
    const releases = new FileJournalReleaseOwner(s.journal, {
      graphID: 'graph',
      targetID: 'target',
      host: owner.releaseHost(),
      history: owner.releaseHistoryReader(),
      compilation: {
        verify(_request, historical) {
          return compile(historical.snapshot.definition);
        },
      },
    });
    releases.request({
      schema: 'contexture.release-request/v1',
      graph_id: 'graph',
      target_id: 'target',
      revision: '1',
      definition_digest: original.definitionDigest,
      manifest_digest: plan.manifest.manifestDigest,
      expected_desired_epoch: '0',
      idempotency_key: 'release',
      policy: 'exact',
      reason: 'release historical revision',
      approval_ref: 'approved',
    });
    assert.equal(releases.capture()?.snapshot.revision, '1');
    assert.equal(owner.read('graph').revision, '2');
    coordinator = new LocalServingCoordinator({
      graphID: 'graph',
      targetID: 'target',
      instanceID: 'instance',
      authority: releases,
      observation: releases,
      provider: releases.servingProvider({
        async prepare(attempt, signal) {
          return prepareGeneration(
            compile(attempt.release.snapshot.definition),
            {
              graph_id: 'graph',
              revision: '1',
              generation_uuid: attempt.generation_uuid,
            },
            {},
            signal,
          );
        },
      }),
    });
    assert.equal((await coordinator.prepare()).status, 'local_observed');
    const checkpoint = s.journal.checkpoint();
    assert.equal((checkpoint.graphs as JSONObject[])[0]?.head, '2');
    assert.equal(
      ((checkpoint.desired_releases as JSONObject[])[0]?.request as JSONObject).revision,
      '1',
    );
    assert.equal((checkpoint.observations_history as JSONObject[]).length, 1);
    const projection = new GraphJournalProjection(s.journal.records());
    assert.equal(projection.history('graph').at('1').definitionDigest, original.definitionDigest);
    const actual = {
      storeID: owner.storeID,
      watermark: s.journal.watermark,
      records: freezeJSON(s.journal.records()) as readonly JSONObject[],
    };
    const proof = owner.releaseHistoryReader().read('graph', '1', actual);
    assert.equal(proof.journalSeq, '1');
    assert.throws(
      () => owner.releaseHistoryReader().read('graph', '1', { ...actual, storeID: 'wrong' }),
      GraphError,
    );
  } finally {
    await coordinator?.shutdown();
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

test('native catalog and watch cut bridges use exact committed snapshots and current authorization, not injected history', async () => {
  const s = store(),
    owner = s.make(s.journal);
  try {
    boot(s, owner);
    await owner
      .definitionReads()
      .read({ graph_id: 'graph', source: 'revision', revision: '1' }, (view) => {
        assert.equal(view.revision, '1');
        assert.equal(view.store_origin, owner.storeID);
        assert.equal(view.current_index.definition.graph_id, 'graph');
      });
    owner.commit(owner.preview(s.f.transaction(), { expiresAt }));
    let escaped:
      ((after: string, bounds: { max_batches: number; max_bytes: number }) => unknown) | undefined;
    owner.committedReads().read('graph', (cut) => {
      assert.equal(cut.snapshot.revision, '2');
      assert.equal(cut.watermark, s.journal.watermark);
      const window = cut.readBatches('1', { max_batches: 10, max_bytes: 1024 * 1024 });
      assert.equal(window.before.revision, '1');
      assert.equal(window.batches[0]?.state.revision, '2');
      assert.equal(window.through, cut.watermark);
      assert.equal(window.overflow, false);
      escaped = cut.readBatches;
    });
    assert.throws(() => escaped?.('1', { max_batches: 10, max_bytes: 1024 }), {
      code: 'permission_denied',
    });
    s.f.setAllowed(false);
    await assert.rejects(
      owner.definitionReads().read({ graph_id: 'graph', source: 'head' }, () => null),
      GraphError,
    );
    assert.throws(() => owner.committedReads().read('graph', () => null), GraphError);
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

test('processing limits, microsecond expiry and distinct physical origins remain explicit', () => {
  const s = store(),
    owner = s.make(s.journal);
  try {
    s.f.setTime('2026-11-07T04:00:00.000001Z');
    const cap = owner.previewBootstrap(s.f.bootstrap(), {
      expiresAt: '2026-11-07T04:00:00.000002Z',
    });
    owner.commit(cap);
    assert.equal(s.journal.watermark, '1');
    assert.throws(
      () => owner.previewBootstrap(s.f.bootstrap({ schema: 'other' }), { expiresAt }),
      GraphError,
    );
    assert.throws(() => owner.recover({} as FileJournal), GraphError);
    assert.throws(
      () =>
        new FileJournalGraphOwner({} as FileJournal, {
          host: s.f.host,
          serialization: new SynchronousJournalSerialization(),
          clock: s.f.clock,
        }),
      GraphError,
    );
    const other = store();
    try {
      assert.throws(() => owner.recover(other.journal), { code: 'contract_mismatch' });
      const bounded = new FileJournalGraphOwner(other.journal, {
        host: other.f.host,
        serialization: new SynchronousJournalSerialization(),
        clock: other.f.clock,
        limits: { ...DEFAULT_LIMITS, max_nodes: 1 },
      });
      try {
        assert.throws(() => bounded.previewBootstrap(other.f.bootstrap(), { expiresAt }), {
          code: 'limit_exceeded',
        });
        assert.equal(other.journal.watermark, '0');
      } finally {
        bounded.close();
      }
    } finally {
      other.journal.close();
      other.cleanup();
    }
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

test('a current allowed decision with incomplete mutation reference scope still refuses commit', () => {
  const s = store();
  let incomplete = false;
  const owner = new FileJournalGraphOwner(s.journal, {
    host: {
      ...s.f.host,
      decide(admission) {
        const decision = s.f.host.decide(admission);
        return !incomplete || admission.operation !== 'graph.transition'
          ? decision
          : { ...decision, scope_ids: decision.scope_ids.filter((id) => id !== 'tool') };
      },
    },
    serialization: new SynchronousJournalSerialization(),
    clock: s.f.clock,
  });
  try {
    boot(s, owner);
    const cap = owner.preview(
      s.f.transaction({
        commands: [
          {
            op: 'update_node',
            node_id: 'root',
            set_fields: {
              instruction_template: { parts: [{ kind: 'NodeRef', target_id: 'tool' }] },
            },
            unset_fields: ['instructions'],
          },
        ],
      }),
      { expiresAt },
    );
    incomplete = true;
    assert.throws(() => owner.commit(cap), { code: 'permission_denied' });
    assert.equal(s.journal.watermark, '1');
    assert.equal(owner.read('graph').definition.nodes.root?.description, 'original');
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});

test('recovery evidence participates in blob closure, opaque author extension data does not', () => {
  const s = store(),
    owner = s.make(s.journal);
  try {
    const opaque = GraphDefinition.fromJSON({
      ...(s.f.definition.asJSON() as JSONObject),
      extensions: {
        'test:opaque': {
          blob: {
            digest: `sha256:${'f'.repeat(64)}`,
            size: '7',
            media_type: 'application/json',
          },
        },
      },
    });
    owner.commit(
      owner.previewBootstrap(s.f.bootstrap({ seed: { inline: opaque.asJSON() } }), { expiresAt }),
    );
    const evidence = s.journal.putBlob(
      canonicalJSON({ native: 'recovery evidence' }),
      'application/json',
    );
    s.journal.append(
      [
        {
          type: 'RecoveryActionRecorded',
          action_id: 'recovery',
          action: 'native evidence',
          evidence,
        },
      ],
      { actor_ref: 'tenant-actor' },
    );
    const checkpoint = s.journal.checkpoint();
    assert.deepEqual(checkpoint.blob_refs, [evidence]);
    assert.equal(owner.read('graph').revision, '1');
    assert.equal(
      canonicalDigest(owner.read('graph').definition.asJSON(), 'contexture.graph/v1'),
      opaque.definitionDigest,
    );
  } finally {
    owner.close();
    s.journal.close();
    s.cleanup();
  }
});
