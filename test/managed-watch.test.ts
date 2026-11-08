import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CursorSigner,
  GraphError,
  ManagedWatchService,
  WatchProfile,
  canonicalDigest,
  canonicalJSON,
} from '../src/managed.js';
import type { ManagedIdentity, WatchOptions, WatchRequest } from '../src/managed.js';
import {
  Clock,
  CommittedFixture,
  failure,
  initialIdentity,
  object,
  objects,
  text,
  tree,
} from './managed-read-fixture.js';

const base: WatchRequest = { graph_id: 'graph' };
const key = () => new CursorSigner(Buffer.alloc(32, 7));
function fixture(options: Partial<Omit<WatchOptions, 'reader' | 'signer'>> = {}) {
  const reader = new CommittedFixture();
  const signer = key();
  const clock = new Clock();
  const watch = new ManagedWatchService({ reader, signer, clock: clock.read, ...options });
  return { reader, signer, clock, watch };
}
const name = (payload: unknown): string => {
  assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload));
  const obj = payload as ReturnType<typeof object>;
  return text(objects(obj.nodes)[0]!.name);
};

test('snapshot and checkpoint share ONE committed cut, never uncommitted authoring head', () => {
  const f = fixture();
  try {
    const first = f.watch.start(base);
    assert.equal(name(first.snapshot), 'Owner');
    assert.equal(JSON.stringify(first).includes('UNCOMMITTED'), false);
    assert.equal(f.reader.calls, 1);
    f.reader.append(tree({ label: 'Second', description: 'Changed at same atomic commit' }));
    const result = f.watch.poll(text(first.cursor), base);
    assert.equal(objects(result.batches).length, 1);
    assert.equal(name(objects(result.batches)[0]!.payload), 'Second');
    assert.equal(objects(object(objects(result.batches)[0]!.payload).nodes).length, 1);
    assert.equal(
      objects(result.batches)[0]!.facts_digest,
      canonicalDigest(objects(result.batches)[0]!.payload, 'contexture.view/v1'),
    );
    assert.deepEqual(
      f.watch.poll(text(first.cursor), base),
      result,
      'input checkpoint retries are at-least-once, stable batch IDs',
    );
    assert.deepEqual(objects(f.watch.poll(text(result.cursor), base).batches), []);
  } finally {
    f.watch.shutdown();
  }
});

test('multiple complete committed batches stay atomic at entry and byte boundaries with no skips', () => {
  const f = fixture();
  const request = { ...base, profile: new WatchProfile({ maxBatches: 1 }) };
  try {
    const first = f.watch.start(request);
    f.reader.append(tree({ label: 'Second' }));
    f.reader.append(tree({ label: 'Third' }));
    const second = f.watch.poll(text(first.cursor), request);
    assert.deepEqual(
      objects(second.batches).map((b) => name(b.payload)),
      ['Second'],
    );
    const third = f.watch.poll(text(second.cursor), request);
    assert.deepEqual(
      objects(third.batches).map((b) => name(b.payload)),
      ['Third'],
    );
    assert.notEqual(objects(second.batches)[0]!.batch_id, objects(third.batches)[0]!.batch_id);
    assert.deepEqual(objects(f.watch.poll(text(third.cursor), request).batches), []);
    assert.deepEqual(f.reader.lastBounds, { max_batches: 1024, max_bytes: 16 * 1024 * 1024 });
  } finally {
    f.watch.shutdown();
  }
  const bounded = fixture();
  const small = { ...base, profile: new WatchProfile({ maxBytes: 1000, inlineBytes: 1 }) };
  try {
    let cursor = text(bounded.watch.start(small).cursor);
    for (const label of ['Second', 'Third', 'Fourth']) bounded.reader.append(tree({ label }));
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page = bounded.watch.poll(cursor, small);
      assert.ok(canonicalJSON(page).length <= 1000);
      assert.equal(objects(page.batches).length, 1);
      const batch = objects(page.batches)[0]!;
      names.push(name(bounded.watch.fetch(text(batch.authorized_fetch_ref), small)));
      cursor = text(page.cursor);
    }
    assert.deepEqual(names, ['Second', 'Third', 'Fourth']);
  } finally {
    bounded.watch.shutdown();
  }
});

