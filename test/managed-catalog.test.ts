import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogProfile,
  CursorSigner,
  ManagedCatalogService,
  canonicalJSON,
} from '../src/managed.js';
import type { CatalogRequest, CatalogStream, JSONObject, ManagedIdentity } from '../src/managed.js';
import {
  Clock,
  DefinitionFixture,
  failure,
  initialIdentity,
  object,
  objects,
  servingFixture,
  text,
  tree,
} from './managed-read-fixture.js';

const key = () => new CursorSigner(Buffer.alloc(32, 7));
const base: CatalogRequest = { graph_id: 'graph', source: 'head' };
async function read(
  catalog: ManagedCatalogService,
  first: JSONObject,
  stream: CatalogStream = 'nodes',
  request: CatalogRequest = base,
): Promise<JSONObject[]> {
  const result: JSONObject[] = [];
  let cursor = text(object(first.streams)[stream]);
  while (true) {
    const page = await catalog.continuation(cursor, { ...request, stream });
    result.push(...objects(page.items));
    if (page.complete === true) return result;
    cursor = text(page.next_cursor);
  }
}

test('metadata streams page every node/relation in stable order without legacy payload changes', async () => {
  const reader = new DefinitionFixture(tree({ width: 430 }));
  const catalog = new ManagedCatalogService({ signer: key(), definition: reader });
  try {
    const first = await catalog.start(base);
    const nodes = await read(catalog, first);
    assert.equal(nodes.length, 435);
    assert.deepEqual(
      nodes.slice(0, 5).map((n) => n.node_id),
      ['owner', 'pre', 'branch', 'post', 'skill'],
    );
    const edges = await read(catalog, first, 'containment');
    assert.equal(edges.length, 434);
    assert.equal((await read(catalog, first, 'uses')).length, 431);
    const page = await catalog.continuation(text(object(first.streams).nodes), {
      ...base,
      stream: 'nodes',
    });
    assert.equal(objects(page.items).length, 200);
    assert.equal(page.complete, false);
    assert.deepEqual(
      await catalog.continuation(text(object(first.streams).nodes), { ...base, stream: 'nodes' }),
      page,
    );
    const serialized = JSON.stringify([first, nodes, edges]);
    for (const hidden of [
      'SECRET',
      'instructions',
      'input_schema',
      'definition_digest',
      'manifest_digest',
      'ordinal',
      'parent_id',
      'count',
    ])
      assert.equal(serialized.includes(hidden), false, hidden);
    assert.ok(reader.calls > 10, 'every request reenters the trusted read fence');
  } finally {
    catalog.shutdown();
  }
});

test('hidden metadata does not alter projected digest; filters attenuate ALL streams', async () => {
  const reader = new DefinitionFixture();
  reader.scope = ['tool0', 'tool1'];
  const catalog = new ManagedCatalogService({ signer: key(), definition: reader });
  try {
    const first = await catalog.start(base);
    reader.advance(tree({ hidden: 'CHANGED SECRET', program: 'CHANGED HIDDEN PROGRAM' }));
    const next = await catalog.start(base);
    assert.notEqual(first.revision, next.revision);
    assert.equal(first.view_digest, next.view_digest);
    assert.ok((await read(catalog, first)).every((n) => n.projected_root === true));
    assert.deepEqual(await read(catalog, first, 'containment'), []);
    assert.deepEqual(await read(catalog, first, 'uses'), []);
    const filtered = { ...base, profile: new CatalogProfile({ kinds: ['role'] }) };
    const empty = await catalog.start(filtered);
    for (const stream of ['nodes', 'containment', 'uses'] as const)
      assert.deepEqual(await read(catalog, empty, stream, filtered), []);
    const none = { ...base, selection: [] };
    assert.deepEqual(await read(catalog, await catalog.start(none), 'nodes', none), []);
  } finally {
    catalog.shutdown();
  }
});

