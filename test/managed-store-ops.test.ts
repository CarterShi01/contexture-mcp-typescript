/** Native offline candidate evidence. These tests require local Linux Journal storage. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  FileJournalGraphOwner,
  SynchronousJournalSerialization,
  graphJournalProjector,
  StoreOperations,
  NATIVE_JOURNAL_SOFTWARE_SUPPORT,
  trustedStoreOperator,
  checkSoftwareCompatibility,
  storeFailure,
} from '../src/server/managed-graph.js';
import { FileJournalReleaseOwner } from '../src/server/managed-releases.js';
import { FileJournal, JournalError } from '../src/server/managed-journal.js';
import {
  JOURNAL_BACKUP_DOMAIN,
  canonicalJSON,
  canonicalDigest,
  decodeJSON,
} from '../src/core/graph/canonical.js';
import { GraphJournalProjection } from '../src/core/graph/journal-projection.js';
import { StructuralPlan } from '../src/core/graph/compiler.js';
import type { JSONObject } from '../src/core/graph/model.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import { LocalServingCoordinator } from '../src/application/managed-serving.js';
import { prepareGeneration } from '../src/application/managed-generation.js';
import { graphFixture } from './managed-graph-fixtures.js';

const schemaPath =
  process.env.CONTEXTURE_MANAGED_SCHEMA ??
  fileURLToPath(
    new URL('../../contexture-mcp/spec/managed/schemas/managed.schema.json', import.meta.url),
  );
const schema: unknown = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const operator = trustedStoreOperator({
  operator_id: 'local-admin',
  permissions: ['doctor', 'backup', 'restore'],
  software: NATIVE_JOURNAL_SOFTWARE_SUPPORT,
});
const options = { schema, projector: graphJournalProjector() };
const cli =
  process.env.CONTEXTURE_OFFLINE_CLI ??
  fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const cliLoader = process.env.CONTEXTURE_OFFLINE_CLI ? [] : ['--import', 'tsx'];
const expiresAt = '2026-11-07T04:30:00Z';
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'contexture-ts-offline-'));
  fs.chmodSync(base, 0o700);
  const root = path.join(base, 'source');
  const journal = FileJournal.open(root, options);
  const f = graphFixture();
  const owner = new FileJournalGraphOwner(journal, {
    host: f.host,
    clock: f.clock,
    serialization: new SynchronousJournalSerialization(),
  });
  owner.commit(owner.previewBootstrap(f.bootstrap(), { expiresAt }));
  return {
    base,
    root,
    journal,
    owner,
    f,
    operations: new StoreOperations({ schema, operator }),
    close() {
      owner.close();
      journal.close();
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
function hashes(
  root: string,
): Record<string, { digest: string; mtime: number; ino: number; mode: number }> {
  const result: ReturnType<typeof hashes> = {};
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name),
        info = fs.lstatSync(filename);
      if (info.isDirectory()) visit(filename);
      else
        result[path.relative(root, filename)] = {
          digest: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
          mtime: info.mtimeMs,
          ino: info.ino,
          mode: info.mode,
        };
    }
  };
  visit(root);
  return result;
}
function record(root: string, n = 1): string {
  return path.join(
    root,
    'records',
    String(Math.floor((n - 1) / 10000)).padStart(20, '0'),
    String(n).padStart(20, '0') + '.json',
  );
}
function rejects(code: string): (error: unknown) => boolean {
  return (error) => error instanceof JournalError && error.code === code;
}
function rewrite(
  snapshot: Uint8Array,
  change: (value: Record<string, unknown>) => void,
): Uint8Array {
  const value = JSON.parse(Buffer.from(snapshot).toString('utf8')) as Record<string, unknown>;
  change(value);
  const subject = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'backup_digest'),
  );
  return canonicalJSON({
    ...subject,
    backup_digest: canonicalDigest(subject, JOURNAL_BACKUP_DOMAIN),
  });
}
function invoke(s: ReturnType<typeof fixture>, command: readonly string[]) {
  const config = path.join(s.base, 'operator.json');
  fs.writeFileSync(config, JSON.stringify(operator), { mode: 0o600 });
  return spawnSync(
    process.execPath,
    [...cliLoader, cli, 'store', ...command, '--schema', schemaPath, '--operator-config', config],
    {
      cwd: s.base,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}

test('offline doctor is source-read-only, does not create any owner or invoke historical authority', () => {
  const s = fixture();
  try {
    s.journal.checkpoint();
    s.close();
    const before = hashes(s.root),
      calls = s.f.counts(),
      listing = fs.readdirSync(s.base);
    const report = s.operations.doctor(s.root);
    assert.equal(report.code, 'ok');
    assert.equal(report.storage_verified, true);
    assert.equal(report.isolated_restore_verified, false);
    assert.equal(report.write_enabled, false);
    assert.equal(report.serving_ready, false);
    assert.deepEqual(hashes(s.root), before);
    assert.deepEqual(fs.readdirSync(s.base), listing);
    assert.deepEqual(s.f.counts(), calls);
    assert.doesNotMatch(JSON.stringify(report), /local-admin|source|tenant|approved|Root/u);
  } finally {
    s.close();
    s.cleanup();
  }
});

test('actual graph and release owners produce a frozen backup with complete history, receipts and new restore origin', async () => {
  const s = fixture();
  const compile = (definition: GraphDefinition) =>
    StructuralPlan.compile(definition, {
      no_execution_registry_digest: 'sha256:' + 'a'.repeat(64),
      compiler_contract_version: 'candidate-1',
      compiler_build: 'offline-test',
      app_dependency_contract: { dependency_contract_id: 'app', build: '1' },
      environment_compatibility: ['node-24'],
      locale: 'en',
    });
  let coordinator: LocalServingCoordinator | undefined;
  try {
    const historical = s.owner.read('graph', '1'),
      plan = compile(historical.definition);
    s.owner.commit(s.owner.preview(s.f.transaction(), { expiresAt }));
    const releases = new FileJournalReleaseOwner(s.journal, {
      graphID: 'graph',
      targetID: 'target',
      host: s.owner.releaseHost(),
      history: s.owner.releaseHistoryReader(),
      compilation: {
        verify(_request, history) {
          return compile(history.snapshot.definition);
        },
      },
    });
    releases.request({
      schema: 'contexture.release-request/v1',
      graph_id: 'graph',
      target_id: 'target',
      revision: '1',
      definition_digest: historical.definitionDigest,
      manifest_digest: plan.manifest.manifestDigest,
      expected_desired_epoch: '0',
      idempotency_key: 'release',
      policy: 'exact',
      reason: 'offline historical release',
      approval_ref: 'approved',
    });
    coordinator = new LocalServingCoordinator({
      graphID: 'graph',
      targetID: 'target',
      instanceID: 'source-instance',
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
    const originalCheckpoint = s.journal.checkpoint();
    // A staged but unreferenced authoritative blob must not disappear from an offline backup.
    const blob = s.journal.putBlob(Buffer.from('staged evidence'));
    const original = s.journal.records(),
      receipt = s.journal.getReceipt('tenant-actor', 'bootstrap');
    const watermark = s.journal.watermark,
      storeID = String(s.journal.meta.store_id);
    await coordinator.shutdown();
    coordinator = undefined;
    s.close();
    const calls = s.f.counts(),
      before = hashes(s.root);
    const artifact = s.operations.backup(s.root, path.join(s.base, 'verification'), {
      store_id: storeID,
      journal_seq: watermark,
      record_hash: String(original.at(-1)!.record_hash),
    });
    assert.equal(artifact.result.isolated_restore_verified, true);
    assert.equal(artifact.manifest.journal_seq, watermark);
    assert.deepEqual(hashes(s.root), before);
    assert.deepEqual(s.f.counts(), calls);
    const envelope = decodeJSON(artifact.snapshot) as JSONObject;
    assert.deepEqual(envelope.checkpoint, originalCheckpoint);
    assert.deepEqual(envelope.records, original);
    const output = path.join(s.base, 'backup.json');
    s.operations.publishBackup(output, artifact);
    assert.deepEqual(fs.readFileSync(output), Buffer.from(artifact.snapshot));
    assert.throws(() => s.operations.publishBackup(output, artifact), { code: 'EEXIST' });
    const restoredRoot = path.join(s.base, 'restored');
    assert.equal(
      s.operations.restore(restoredRoot, artifact.snapshot, { allowWrite: true }).code,
      'ok',
    );
    const restored = FileJournal.open(restoredRoot, options);
    try {
      assert.notEqual(restored.meta.store_id, storeID);
      assert.notEqual(restored.meta.store_id, artifact.manifest.restored_store_id);
      assert.equal(restored.watermark, watermark);
      assert.deepEqual(restored.getReceipt('tenant-actor', 'bootstrap'), receipt);
      assert.deepEqual(restored.getBlob(blob), Buffer.from('staged evidence'));
      const restoredRecords = restored.records();
      for (const [i, current] of restoredRecords.entries()) {
        assert.deepEqual(current.events, original[i]!.events);
        assert.deepEqual(current.command_receipt, original[i]!.command_receipt);
        assert.equal(current.event_batch_id, original[i]!.event_batch_id);
        assert.notEqual(current.record_hash, original[i]!.record_hash);
      }
      const projection = new GraphJournalProjection(restoredRecords);
      assert.equal(
        projection.history('graph').at('1').definitionDigest,
        historical.definitionDigest,
      );
      assert.equal(projection.history('graph').head.revision, '2');
      assert.equal((restored.projections().observations_history as unknown[]).length, 1);
      assert.equal((restored.projections().desired_releases as unknown[]).length, 1);
      assert.equal(restored.projections().receipts_index instanceof Array, true);
      const provenance = decodeJSON(restored.getBlob(restored.meta.restored_from));
      assert.deepEqual(provenance, envelope);
    } finally {
      restored.close();
    }
    assert.deepEqual(s.f.counts(), calls);
    assert.deepEqual(hashes(s.root), before);
  } finally {
    await coordinator?.shutdown();
    s.close();
    s.cleanup();
  }
});

test('offline operations refuse a running same-process or real subprocess owner without changing the lock inode', () => {
  const s = fixture();
  try {
    const inode = fs.statSync(path.join(s.root, 'writer.lock')).ino,
      before = hashes(s.root);
    assert.equal(s.operations.doctor(s.root).code, 'store_in_use');
    assert.throws(
      () => s.operations.backup(s.root, path.join(s.base, 'verification')),
      rejects('store_in_use'),
    );
    const child = invoke(s, ['doctor', '--root', s.root]);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stdout).code, 'store_in_use');
    assert.deepEqual(hashes(s.root), before);
    s.close();
    assert.equal(s.operations.doctor(s.root).code, 'ok');
    assert.equal(fs.statSync(path.join(s.root, 'writer.lock')).ino, inode);
  } finally {
    s.close();
    s.cleanup();
  }
});

for (const mutation of ['tmp', 'middle', 'tail', 'blob', 'checkpoint', 'unknown'] as const) {
  test(`offline ${mutation} failure is closed, redacted, read-only and never repairs accepted state`, () => {
    const s = fixture();
    try {
      s.owner.commit(s.owner.preview(s.f.transaction(), { expiresAt }));
      const ref = s.journal.putBlob(Buffer.from('evidence'));
      const checkpoint = s.journal.checkpoint();
      s.close();
      let expected = 'corruption';
      if (mutation === 'tmp') {
        fs.writeFileSync(path.join(s.root, 'tmp', 'pending'), 'secret-path', { mode: 0o600 });
        expected = 'recovery_required';
      } else if (mutation === 'middle') fs.unlinkSync(record(s.root));
      else if (mutation === 'tail') fs.writeFileSync(record(s.root, 2), 'invalid-secret-body');
      else if (mutation === 'blob')
        fs.writeFileSync(
          path.join(
            s.root,
            'blobs',
            'sha256',
            String(ref.digest).slice(7, 9),
            String(ref.digest).slice(7) + '.blob',
          ),
          'invalid-secret-body',
        );
      else if (mutation === 'checkpoint') {
        const filename = path.join(
          s.root,
          'checkpoints',
          '00000000000000000002',
          String(checkpoint.checkpoint_digest).slice(7) + '.json',
        );
        const value = { ...checkpoint, last_record_hash: 'sha256:' + 'f'.repeat(64) };
        fs.writeFileSync(filename, canonicalJSON(value));
        expected = 'checkpoint_invalid';
      } else {
        fs.writeFileSync(path.join(s.root, 'unknown-write-version'), 'secret', { mode: 0o600 });
        expected = 'format_unsupported';
      }
      const before = hashes(s.root),
        report = s.operations.doctor(s.root);
      assert.equal(report.code, expected);
      assert.equal(report.storage_verified, false);
      assert.doesNotMatch(JSON.stringify(report), /secret|source|path|tenant/u);
      assert.deepEqual(hashes(s.root), before);
      assert.throws(
        () => s.operations.backup(s.root, path.join(s.base, 'verification')),
        rejects(expected),
      );
      assert.equal(fs.existsSync(path.join(s.base, 'verification')), false);
      assert.deepEqual(hashes(s.root), before);
    } finally {
      s.close();
      s.cleanup();
    }
  });
}

test('missing source metadata/lock/layout never becomes an initialized empty valid store', () => {
  const s = fixture();
  try {
    s.close();
    const missing = path.join(s.base, 'absent');
    assert.equal(s.operations.doctor(missing).code, 'store_missing');
    assert.equal(fs.existsSync(missing), false);
    fs.unlinkSync(path.join(s.root, 'META.json'));
    const before = hashes(s.root);
    assert.equal(s.operations.doctor(s.root).code, 'corruption');
    assert.deepEqual(hashes(s.root), before);
    // A missing existing lock must not be created as an administrative side effect.
    const lock = fs.readFileSync(path.join(s.root, 'writer.lock'));
    fs.renameSync(path.join(s.root, 'writer.lock'), path.join(s.base, 'saved-lock'));
    assert.equal(s.operations.doctor(s.root).code, 'store_missing');
    assert.equal(fs.existsSync(path.join(s.root, 'writer.lock')), false);
    assert.deepEqual(fs.readFileSync(path.join(s.base, 'saved-lock')), lock);
  } finally {
    s.close();
    s.cleanup();
  }
});

test('source symlinks and nonprivate assets are refused without mutation', () => {
  const s = fixture();
  try {
    s.close();
    const alias = path.join(s.base, 'alias');
    fs.symlinkSync(s.root, alias);
    assert.equal(s.operations.doctor(alias).code, 'unsafe_path');
    fs.chmodSync(record(s.root), 0o644);
    const before = hashes(s.root);
    assert.equal(s.operations.doctor(s.root).code, 'unsafe_permissions');
    assert.deepEqual(hashes(s.root), before);
    fs.chmodSync(record(s.root), 0o600);
    const meta = path.join(s.root, 'META.json'),
      saved = path.join(s.base, 'saved-meta');
    fs.renameSync(meta, saved);
    fs.symlinkSync(saved, meta);
    assert.equal(s.operations.doctor(s.root).code, 'unsafe_path');
  } finally {
    s.close();
    s.cleanup();
  }
});

test('native mount and worktree restrictions are never bypassed by offline diagnostics or restore', () => {
  const s = fixture();
  try {
    s.close();
    assert.equal(s.operations.doctor('/proc/self').code, 'durability_unsupported');
    const incompatible = new StoreOperations({ schema, operator, durability: 'process_crash' });
    const sourceBefore = hashes(s.root);
    assert.equal(incompatible.doctor(s.root).code, 'durability_unsupported');
    assert.deepEqual(hashes(s.root), sourceBefore);
    const sourceTree = path.join(s.base, 'worktree');
    fs.mkdirSync(sourceTree, { mode: 0o700 });
    fs.mkdirSync(path.join(sourceTree, '.git'), { mode: 0o700 });
    assert.equal(s.operations.doctor(path.join(sourceTree, 'store')).code, 'unsafe_path');
    const backup = s.operations.backup(s.root, path.join(s.base, 'verification'));
    assert.throws(
      () =>
        s.operations.restore(path.join(sourceTree, 'store'), backup.snapshot, { allowWrite: true }),
      rejects('unsafe_path'),
    );
    if (fileURLToPath(import.meta.url).startsWith('/mnt/')) {
      assert.equal(s.operations.doctor(path.dirname(cli)).code, 'unsafe_path');
      assert.throws(
        () =>
          s.operations.restore(
            path.join(path.dirname(cli), 'offline-store-forbidden'),
            backup.snapshot,
            { allowWrite: true },
          ),
        rejects('unsafe_path'),
      );
    }
  } finally {
    s.close();
    s.cleanup();
  }
});

test('actual failed append retains owner custody and offline capture refuses pending state without quarantine', () => {
  const s = fixture();
  let failed: FileJournal | undefined;
  try {
    const snapshot = s.journal.exportSnapshot();
    s.close();
    const writer = FileJournal.open(s.root, {
      ...options,
      fault(stage) {
        if (stage === 'record.temp_written')
          throw Object.assign(new Error('injected I/O'), { code: 'EIO' });
      },
    });
    failed = writer;
    assert.throws(
      () =>
        writer.append(
          [
            {
              type: 'RecoveryActionRecorded',
              action_id: 'fault',
              action: 'fault',
              evidence: writer.putBlob(Buffer.from('fault evidence')),
            },
          ],
          { actor_ref: 'tenant-actor' },
        ),
      { code: 'EIO' },
    );
    assert.equal(s.operations.doctor(s.root).code, 'store_in_use');
    failed.close();
    failed = undefined;
    const before = hashes(s.root);
    assert.equal(s.operations.doctor(s.root).code, 'recovery_required');
    assert.deepEqual(hashes(s.root), before);
    assert.equal(fs.readdirSync(path.join(s.root, 'quarantine')).length, 0);
    const partial = path.join(s.base, 'early-partial-restore');
    assert.throws(
      () =>
        FileJournal.restoreSnapshot(partial, snapshot, {
          ...options,
          fault(stage) {
            if (stage === 'directory.created')
              throw Object.assign(new Error('interrupted init'), { code: 'EIO' });
          },
        }),
      { code: 'EIO' },
    );
    const partialBefore = hashes(partial);
    assert.throws(() => FileJournal.open(partial, options), rejects('corruption'));
    assert.equal(s.operations.doctor(partial).code, 'corruption');
    assert.deepEqual(hashes(partial), partialBefore);
    assert.equal(fs.existsSync(path.join(partial, 'META.json')), false);
  } finally {
    failed?.close();
    s.close();
    s.cleanup();
  }
});

test('restore rejects corrupt, missing-blob, unsupported software/schema and existing or symlink destinations before creating anything', () => {
  const s = fixture();
  try {
    const ref = s.journal.putBlob(Buffer.from('required-result'));
    s.journal.append(
      [
        {
          type: 'RecoveryActionRecorded',
          action_id: 'action',
          action: 'offline-test',
          evidence: ref,
        },
      ],
      { actor_ref: 'tenant-actor' },
    );
    s.journal.checkpoint();
    s.close();
    const artifact = s.operations.backup(s.root, path.join(s.base, 'verification'));
    const existing = hashes(s.root);
    assert.throws(
      () => s.operations.restore(s.root, artifact.snapshot, { allowWrite: true }),
      rejects('restore_conflict'),
    );
    assert.deepEqual(hashes(s.root), existing);
    const alias = path.join(s.base, 'alias');
    fs.symlinkSync(s.root, alias);
    assert.throws(
      () => s.operations.restore(alias, artifact.snapshot, { allowWrite: true }),
      rejects('restore_conflict'),
    );
    const corrupt = Buffer.from(artifact.snapshot);
    corrupt[corrupt.length - 1] = 0;
    assert.throws(() =>
      s.operations.restore(path.join(s.base, 'corrupt'), corrupt, { allowWrite: true }),
    );
    const missing = rewrite(artifact.snapshot, (value) => {
      value.blobs = {};
    });
    assert.throws(
      () => s.operations.restore(path.join(s.base, 'missing'), missing, { allowWrite: true }),
      rejects('backup_invalid'),
    );
    const unsupported = rewrite(artifact.snapshot, (value) => {
      value.meta = {
        ...(value.meta as Record<string, unknown>),
        schema: 'contexture.file-journal/v2',
      };
    });
    assert.equal(
      checkSoftwareCompatibility(unsupported, NATIVE_JOURNAL_SOFTWARE_SUPPORT).code,
      'format_unsupported',
    );
    assert.throws(
      () =>
        s.operations.restore(path.join(s.base, 'unsupported'), unsupported, { allowWrite: true }),
      rejects('format_unsupported'),
    );
    assert.throws(() => new StoreOperations({ schema: {}, operator }), rejects('schema_invalid'));
    assert.throws(
      () =>
        new StoreOperations({
          schema,
          operator: { ...operator, software: { ...operator.software, writer_build: 'future' } },
        }),
      rejects('format_unsupported'),
    );
    for (const name of ['corrupt', 'missing', 'unsupported'])
      assert.equal(fs.existsSync(path.join(s.base, name)), false);
  } finally {
    s.close();
    s.cleanup();
  }
});

test('exact semantic version, unknown events and checkpoint safe integer/JCS rejection are not rollback-compatible', () => {
  const s = fixture();
  try {
    s.journal.checkpoint();
    s.close();
    const before = hashes(s.root);
    const artifact = s.operations.backup(s.root, path.join(s.base, 'verification'));
    const semantic = rewrite(artifact.snapshot, (value) => {
      const first = (value.records as Record<string, unknown>[])[0]!;
      (first.events as Record<string, unknown>[])[0]!.semantic_version = '2';
    });
    assert.equal(
      checkSoftwareCompatibility(semantic, operator.software).code,
      'semantic_unsupported',
    );
    assert.throws(
      () => s.operations.restore(path.join(s.base, 'bad-semantic'), semantic, { allowWrite: true }),
      rejects('semantic_unsupported'),
    );
    const unknown = rewrite(artifact.snapshot, (value) => {
      const first = (value.records as Record<string, unknown>[])[0]!;
      (first.events as Record<string, unknown>[])[0]!.type = 'NewRequiredEvent';
    });
    assert.equal(checkSoftwareCompatibility(unknown, operator.software).code, 'format_unsupported');
    assert.throws(
      () => s.operations.restore(path.join(s.base, 'bad-event'), unknown, { allowWrite: true }),
      rejects('format_unsupported'),
    );
    const unsafe = rewrite(artifact.snapshot, (value) => {
      value.checkpoint = { ...(value.checkpoint as Record<string, unknown>), last_seq: '01' };
    });
    assert.throws(
      () => s.operations.restore(path.join(s.base, 'bad-counter'), unsafe, { allowWrite: true }),
      rejects('schema_invalid'),
    );
    const noncanonical = Buffer.from(Buffer.from(artifact.snapshot).toString('utf8') + '\n');
    assert.throws(
      () => s.operations.restore(path.join(s.base, 'bad-jcs'), noncanonical, { allowWrite: true }),
      rejects('backup_invalid'),
    );
    // Native JS numbers have already lost lexical provenance; the raw decoder owns this gate.
    const raw = Buffer.from(artifact.snapshot).toString('utf8');
    assert.equal(raw.split('"last_seq":"1"').length, 2);
    for (const lexeme of ['9007199254740992', '9007199254740993', '9007199254740993e0']) {
      const invalidCheckpoint = Buffer.from(raw.replace('"last_seq":"1"', `"last_seq":${lexeme}`));
      assert.throws(() => decodeJSON(invalidCheckpoint), { code: 'schema_invalid' });
      assert.throws(() => FileJournal.verifySnapshot(invalidCheckpoint, options), {
        code: 'schema_invalid',
      });
      assert.throws(
        () =>
          s.operations.restore(path.join(s.base, 'bad-lexical-' + lexeme), invalidCheckpoint, {
            allowWrite: true,
          }),
        { code: 'schema_invalid' },
      );
      assert.equal(fs.existsSync(path.join(s.base, 'bad-lexical-' + lexeme)), false);
    }
    for (const name of ['bad-semantic', 'bad-event', 'bad-counter', 'bad-jcs'])
      assert.equal(fs.existsSync(path.join(s.base, name)), false);
    assert.deepEqual(hashes(s.root), before);
  } finally {
    s.close();
    s.cleanup();
  }
});

test('operator grants, exact independent anchors and admission budgets are explicit and fail closed', () => {
  const s = fixture();
  try {
    const storeID = String(s.journal.meta.store_id);
    s.close();
    const denied = new StoreOperations({
      schema,
      operator: { ...operator, permissions: ['doctor'] },
    });
    assert.throws(
      () => denied.backup(s.root, path.join(s.base, 'denied')),
      rejects('permission_denied'),
    );
    assert.equal(
      s.operations.doctor(s.root, {
        store_id: storeID,
        journal_seq: '2',
        record_hash: 'sha256:' + 'a'.repeat(64),
      }).code,
      'history_unavailable',
    );
    const limited = new StoreOperations({
      schema,
      operator,
      budget: { maxFiles: 1, maxFileBytes: 1, maxBytes: 1, maxSnapshotBytes: 1 },
    });
    assert.equal(limited.doctor(s.root).code, 'limit_exceeded');
    assert.throws(
      () =>
        new StoreOperations({
          schema,
          operator,
          budget: { maxFiles: 0, maxFileBytes: 1, maxBytes: 1, maxSnapshotBytes: 1 },
        }),
      rejects('schema_invalid'),
    );
    assert.throws(
      () => trustedStoreOperator({ operator_id: 'admin', permissions: ['restore'] }),
      rejects('schema_invalid'),
    );
    assert.throws(
      () =>
        s.operations.restore(path.join(s.base, 'unconfirmed'), new Uint8Array(), {
          allowWrite: false,
        }),
      rejects('confirmation_required'),
    );
    assert.equal(fs.existsSync(path.join(s.base, 'unconfirmed')), false);
  } finally {
    s.close();
    s.cleanup();
  }
});

test('official native CLI subprocess performs doctor, verified backup and confirmed isolated restore without application loading', () => {
  const s = fixture();
  try {
    s.journal.checkpoint();
    s.close();
    const before = hashes(s.root);
    const doctor = invoke(s, ['doctor', '--root', s.root]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).storage_verified, true);
    const output = path.join(s.base, 'cli-backup.json');
    const backup = invoke(s, [
      'backup',
      '--root',
      s.root,
      '--verify-root',
      path.join(s.base, 'cli-verification'),
      '--output',
      output,
    ]);
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(JSON.parse(backup.stdout).isolated_restore_verified, true);
    const destination = path.join(s.base, 'cli-restored');
    const noConfirmation = invoke(s, ['restore', '--root', destination, '--input', output]);
    assert.equal(noConfirmation.status, 1);
    assert.equal(JSON.parse(noConfirmation.stdout).code, 'confirmation_required');
    assert.equal(fs.existsSync(destination), false);
    const restore = invoke(s, [
      'restore',
      '--root',
      destination,
      '--input',
      output,
      '--allow-write',
    ]);
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(JSON.parse(restore.stdout).serving_ready, false);
    const clone = FileJournal.open(destination, options);
    try {
      assert.equal(clone.watermark, '1');
      assert.equal(
        new GraphJournalProjection(clone.records()).history('graph').head.definitionDigest,
        s.f.definition.definitionDigest,
      );
    } finally {
      clone.close();
    }
    const refused = invoke(s, ['restore', '--root', s.root, '--input', output, '--allow-write']);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).code, 'restore_conflict');
    assert.deepEqual(hashes(s.root), before);
    const badSyntax = invoke(s, ['doctor', '--root', s.root, '--target', 'secret-authority.js']);
    assert.equal(badSyntax.status, 2);
    assert.doesNotMatch(badSyntax.stderr, /secret-authority/u);
    const noOperator = spawnSync(
      process.execPath,
      [...cliLoader, cli, 'store', 'doctor', '--root', s.root, '--schema', schemaPath],
      { encoding: 'utf8' },
    );
    assert.equal(noOperator.status, 2);
    const help = spawnSync(process.execPath, [...cliLoader, cli, 'store', '--help'], {
      encoding: 'utf8',
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /operator-config/u);
  } finally {
    s.close();
    s.cleanup();
  }
});

test('doctor errors and CLI failures redact stable actual storage categories, never raw exceptions', () => {
  for (const [code, expected] of Object.entries({
    ENOSPC: 'disk_full',
    EROFS: 'read_only',
    EACCES: 'permission_denied',
    EPERM: 'permission_denied',
    EIO: 'storage_error',
  })) {
    const report = storeFailure('doctor', Object.assign(new Error('/secret/token'), { code }));
    assert.equal(report.code, expected);
    assert.doesNotMatch(JSON.stringify(report), /secret|token/u);
    assert.equal(report.write_enabled, false);
  }
});

test('native TS offline backup -> configured Python locked handoff/restore -> TS verified fresh restore', () => {
  const s = fixture();
  try {
    s.close();
    const before = hashes(s.root);
    const artifact = s.operations.backup(s.root, path.join(s.base, 'verification'));
    const input = path.join(s.base, 'ts-backup.json'),
      output = path.join(s.base, 'python-backup.json');
    s.operations.publishBackup(input, artifact);
    const python = process.env.CONTEXTURE_PYTHON;
    const reference = process.env.CONTEXTURE_PYTHON_REFERENCE;
    assert.ok(python, 'Configured native Python is required; do not silently skip handoff');
    assert.ok(reference, 'Configured Python reference is required');
    const script = `
import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from contexture.server.managed_journal import FileJournal
from contexture.core.graph.canonical import decode_json
schema=decode_json(Path(sys.argv[2]).read_bytes())
source,backup,clone,output=map(Path,sys.argv[3:])
snapshot=backup.read_bytes()
with FileJournal.open(source,schema=schema) as owner:
 assert owner.watermark=="1"
 assert owner.export_snapshot()==snapshot
 assert owner.get_receipt("tenant-actor","bootstrap")["status"]=="committed"
 source_id=owner.meta["store_id"]
with FileJournal.restore_snapshot(clone,snapshot,schema=schema) as restored:
 assert restored.watermark=="1"
 assert restored.meta["store_id"]!=source_id
 assert restored.get_receipt("tenant-actor","bootstrap")["journal_seq"]=="1"
 assert restored.records()[0]["events"][0]["type"]=="GraphChangeCommitted"
 output.write_bytes(restored.export_snapshot())
 output.chmod(0o600)
print("NATIVE_TS_PYTHON_OFFLINE_HANDOFF_PASS")
`;
    const result = spawnSync(
      python,
      [
        '-B',
        '-c',
        script,
        reference,
        schemaPath,
        s.root,
        input,
        path.join(s.base, 'python-clone'),
        output,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NATIVE_TS_PYTHON_OFFLINE_HANDOFF_PASS/u);
    assert.equal(
      s.operations.restore(path.join(s.base, 'python-to-ts'), fs.readFileSync(output), {
        allowWrite: true,
      }).code,
      'ok',
    );
    assert.deepEqual(hashes(s.root), before);
  } finally {
    s.close();
    s.cleanup();
  }
});

test('native TS offline backup -> configured Go locked handoff/restore -> TS complete checkpoint restore', () => {
  const s = fixture();
  try {
    s.close();
    const before = hashes(s.root);
    const artifact = s.operations.backup(s.root, path.join(s.base, 'verification'));
    const input = path.join(s.base, 'ts-backup.json'),
      output = path.join(s.base, 'go-backup.json');
    s.operations.publishBackup(input, artifact);
    const reference = process.env.CONTEXTURE_GO_REFERENCE;
    assert.ok(
      reference,
      'Configured native Go reference is required; do not silently skip handoff',
    );
    const harness = fileURLToPath(new URL('./support/offline-handoff.go', import.meta.url));
    const result = spawnSync(
      process.env.CONTEXTURE_GO ?? 'go',
      [
        'run',
        '-mod=readonly',
        harness,
        schemaPath,
        s.root,
        input,
        path.join(s.base, 'go-clone'),
        output,
      ],
      {
        cwd: reference,
        encoding: 'utf8',
        timeout: 120000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NATIVE_TS_GO_OFFLINE_HANDOFF_PASS/u);
    assert.equal(
      s.operations.restore(path.join(s.base, 'go-to-ts'), fs.readFileSync(output), {
        allowWrite: true,
      }).code,
      'ok',
    );
    assert.deepEqual(hashes(s.root), before);
  } finally {
    s.close();
    s.cleanup();
  }
});
