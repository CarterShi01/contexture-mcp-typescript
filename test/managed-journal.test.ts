/** Native Linux candidate evidence, not power-loss or platform certification. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  FileJournal,
  JournalError,
  CommitUnknown,
  LinuxFileOps,
} from '../src/server/managed-journal.js';
import { canonicalDigest, canonicalJSON, decodeJSON } from '../src/core/graph/canonical.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import {
  UnseededState,
  bootstrapEvent,
  applyEvent,
  RevisionState,
} from '../src/core/graph/events.js';

type Wire = Record<string, unknown>;
const reference =
  process.env.CONTEXTURE_PYTHON_REFERENCE ??
  fileURLToPath(new URL('../../contexture-mcp-graph-runtime-20261105/', import.meta.url));
const schemaPath = path.join(reference, 'spec/managed/schemas/managed.schema.json');
const schema: unknown = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const moduleURL = new URL('../src/server/managed-journal.ts', import.meta.url).href;
const digest = canonicalDigest({ operation: 'noop' }, 'contexture.command/v1');
const event = {
  type: 'CommandCompleted',
  graph_id: 'g',
  revision: '1',
  command_digest: digest,
  status: 'noop',
};
const options = { schema, projector, durability: 'strict' as const };
function projector(records: readonly Wire[]): Wire {
  // Independent complete projection for this test's no-op-only stream.
  const receipts = records.flatMap((r) => (r.command_receipt ? [r.command_receipt as Wire] : []));
  receipts.sort(
    (a, b) =>
      String(a.actor_ref).localeCompare(String(b.actor_ref)) ||
      String(a.idempotency_key).localeCompare(String(b.idempotency_key)),
  );
  return {
    graphs: [],
    desired_releases: [],
    release_operations: [],
    prepare_attempt_history: [],
    observations_history: [],
    receipts_index: receipts,
    projection_versions: {},
    blob_refs: [],
  };
}
function receipt(seq = '1', key = 'key', durability = 'strict'): Wire {
  return {
    schema: 'contexture.command-receipt/v1',
    graph_id: 'g',
    actor_ref: 'actor',
    idempotency_key: key,
    request_digest: digest,
    revision: '1',
    journal_seq: seq,
    status: 'noop',
    durability,
    operation_result: { inline: { answer: 'native-result' } },
  };
}
function temporary(): { base: string; root: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'contexture-ts-journal-'));
  fs.chmodSync(base, 0o700);
  return { base, root: path.join(base, 'store') };
}
function rejects(code: string): (e: unknown) => boolean {
  return (e) => e instanceof JournalError && e.code === code;
}
function recordPath(root: string, n = 1): string {
  return path.join(
    root,
    'records',
    String(Math.floor((n - 1) / 10000)).padStart(20, '0'),
    String(n).padStart(20, '0') + '.json',
  );
}
function child(root: string, body: string) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs'; import { FileJournal, LinuxFileOps } from ${JSON.stringify(moduleURL)};
    const schema = JSON.parse(fs.readFileSync(${JSON.stringify(schemaPath)}, 'utf8'));
    const root=${JSON.stringify(root)}, event=${JSON.stringify(event)}, receipt=${JSON.stringify(receipt())};
    ${body}
  `,
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
}

test('native commit, exact receipt, checkpoint, backup and isolated restore', () => {
  const { base, root } = temporary();
  try {
    const journal = FileJournal.open(root, options);
    const record = journal.append([event], { actor_ref: 'actor', command_receipt: receipt() });
    assert.equal(journal.watermark, '1');
    assert.deepEqual(decodeJSON(fs.readFileSync(recordPath(root))), record);
    assert.deepEqual(journal.getReceipt('actor', 'key'), receipt());
    assert.deepEqual(
      journal.append([event], {
        actor_ref: 'actor',
        command_receipt: { ...receipt('2'), operation_result: { inline: 'ignored-retry-result' } },
      }),
      record,
    );
    assert.throws(
      () =>
        journal.append([event], {
          actor_ref: 'actor',
          command_receipt: { ...receipt(), request_digest: 'sha256:' + 'f'.repeat(64) },
        }),
      rejects('idempotency_conflict'),
    );
    const cp = journal.checkpoint();
    assert.deepEqual(journal.readCheckpoint(), cp);
    const backup = journal.exportSnapshot();
    journal.close();
    const reopened = FileJournal.open(root, options);
    assert.deepEqual(reopened.records(), [record]);
    assert.deepEqual(reopened.readCheckpoint(), cp);
    reopened.close();
    const restored = FileJournal.restoreSnapshot(path.join(base, 'clone'), backup, options);
    assert.notEqual(restored.meta.store_id, record.store_id);
    assert.deepEqual(restored.getReceipt('actor', 'key'), receipt());
    assert.deepEqual(restored.records()[0]!.events, record.events);
    assert.notEqual(restored.records()[0]!.record_hash, record.record_hash);
    restored.close();
    const clone = FileJournal.open(path.join(base, 'clone'), options);
    assert.equal(clone.watermark, '1');
    clone.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('native flock excludes another process and same-process independent owner without deleting inode', () => {
  const { base, root } = temporary();
  try {
    const journal = FileJournal.open(root, options);
    const inode = fs.statSync(path.join(root, 'writer.lock')).ino;
    assert.throws(() => FileJournal.open(root, options), rejects('store_in_use'));
    const result = child(
      root,
      `try { FileJournal.open(root,{schema}); process.exit(9); } catch(e) { if(e.code !== 'store_in_use') throw e; }`,
    );
    assert.equal(result.status, 0, result.stderr);
    journal.close();
    const next = FileJournal.open(root, options);
    next.close();
    assert.equal(fs.statSync(path.join(root, 'writer.lock')).ino, inode);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

for (const stage of [
  'temp_written',
  'file_synced',
  'before_rename',
  'renamed',
  'directory_synced',
]) {
  test('real subprocess exit at record.' + stage, () => {
    const { base, root } = temporary();
    try {
      const initial = FileJournal.open(root, options);
      initial.close();
      const result = child(
        root,
        `const j=FileJournal.open(root,{schema,fault(s){if(s===${JSON.stringify('record.' + stage)})process.exit(73)}});j.append([event],{actor_ref:'actor',command_receipt:receipt});`,
      );
      assert.equal(result.status, 73, result.stderr);
      const journal = FileJournal.open(root, options);
      const published = stage === 'renamed' || stage === 'directory_synced';
      assert.equal(journal.watermark, published ? '1' : '0');
      assert.equal(journal.getReceipt('actor', 'key') !== null, published);
      if (!published) assert.ok(journal.recoveryActions.length > 0);
      journal.append([event], { actor_ref: 'actor', command_receipt: receipt() });
      assert.equal(journal.watermark, '1');
      journal.close();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

test('crash between native link and unlink is recovered under lock with evidence', () => {
  const { base, root } = temporary();
  try {
    FileJournal.open(root, options).close();
    const result = child(
      root,
      `class CrashOps extends LinuxFileOps {publish(a,b){if(b.includes('/records/')){fs.linkSync(a,b);process.exit(74)}super.publish(a,b)}}
      const j=FileJournal.open(root,{schema,fileOps:new CrashOps()});j.append([event],{actor_ref:'actor',command_receipt:receipt});`,
    );
    assert.equal(result.status, 74, result.stderr);
    assert.equal(fs.statSync(recordPath(root)).nlink, 2);
    const journal = FileJournal.open(root, options);
    assert.equal(journal.watermark, '1');
    assert.equal(fs.statSync(recordPath(root)).nlink, 1);
    assert.equal(journal.recoveryActions[0]!.action, 'published-temp-link');
    journal.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('uncertain record fences every mutation and preserves old confirmed watermark until reopen', () => {
  const { base, root } = temporary();
  let armed = false;
  try {
    const journal = FileJournal.open(root, {
      ...options,
      fault(stage) {
        if (armed && stage === 'record.renamed') throw new Error('injected sync uncertainty');
      },
    });
    armed = true;
    assert.throws(
      () => journal.append([event], { actor_ref: 'actor', command_receipt: receipt() }),
      CommitUnknown,
    );
    assert.equal(journal.watermark, '0');
    assert.equal(journal.getReceipt('actor', 'key'), null);
    assert.throws(() => journal.putBlob(Buffer.from('x')), CommitUnknown);
    assert.throws(() => journal.checkpoint(), CommitUnknown);
    assert.throws(() => journal.exportSnapshot(), CommitUnknown);
    assert.throws(() => journal.append([event], { actor_ref: 'actor' }), CommitUnknown);
    journal.close();
    const recovered = FileJournal.open(root, options);
    assert.equal(recovered.watermark, '1');
    assert.deepEqual(recovered.getReceipt('actor', 'key'), receipt());
    recovered.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('short writes complete; zero progress does not publish; nooverwrite syscall never replaces', () => {
  const { base, root } = temporary();
  class ShortOps extends LinuxFileOps {
    override write(fd: number, data: Uint8Array): number {
      return super.write(fd, data.subarray(0, 7));
    }
  }
  class ZeroOps extends LinuxFileOps {
    override write(): number {
      return 0;
    }
  }
  try {
    const journal = FileJournal.open(root, { ...options, fileOps: new ShortOps() });
    journal.append([event], { actor_ref: 'actor', command_receipt: receipt() });
    journal.close();
    const zero = FileJournal.open(root, { ...options, fileOps: new ZeroOps() });
    assert.throws(() => zero.append([event], { actor_ref: 'actor' }), rejects('write_failed'));
    assert.equal(zero.watermark, '1');
    zero.close();
    const a = path.join(base, 'a'),
      b = path.join(base, 'b');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    assert.throws(() => new LinuxFileOps().publish(a, b), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(b, 'utf8'), 'B');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('corrupt chain, missing middle, later buckets and invalid tail never seed or skip', () => {
  for (const mode of ['hash', 'middle', 'bucket', 'tail']) {
    const { base, root } = temporary();
    try {
      const journal = FileJournal.open(root, options);
      journal.append([event], { actor_ref: 'actor' });
      journal.append([event], { actor_ref: 'actor' });
      journal.close();
      if (mode === 'hash') {
        const record = JSON.parse(fs.readFileSync(recordPath(root), 'utf8')) as Wire;
        record.actor_ref = 'changed';
        fs.writeFileSync(recordPath(root), canonicalJSON(record));
      } else if (mode === 'middle') fs.unlinkSync(recordPath(root));
      else if (mode === 'bucket') {
        const target = recordPath(root, 10001);
        fs.mkdirSync(path.dirname(target), { mode: 0o700 });
        fs.writeFileSync(target, '{}', { mode: 0o600 });
      } else fs.writeFileSync(recordPath(root, 2), '{');
      assert.throws(() => FileJournal.open(root, options), rejects('corruption'));
      assert.ok(fs.existsSync(path.join(root, 'META.json')));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test('schema/receipt closure, required blobs, opaque inline data, stale hints and checkpoint fallback', () => {
  const { base, root } = temporary();
  try {
    const journal = FileJournal.open(root, options);
    assert.throws(
      () => journal.append([{ ...event, extra: true }], { actor_ref: 'actor' }),
      rejects('schema_invalid'),
    );
    assert.throws(
      () => journal.append([event], { actor_ref: 'actor', command_receipt: receipt('2') }),
      rejects('corruption'),
    );
    const blob = journal.putBlob(canonicalJSON({ native: 'blob' }), 'application/json');
    assert.deepEqual(decodeJSON(journal.getBlob(blob)), { native: 'blob' });
    const r = { ...receipt(), operation_result: { blob } };
    journal.append([event], { actor_ref: 'actor', command_receipt: r });
    assert.throws(() => journal.checkpoint(), rejects('checkpoint_invalid')); // projector omitted blob closure
    journal.close();
    const withClosure = (records: readonly Wire[]) => ({
      ...projector(records),
      blob_refs: [blob],
    });
    const next = FileJournal.open(root, { ...options, projector: withClosure });
    const cp = next.checkpoint();
    next.append([event], { actor_ref: 'actor' });
    const latest = next.checkpoint();
    next.close();
    const latestPath = path.join(
      root,
      'checkpoints',
      '00000000000000000002',
      String(latest.checkpoint_digest).slice(7) + '.json',
    );
    fs.writeFileSync(latestPath, '{broken');
    fs.writeFileSync(path.join(root, 'hints/LATEST.json'), 'not authoritative', { mode: 0o600 });
    const reopened = FileJournal.open(root, { ...options, projector: withClosure });
    assert.equal(reopened.watermark, '2');
    assert.deepEqual(reopened.readCheckpoint(), cp);
    reopened.close();
    fs.unlinkSync(
      path.join(
        root,
        'blobs/sha256',
        String(blob.digest).slice(7, 9),
        String(blob.digest).slice(7) + '.blob',
      ),
    );
    assert.throws(() => FileJournal.open(root, options), rejects('history_unavailable'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('path/privacy, unsupported profile, source-tree and symlink rejection; no weakening durability', () => {
  const { base, root } = temporary();
  try {
    assert.throws(
      () =>
        FileJournal.open(path.join(base, '..', path.basename(base), 'other') + '/../bad', options),
      rejects('unsafe_path'),
    );
    const journal = FileJournal.open(root, options);
    journal.close();
    assert.throws(
      () => FileJournal.open(root, { ...options, durability: 'process_crash' }),
      rejects('durability_unsupported'),
    );
    fs.chmodSync(root, 0o755);
    assert.throws(() => FileJournal.open(root, options), rejects('unsafe_permissions'));
    fs.chmodSync(root, 0o700);
    fs.symlinkSync(root, path.join(base, 'link'));
    assert.throws(() => FileJournal.open(path.join(base, 'link'), options), rejects('unsafe_path'));
    assert.throws(
      () =>
        FileJournal.open(
          fileURLToPath(new URL('../journal-must-not-exist', import.meta.url)),
          options,
        ),
      rejects('unsafe_path'),
    );
    const drvfs = '/mnt/c/Users/kexingshi/AppData/Local/Temp/unsupported-journal-must-not-exist';
    assert.throws(() => FileJournal.open(drvfs, options), rejects('durability_unsupported'));
    assert.equal(fs.existsSync(drvfs), false);
    const p = path.join(base, 'process-crash');
    const processCrash = FileJournal.open(p, { schema, durability: 'process_crash' });
    processCrash.append([event], {
      actor_ref: 'actor',
      command_receipt: receipt('1', 'key', 'process_crash'),
    });
    assert.equal(processCrash.meta.durability, 'process_crash');
    processCrash.close();
    assert.throws(() => FileJournal.open(p, options), rejects('durability_unsupported'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('callback reentry refuses and projector failure fences writes', () => {
  const { base, root } = temporary();
  try {
    const journal = FileJournal.open(root, {
      ...options,
      fault(stage) {
        if (stage === 'record.file_synced')
          assert.throws(
            () => journal.append([event], { actor_ref: 'actor' }),
            rejects('reentrant_operation'),
          );
      },
      projector() {
        throw new Error('broken projection');
      },
    });
    journal.append([event], { actor_ref: 'actor' });
    assert.throws(() => journal.projections(), /broken projection/u);
    assert.throws(() => journal.putBlob(Buffer.from('x')), CommitUnknown);
    journal.close();
    const owner = FileJournal.open(root, options);
    assert.equal(owner.watermark, '1');
    owner.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Python native producer -> TS locked read/append/checkpoint -> Python native recovery and restore', () => {
  const { base, root } = temporary();
  const python =
    process.env.CONTEXTURE_PYTHON ?? '/tmp/contexture-stdio-baseline-20261105/bin/python';
  const script = `
import json,sys
from pathlib import Path
sys.path.insert(0,${JSON.stringify(reference)})
from contexture.server.managed_journal import FileJournal
from contexture.core.graph.canonical import canonical_json
schema=json.loads(Path(${JSON.stringify(schemaPath)}).read_text())
root=Path(${JSON.stringify(root)})
event=json.loads(${JSON.stringify(JSON.stringify(event))})
receipt=json.loads(${JSON.stringify(JSON.stringify(receipt()))})
def project(records):
 return dict(graphs=[],desired_releases=[],release_operations=[],prepare_attempt_history=[],observations_history=[],receipts_index=sorted([r['command_receipt'] for r in records if 'command_receipt' in r],key=lambda r:(r['actor_ref'],r['idempotency_key'])),projection_versions={},blob_refs=[])
if sys.argv[1]=='produce':
 with FileJournal.open(root,schema=schema,projector=project) as j:
  j.append([event],actor_ref='actor',command_receipt=receipt)
  j.checkpoint()
  (root.parent/'python-backup.json').write_bytes(j.export_snapshot())
else:
 with FileJournal.open(root,schema=schema,projector=project) as j:
  assert j.watermark=='2'
  assert j.get_receipt('actor','ts-key')['operation_result']=={'inline':{'answer':'native-result'}}
  assert j.read_checkpoint()['last_seq']=='2'
  assert canonical_json(list(j.records()))==(root.parent/'ts-records.json').read_bytes()
  assert j.export_snapshot()==(root.parent/'ts-backup.json').read_bytes()
 with FileJournal.restore_snapshot(root.parent/'python-clone',(root.parent/'ts-backup.json').read_bytes(),schema=schema,projector=project) as clone:
  assert clone.watermark=='2'
print('NATIVE_HANDOFF_PASS')
`;
  try {
    const produced = spawnSync(python, ['-B', '-c', script, 'produce'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(produced.status, 0, produced.stderr);
    const nativeMeta = fs.readFileSync(path.join(root, 'META.json'));
    const nativeRecord = fs.readFileSync(recordPath(root));
    const journal = FileJournal.open(root, options);
    assert.equal(journal.watermark, '1');
    assert.equal(journal.readCheckpoint()!.last_seq, '1');
    assert.deepEqual(journal.getReceipt('actor', 'key'), receipt());
    assert.deepEqual(
      Buffer.from(journal.exportSnapshot()),
      fs.readFileSync(path.join(base, 'python-backup.json')),
    );
    journal.append([event], { actor_ref: 'actor', command_receipt: receipt('2', 'ts-key') });
    journal.checkpoint();
    fs.writeFileSync(path.join(base, 'ts-records.json'), canonicalJSON(journal.records()));
    fs.writeFileSync(path.join(base, 'ts-backup.json'), journal.exportSnapshot());
    journal.close();
    assert.deepEqual(fs.readFileSync(path.join(root, 'META.json')), nativeMeta);
    assert.deepEqual(fs.readFileSync(recordPath(root)), nativeRecord);
    const verified = spawnSync(python, ['-B', '-c', script, 'verify'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /NATIVE_HANDOFF_PASS/u);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('real pure bootstrap event is journaled and all graph checkpoint state comes from replay', () => {
  const { base, root } = temporary();
  const seed = GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'g',
    application_name: 'journal-native',
    mode: 'disclosure_only',
    nodes: [{ node_id: 'root', kind: 'role', name: 'root', description: 'root', instructions: '' }],
    roots: [{ node_id: 'root', plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
  });
  const acceptedEvent = bootstrapEvent(new UnseededState('g'), seed, {
    commandDigest: digest,
    reason: 'native',
    approvalRef: 'approved',
  });
  const replay = (records: readonly Wire[]): Wire => {
    let state: UnseededState | RevisionState = new UnseededState('g');
    for (const record of records)
      for (const e of record.events as unknown[]) state = applyEvent(state, e, { tombstones: [] });
    assert.ok(state instanceof RevisionState);
    return {
      ...projector(records),
      graphs: [
        {
          definition: state.definition.asJSON(),
          head: state.revision,
          definition_digest: state.definitionDigest,
          tombstones: state.tombstones,
        },
      ],
    };
  };
  try {
    const journal = FileJournal.open(root, { ...options, projector: replay });
    journal.append([acceptedEvent], {
      actor_ref: 'actor',
      command_receipt: { ...receipt(), status: 'committed' },
    });
    const checkpoint = journal.checkpoint();
    assert.equal((checkpoint.graphs as Wire[])[0]!.definition_digest, seed.digest());
    journal.close();
    const recovered = FileJournal.open(root, { ...options, projector: replay });
    assert.deepEqual(recovered.readCheckpoint(), checkpoint);
    recovered.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('native directory fsync failure after publish is unknown, never confirmed', () => {
  const { base, root } = temporary();
  class SyncFailure extends LinuxFileOps {
    armed = false;
    override sync(fd: number): void {
      if (this.armed && fs.fstatSync(fd).isDirectory())
        throw Object.assign(new Error('sync failure'), { code: 'EIO' });
      super.sync(fd);
    }
  }
  const ops = new SyncFailure();
  try {
    const journal = FileJournal.open(root, {
      ...options,
      fileOps: ops,
      fault(s) {
        if (s === 'record.renamed') ops.armed = true;
      },
    });
    assert.throws(
      () => journal.append([event], { actor_ref: 'actor', command_receipt: receipt() }),
      CommitUnknown,
    );
    assert.equal(journal.watermark, '0');
    journal.close();
    const recovered = FileJournal.open(root, options);
    assert.equal(recovered.watermark, '1');
    recovered.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('checkpoint-only required blob corruption is not swallowed as checkpoint fallback', () => {
  const { base, root } = temporary();
  try {
    const journal = FileJournal.open(root, {
      ...options,
      projector(records) {
        return { ...projector(records), blob_refs: [ref] };
      },
    });
    const ref = journal.putBlob(Buffer.from('retained projection evidence'));
    journal.append([event], { actor_ref: 'actor' });
    journal.checkpoint();
    journal.close();
    const target = path.join(
      root,
      'blobs/sha256',
      String(ref.digest).slice(7, 9),
      String(ref.digest).slice(7) + '.blob',
    );
    fs.writeFileSync(target, 'corrupted');
    const owner = FileJournal.open(root, {
      ...options,
      projector(records) {
        return { ...projector(records), blob_refs: [ref] };
      },
    });
    assert.throws(() => owner.readCheckpoint(), rejects('corruption'));
    owner.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('restore validates before I/O, refuses existing destination, and incomplete restore stays isolated', () => {
  const { base, root } = temporary();
  try {
    const journal = FileJournal.open(root, options);
    journal.append([event], { actor_ref: 'actor' });
    const backup = journal.exportSnapshot();
    journal.close();
    const bad = JSON.parse(Buffer.from(backup).toString('utf8')) as Wire;
    bad.records = [];
    const destination = path.join(base, 'bad');
    assert.throws(
      () => FileJournal.restoreSnapshot(destination, canonicalJSON(bad), options),
      rejects('backup_invalid'),
    );
    assert.equal(fs.existsSync(destination), false);
    assert.throws(
      () => FileJournal.restoreSnapshot(root, backup, options),
      rejects('restore_conflict'),
    );
    const partial = path.join(base, 'partial');
    assert.throws(
      () =>
        FileJournal.restoreSnapshot(partial, backup, {
          ...options,
          fault(stage) {
            if (stage === 'record.before_rename') throw new Error('restore-interrupted');
          },
        }),
      /restore-interrupted/u,
    );
    assert.throws(() => FileJournal.open(partial, options), rejects('restore_incomplete'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('schema remote references, invalid META, arbitrary hardlinks and empty projection refuse', () => {
  const { base, root } = temporary();
  try {
    assert.throws(
      () => FileJournal.open(root, { schema: { $ref: 'https://never-fetch.invalid/schema' } }),
      rejects('schema_invalid'),
    );
    assert.equal(fs.existsSync(root), false);
    const journal = FileJournal.open(root, options);
    journal.close();
    const backupMeta = fs.readFileSync(path.join(root, 'META.json'));
    fs.writeFileSync(path.join(root, 'META.json'), '{}');
    assert.throws(() => FileJournal.open(root, options), rejects('schema_invalid'));
    fs.writeFileSync(path.join(root, 'META.json'), backupMeta);
    const outside = path.join(base, 'outside');
    fs.linkSync(path.join(root, 'META.json'), outside);
    assert.throws(() => FileJournal.open(root, options), rejects('unsafe_path'));
    fs.unlinkSync(outside);
    const noProjector = FileJournal.open(root, { schema });
    noProjector.append([event], { actor_ref: 'actor' });
    assert.throws(() => noProjector.checkpoint(), rejects('projection_required'));
    noProjector.close();
    const broken = FileJournal.open(root, { schema, projector: () => ({}) });
    assert.throws(() => broken.projections(), rejects('projection_invalid'));
    assert.throws(() => broken.append([event], { actor_ref: 'actor' }), CommitUnknown);
    broken.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