test('hidden and non-metadata updates only advance opaque checkpoint, not counts/digests/global position', () => {
  const f = fixture();
  try {
    const first = f.watch.start(base);
    f.reader.append(tree({ hidden: 'HIDDEN CHANGED', program: 'HIDDEN PROGRAM' }));
    const empty = f.watch.poll(text(first.cursor), base);
    assert.deepEqual(objects(empty.batches), []);
    assert.notEqual(empty.cursor, first.cursor);
    assert.equal(f.watch.start(base).view_digest, first.view_digest);
    const output = JSON.stringify([first, empty]);
    for (const forbidden of [
      'SECRET',
      'HIDDEN',
      'journal_seq',
      'revision',
      'count',
      'remaining',
      'caught_up',
      f.reader.records.at(-1)!.state.definitionDigest,
    ])
      assert.equal(output.includes(forbidden), false, forbidden);
    const selected = { ...base, selection: [] };
    const selectedFirst = f.watch.start(selected);
    f.reader.append(tree({ label: 'Not selected' }));
    assert.deepEqual(objects(f.watch.poll(text(selectedFirst.cursor), selected).batches), []);
  } finally {
    f.watch.shutdown();
  }
});

test('large projected batches use COMPLETE bounded authorized fetch, with projected-only digest/size', () => {
  const f = fixture();
  const request = { ...base, profile: new WatchProfile({ inlineBytes: 1 }) };
  try {
    const first = f.watch.start(request);
    f.reader.append(tree({ label: 'X'.repeat(1000) }));
    const batch = objects(f.watch.poll(text(first.cursor), request).batches)[0]!;
    assert.equal(batch.payload, undefined);
    const ref = text(batch.authorized_fetch_ref);
    const data = f.watch.fetch(ref, request);
    assert.equal(name(data), 'X'.repeat(1000));
    assert.equal(batch.size, canonicalJSON(data).length);
    assert.equal(batch.facts_digest, canonicalDigest(data, 'contexture.view/v1'));
    assert.deepEqual(f.watch.fetch(ref, request), data);
    f.reader.scope = [];
    assert.throws(() => f.watch.fetch(ref, request), failure('resync_required'));
    f.reader.scope = ['owner'];
    assert.throws(() => f.watch.fetch(ref, request), failure('resync_required'));
  } finally {
    f.watch.shutdown();
  }
});

for (const mode of [
  'actor_id',
  'tenant_id',
  'authority_revision',
  'scope',
  'origin',
  'deny',
  'selection',
  'profile',
  'graph_id',
] as const) {
  test(`watch current ${mode} change invalidates checkpoint and cached fetches`, () => {
    const f = fixture();
    const request: WatchRequest = { ...base, profile: new WatchProfile({ inlineBytes: 1 }) };
    try {
      const first = f.watch.start(request);
      f.reader.append(tree({ label: 'Changed' }));
      const batch = objects(f.watch.poll(text(first.cursor), request).batches)[0]!;
      let changed = request;
      if (['actor_id', 'tenant_id', 'authority_revision'].includes(mode))
        f.reader.context = { ...initialIdentity, [mode]: 'different' } as ManagedIdentity;
      else if (mode === 'scope') f.reader.scope = [];
      else if (mode === 'origin') f.reader.origin = 'different';
      else if (mode === 'deny') f.reader.denied = true;
      else if (mode === 'selection') changed = { ...request, selection: [] };
      else if (mode === 'profile')
        changed = { ...request, profile: new WatchProfile({ maxBatches: 1 }) };
      else changed = { ...request, graph_id: 'other' };
      assert.throws(() => f.watch.poll(text(first.cursor), changed), failure('resync_required'));
      assert.throws(
        () => f.watch.fetch(text(batch.authorized_fetch_ref), request),
        failure('resync_required'),
      );
    } finally {
      f.watch.shutdown();
    }
  });
}