test('revision snapshot retains bytes across head advance/pruning but intersects CURRENT stable IDs', async () => {
  const reader = new DefinitionFixture();
  const catalog = new ManagedCatalogService({ signer: key(), definition: reader });
  const historic: CatalogRequest = { ...base, source: 'revision', revision: '1' };
  try {
    const first = await catalog.start(historic);
    reader.advance(tree({ label: 'New owner' }));
    reader.history.delete('1');
    assert.equal((await read(catalog, first, 'nodes', historic))[0]!.name, 'Owner');
    await assert.rejects(catalog.start(historic), failure('history_unavailable'));
    reader.advance(tree({ omit: ['tool1'] }));
    await assert.rejects(read(catalog, first, 'nodes', historic), failure('resync_required'));
    assert.equal(catalog.counts.snapshots, 0);
  } finally {
    catalog.shutdown();
  }
});

for (const mode of [
  'actor_id',
  'tenant_id',
  'authority_revision',
  'scope',
  'origin',
  'deny',
  'profile',
  'selection',
  'source',
  'stream',
] as const) {
  test(`Catalog continuation binds ${mode} and clears all streams`, async () => {
    const reader = new DefinitionFixture();
    const catalog = new ManagedCatalogService({ signer: key(), definition: reader });
    const first = await catalog.start(base);
    let request: CatalogRequest & { stream: CatalogStream } = { ...base, stream: 'nodes' };
    if (['actor_id', 'tenant_id', 'authority_revision'].includes(mode))
      reader.context = { ...initialIdentity, [mode]: 'different' } as ManagedIdentity;
    else if (mode === 'scope') reader.scope = [];
    else if (mode === 'origin') reader.origin = 'different';
    else if (mode === 'deny') reader.denied = true;
    else if (mode === 'profile')
      request = { ...request, profile: new CatalogProfile({ limit: 1 }) };
    else if (mode === 'selection') request = { ...request, selection: ['owner'] };
    else if (mode === 'source') request = { ...request, source: 'revision', revision: '1' };
    else if (mode === 'stream') request = { ...request, stream: 'uses' };
    try {
      await assert.rejects(
        catalog.continuation(text(object(first.streams).nodes), request),
        failure('resync_required'),
      );
      assert.deepEqual(catalog.counts, { snapshots: 0, pending: 0, bytes: 0, cursors: 0 });
    } finally {
      catalog.shutdown();
    }
  });
}

test('opaque cursor tampering, cross-service, rotation, expiry and restart require resync', async () => {
  const reader = new DefinitionFixture();
  const signer = key();
  const clock = new Clock();
  const catalog = new ManagedCatalogService({ signer, definition: reader, clock: clock.read });
  const other = new ManagedCatalogService({ signer, definition: reader, clock: clock.read });
  try {
    const first = await catalog.start(base, 5);
    const token = text(object(first.streams).nodes);
    assert.match(token, /^[0-9a-f]{64}\.[0-9a-f]{64}$/u);
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    await assert.rejects(
      catalog.continuation(tampered, { ...base, stream: 'nodes' }),
      failure('resync_required'),
    );
    await assert.rejects(
      other.continuation(token, { ...base, stream: 'nodes' }),
      failure('resync_required'),
    );
    signer.rotate(Buffer.alloc(32, 8));
    await assert.rejects(
      catalog.continuation(token, { ...base, stream: 'nodes' }),
      failure('resync_required'),
    );
    const renewed = await catalog.start(base, 5);
    clock.now = 5;
    assert.equal(catalog.sweep(), 1);
    await assert.rejects(read(catalog, renewed), failure('resync_required'));
    assert.equal(catalog.counts.bytes, 0);
  } finally {
    catalog.shutdown();
    other.shutdown();
  }
});