test('retention gaps are history_unavailable, not silent skip/resync success', () => {
  const f = fixture();
  const request = { ...base, profile: new WatchProfile({ inlineBytes: 1 }) };
  try {
    const first = f.watch.start(request);
    f.reader.append(tree({ label: 'Second' }));
    const batch = objects(f.watch.poll(text(first.cursor), request).batches)[0]!;
    f.reader.retained = '2';
    assert.throws(
      () => f.watch.fetch(text(batch.authorized_fetch_ref), request),
      failure('history_unavailable'),
    );
    assert.throws(() => f.watch.poll(text(first.cursor), request), failure('resync_required'));
  } finally {
    f.watch.shutdown();
  }
});

test('slow-consumer backlog overflow closes without accumulating an unbounded queue', () => {
  for (const limits of [{ maxBacklogBatches: 1 }, { maxBacklogBytes: 1 }]) {
    const f = fixture(limits);
    try {
      const first = f.watch.start(base);
      f.reader.append(tree({ label: 'Second' }));
      f.reader.append(tree({ label: 'Third' }));
      assert.throws(() => f.watch.poll(text(first.cursor), base), failure('resync_required'));
      assert.throws(() => f.watch.poll(text(first.cursor), base), failure('resync_required'));
      const fresh = f.watch.start(base);
      assert.equal(name(fresh.snapshot), 'Third');
    } finally {
      f.watch.shutdown();
    }
  }
});

test('watch retained handle/material/payload budgets fail explicitly and revoke session', () => {
  for (const options of [{ maxHandles: 1 }, { maxRetainedBytes: 1 }, { maxPayloadBytes: 200 }]) {
    const f = fixture(options);
    const request = { ...base, profile: new WatchProfile({ inlineBytes: 1 }) };
    try {
      const first = f.watch.start(request);
      f.reader.append(tree({ label: 'X'.repeat(1000) }));
      assert.throws(
        () => f.watch.poll(text(first.cursor), request),
        failure('maxPayloadBytes' in options ? 'too_large' : 'resync_required'),
      );
      assert.throws(() => f.watch.poll(text(first.cursor), request), failure('resync_required'));
    } finally {
      f.watch.shutdown();
    }
  }
});

test('opaque checkpoint tampering, cross-service, rotation, expiry and restart require fresh snapshot', () => {
  const f = fixture();
  const other = new ManagedWatchService({
    reader: f.reader,
    signer: f.signer,
    clock: f.clock.read,
  });
  try {
    const first = f.watch.start(base, 5);
    const token = text(first.cursor);
    assert.match(token, /^[0-9a-f]{64}\.[0-9a-f]{64}$/u);
    assert.throws(
      () => f.watch.poll(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), base),
      failure('resync_required'),
    );
    assert.throws(() => other.poll(token, base), failure('resync_required'));
    f.signer.rotate(Buffer.alloc(32, 9));
    assert.throws(() => f.watch.poll(token, base), failure('resync_required'));
    const second = f.watch.start(base, 5);
    f.clock.now = 5;
    assert.equal(f.watch.sweep(), 1);
    assert.throws(() => f.watch.poll(text(second.cursor), base), failure('resync_required'));
  } finally {
    f.watch.shutdown();
    other.shutdown();
  }
});

test('invalid committed batch boundaries and durable reader failures are never masked or guessed', () => {
  const f = fixture();
  try {
    const first = f.watch.start(base);
    f.reader.append(tree({ label: 'Second' }));
    f.reader.corrupt = true;
    assert.throws(() => f.watch.poll(text(first.cursor), base), failure('contract_mismatch'));
    f.reader.corrupt = false;
    const again = f.watch.start(base);
    const error = new Error('Journal corruption');
    f.reader.error = error;
    assert.throws(
      () => f.watch.poll(text(again.cursor), base),
      (actual) => actual === error,
    );
    f.reader.error = new GraphError('history_unavailable', 'Missing blob');
    assert.throws(() => f.watch.start(base), failure('history_unavailable'));
  } finally {
    f.watch.shutdown();
  }
});