test('byte-bounded complete pages use UTF8 and reject ANY oversized later node up front', async () => {
  const reader = new DefinitionFixture(tree({ width: 40, description: '界'.repeat(40) }));
  const catalog = new ManagedCatalogService({
    signer: key(),
    definition: reader,
    responseBytes: 1500,
  });
  try {
    const first = await catalog.start(base);
    let token = text(object(first.streams).nodes);
    const ids: string[] = [];
    while (true) {
      const page = await catalog.continuation(token, { ...base, stream: 'nodes' });
      assert.ok(canonicalJSON(page).length <= 1500);
      ids.push(...objects(page.items).map((item) => text(item.node_id)));
      if (page.complete) break;
      token = text(page.next_cursor);
    }
    assert.equal(new Set(ids).size, 45);
    reader.advance(tree({ description: '界'.repeat(1000) }));
    await assert.rejects(
      catalog.start({ ...base, profile: new CatalogProfile({ limit: 1 }) }),
      failure('too_large'),
    );
    assert.equal(catalog.counts.pending, 0);
  } finally {
    catalog.shutdown();
  }
});

test('retained material/items/handles/snapshot budgets fail explicitly and clean up', async () => {
  for (const options of [{ maxItems: 1 }, { maxBytes: 1 }, { maxCursors: 1 }]) {
    const catalog = new ManagedCatalogService({
      signer: key(),
      definition: new DefinitionFixture(),
      ...options,
    });
    await assert.rejects(
      catalog.start(base),
      failure('maxCursors' in options ? 'resource_busy' : 'too_large'),
    );
    assert.deepEqual(catalog.counts, { snapshots: 0, pending: 0, bytes: 0, cursors: 0 });
    catalog.shutdown();
  }
  const catalog = new ManagedCatalogService({
    signer: key(),
    definition: new DefinitionFixture(),
    maxSnapshots: 1,
  });
  try {
    await catalog.start(base);
    await assert.rejects(catalog.start(base), failure('resource_busy'));
  } finally {
    catalog.shutdown();
  }
});

test('serving Catalog pins actual generation and localized ROUTE metadata, but CURRENT auth controls every read', async () => {
  const f = await servingFixture();
  const catalog = new ManagedCatalogService({ signer: key(), serving: f.port });
  const request: CatalogRequest = { ...base, source: 'serving' };
  try {
    const first = await catalog.start(request);
    const old = first.generation_uuid;
    assert.equal((await read(catalog, first, 'nodes', request))[0]!.title, 'Localized');
    await f.swap(tree({ label: 'New owner' }));
    const page = await read(catalog, first, 'nodes', request);
    assert.equal(page[0]!.name, 'Owner');
    assert.notEqual((await catalog.start(request)).generation_uuid, old);
    assert.equal(f.calls.at(-1)!.currentIndex.definition.nodes.owner!.name, 'New owner');
    f.scope(['tool0']);
    await assert.rejects(read(catalog, first, 'nodes', request), failure('resync_required'));
  } finally {
    catalog.shutdown();
    await f.serving.shutdown();
  }
});

test('serving pending starts and expiry/rotation during authority await are fenced', async () => {
  const f = await servingFixture();
  const clock = new Clock();
  const signer = key();
  const catalog = new ManagedCatalogService({
    signer,
    serving: f.port,
    clock: clock.read,
    maxSnapshots: 1,
  });
  let proceed: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.block(async () => {
    entered();
    await blocked;
  });
  try {
    const start = catalog.start({ ...base, source: 'serving' }, 5);
    await ready;
    await assert.rejects(catalog.start(base), failure('resource_busy'));
    clock.now = 5;
    signer.rotate(Buffer.alloc(32, 9));
    proceed();
    await assert.rejects(start, failure('resync_required'));
    assert.deepEqual(catalog.counts, { snapshots: 0, pending: 0, bytes: 0, cursors: 0 });
  } finally {
    proceed();
    catalog.shutdown();
    await f.serving.shutdown();
  }
});

test('unexpected trusted reader failures propagate, never silently fall back', async () => {
  const reader = new DefinitionFixture();
  const catalog = new ManagedCatalogService({ signer: key(), definition: reader });
  try {
    const first = await catalog.start(base);
    const error = new Error('durable reader failed');
    reader.error = error;
    await assert.rejects(read(catalog, first), (actual) => actual === error);
    assert.equal(catalog.counts.snapshots, 0);
  } finally {
    catalog.shutdown();
  }
});

test('serving authority await rechecks actor and invalidates expired retained pages', async () => {
  for (const mode of ['actor', 'expiry'] as const) {
    const f = await servingFixture();
    const clock = new Clock();
    const catalog = new ManagedCatalogService({
      signer: key(),
      serving: f.port,
      clock: clock.read,
    });
    const request: CatalogRequest = { ...base, source: 'serving' };
    let proceed: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let entered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const first = await catalog.start(request, 5);
      f.block(async () => {
        entered();
        await blocked;
      });
      const page = read(catalog, first, 'nodes', request);
      await ready;
      if (mode === 'actor') f.context({ ...initialIdentity, actor_id: 'changed' });
      else {
        clock.now = 5;
        assert.equal(catalog.sweep(), 1);
      }
      proceed();
      await assert.rejects(page, failure('resync_required'));
      assert.equal(catalog.counts.snapshots, 0);
    } finally {
      proceed();
      catalog.shutdown();
      await f.serving.shutdown();
    }
  }
});

test('Catalog validates explicit source/revision, empty filters and maximum page profile', async () => {
  const catalog = new ManagedCatalogService({ signer: key(), definition: new DefinitionFixture() });
  try {
    await assert.rejects(catalog.start({ ...base, revision: '1' }), failure('schema_invalid'));
    await assert.rejects(catalog.start({ ...base, source: 'revision' }), failure('schema_invalid'));
    assert.throws(() => new CatalogProfile({ limit: 1001 }), failure('schema_invalid'));
    assert.throws(() => new CursorSigner(Buffer.alloc(31)), RangeError);
    const request = { ...base, profile: new CatalogProfile({ limit: 1000, kinds: [] }) };
    const first = await catalog.start(request);
    for (const stream of ['nodes', 'containment', 'uses'] as const)
      assert.deepEqual(await read(catalog, first, stream, request), []);
  } finally {
    catalog.shutdown();
  }
});

test('page offsets belong to authorized projection, not hidden global preorder', async () => {
  const reader = new DefinitionFixture();
  reader.scope = ['tool0', 'tool1'];
  const catalog = new ManagedCatalogService({ signer: key(), definition: reader });
  const request = { ...base, profile: new CatalogProfile({ limit: 1 }) };
  try {
    const first = await catalog.start(request);
    const token = text(object(first.streams).nodes);
    const a = await catalog.continuation(token, { ...request, stream: 'nodes' });
    assert.deepEqual(
      objects(a.items).map((n) => n.node_id),
      ['tool0'],
    );
    reader.advance(tree({ prefixHidden: true }));
    const second = await catalog.start(request);
    const b = await catalog.continuation(text(object(second.streams).nodes), {
      ...request,
      stream: 'nodes',
    });
    assert.deepEqual(a.items, b.items);
    assert.equal(first.view_digest, second.view_digest);
    const rest = await catalog.continuation(text(b.next_cursor), { ...request, stream: 'nodes' });
    assert.deepEqual(
      objects(rest.items).map((n) => n.node_id),
      ['tool1'],
    );
    assert.equal(rest.complete, true);
    assert.equal(rest.next_cursor, undefined);
    assert.match(token, /^[0-9a-f]{64}\.[0-9a-f]{64}$/u);
    const decoded = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8');
    assert.equal(decoded.includes('journal_seq'), false);
    for (const forbidden of ['PRIVATE', 'preorder', 'ordinal', 'offset', 'count'])
      assert.equal(JSON.stringify([b, rest]).includes(forbidden), false);
  } finally {
    catalog.shutdown();
  }
});