test('watch scan/time/session bounds remain finite including filtered-empty batches', () => {
  const f = fixture({ maxSessions: 1 });
  const request = { ...base, profile: new WatchProfile({ maxBatches: 1 }) };
  try {
    const first = f.watch.start(request);
    assert.throws(() => f.watch.start(request), failure('resync_required'));
    f.reader.append(tree({ program: 'not metadata' }));
    f.reader.append(tree({ label: 'Second' }));
    const hidden = f.watch.poll(text(first.cursor), request);
    assert.deepEqual(objects(hidden.batches), []);
    assert.deepEqual(
      objects(f.watch.poll(text(hidden.cursor), request).batches).map((b) => name(b.payload)),
      ['Second'],
    );
    f.watch.shutdown();
    assert.throws(() => f.watch.poll(text(hidden.cursor), request), failure('resync_required'));
  } finally {
    f.watch.shutdown();
  }
});

test('retained checkpoint polling and durable history errors preserve history_unavailable', () => {
  const f = fixture();
  try {
    const first = f.watch.start(base);
    f.reader.append(tree({ label: 'Second' }));
    f.reader.retained = '2';
    assert.throws(() => f.watch.poll(text(first.cursor), base), failure('history_unavailable'));
    const next = f.watch.start(base);
    f.reader.error = new GraphError('history_unavailable', 'Retained history lost');
    assert.throws(() => f.watch.poll(text(next.cursor), base), failure('history_unavailable'));
  } finally {
    f.watch.shutdown();
  }
});

test('cooperative time budget closes watch even when the trusted read port returns late', () => {
  const reader = new CommittedFixture();
  const clock = new Clock();
  let slow = false;
  const watch = new ManagedWatchService({
    signer: key(),
    clock: clock.read,
    reader: {
      read(graphID, dispatch) {
        return reader.read(graphID, (cut) => {
          if (slow) clock.now += 1001;
          return dispatch(cut);
        });
      },
    },
  });
  try {
    const first = watch.start(base);
    slow = true;
    assert.throws(() => watch.poll(text(first.cursor), base), failure('resync_required'));
    assert.throws(() => watch.poll(text(first.cursor), base), failure('resync_required'));
  } finally {
    watch.shutdown();
  }
});

test('watch rejects reentrant reads and never treats native type erasure as authentication', () => {
  const reader = new CommittedFixture();
  let reenter = false;
  const watch = new ManagedWatchService({
    signer: key(),
    reader: {
      read(graphID, dispatch) {
        if (reenter) watch.start(base);
        return reader.read(graphID, dispatch);
      },
    },
  });

  test('full UTF8 envelope overflow uses an honest complete fetch port or explicit too_large', () => {
    const f = fixture();
    const request = { ...base, profile: new WatchProfile({ maxBytes: 800, inlineBytes: 800 }) };
    try {
      const first = f.watch.start(request);
      f.reader.append(tree({ label: '界'.repeat(150) }));
      const result = f.watch.poll(text(first.cursor), request);
      assert.ok(canonicalJSON(result).length <= 800);
      const batch = objects(result.batches)[0]!;
      assert.equal(
        batch.payload,
        undefined,
        'payload alone fits inline, but full descriptor envelope does not',
      );
      const data = f.watch.fetch(text(batch.authorized_fetch_ref), request);
      assert.equal(name(data), '界'.repeat(150));
      assert.equal(batch.size, canonicalJSON(data).length);
    } finally {
      f.watch.shutdown();
    }
    const small = fixture();
    try {
      const first = small.watch.start(base);
      const bytes = canonicalJSON(first).length;
      assert.throws(
        () =>
          small.watch.start({
            ...base,
            profile: new WatchProfile({ maxBytes: bytes - 1, inlineBytes: 1 }),
          }),
        failure('too_large'),
      );
    } finally {
      small.watch.shutdown();
    }
  });
  try {
    const first = watch.start(base);
    reenter = true;
    assert.throws(() => watch.poll(text(first.cursor), base), failure('resource_busy'));
    reenter = false;
    const plain = { ...new WatchProfile() };
    assert.throws(
      () => watch.start({ ...base, profile: plain as WatchProfile }),
      failure('schema_invalid'),
    );
  } finally {
    watch.shutdown();
  }
});
