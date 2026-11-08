import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CursorSigner,
  ManagedPagingService,
  PageProfile,
  canonicalJSON,
  formatReference,
} from '../src/managed.js';
import type { JSONObject, PageRelation, PagingRequest } from '../src/managed.js';
import { sliceItems } from '../src/core/graph/paging.js';
import {
  Clock,
  failure,
  object,
  objects,
  servingFixture,
  text,
  tree,
} from './managed-read-fixture.js';

const key = () => new CursorSigner(Buffer.alloc(32, 7));
const names = (page: JSONObject, relation: PageRelation): readonly string[] =>
  objects(object(page[relation + '_page']).items).map((card) => text(card.name));
const next = (page: JSONObject, relation: PageRelation): string =>
  text(object(page[relation + '_page']).next_cursor);

test('pure byte slices preserve complete UTF8 items and explicitly reject oversized items', () => {
  assert.deepEqual(sliceItems(['"界"', '"next"'], 0, 200, 7), { items: ['"界"'], nextOffset: 1 });
  assert.deepEqual(sliceItems([], 0, 200, 2), { items: [], nextOffset: null });
  assert.throws(() => sliceItems(['"界"'], 0, 1, 6), failure('too_large'));
  for (const limit of [0, 1001, 1.1])
    assert.throws(() => sliceItems([], 0, limit, 2), failure('schema_invalid'));
});

test('Role open retains owner/process cards on independent, complete, ordered member/uses continuations', async () => {
  const f = await servingFixture();
  const pages = new ManagedPagingService({ signer: key(), serving: f.port });
  const generation = f.serving.current!.generation.context.generation_uuid;
  const request: PagingRequest = {
    operation: 'open',
    reference: formatReference('graph', generation, 'owner'),
    profile: new PageProfile({ limit: 1 }),
  };
  try {
    const first = await pages.start(request);
    assert.equal(first.generation_uuid, generation);
    assert.deepEqual(names(first, 'members'), ['Before']);
    assert.deepEqual(names(first, 'uses'), ['tool0']);
    const active = object(first.owner_active);
    assert.equal(active.instructions, 'ORIGINAL PROGRAM');
    const processes = objects(first.process_cards);
    assert.deepEqual(
      processes.map((p) => p.designation),
      ['pre_process', 'post_process'],
    );
    assert.equal(active.pre_process, object(processes[0]!.card).ref);
    assert.equal(active.post_process, object(processes[1]!.card).ref);
    const members = [...names(first, 'members')];
    let page = first;
    while (!object(page.members_page).complete) {
      page = await pages.continuation(next(page, 'members'), { ...request, relation: 'members' });
      assert.deepEqual(page.owner_active, active);
      assert.deepEqual(page.process_cards, processes);
      assert.equal(page.uses_page, undefined);
      members.push(...names(page, 'members'));
    }
    assert.deepEqual(members, ['Before', 'Branch', 'After', 'Skill', 'tool0', 'tool1', 'tool2']);
    const uses = await pages.continuation(next(first, 'uses'), { ...request, relation: 'uses' });
    assert.deepEqual(names(uses, 'uses'), ['tool1']);
    assert.deepEqual(
      await pages.continuation(next(first, 'uses'), { ...request, relation: 'uses' }),
      uses,
    );
    for (const forbidden of ['SECRET', 'input_schema', 'binding_id', 'count'])
      assert.equal(JSON.stringify(first).includes(forbidden), false);
  } finally {
    pages.shutdown();
    await f.serving.shutdown();
  }
});

test('relation filters do not remove required process cards and never expose programs', async () => {
  const f = await servingFixture();
  const pages = new ManagedPagingService({ signer: key(), serving: f.port });
  const reference = formatReference(
    'graph',
    f.serving.current!.generation.context.generation_uuid,
    'owner',
  );
  const profile = new PageProfile({ kinds: ['tool'], limit: 1 });
  try {
    const request: PagingRequest = { operation: 'members', reference, profile };
    const first = await pages.start(request);
    assert.deepEqual(names(first, 'members'), ['tool0']);
    assert.equal(first.owner_active, undefined);
    assert.equal(first.process_cards, undefined);
    const open = await pages.start({ ...request, operation: 'open' });
    assert.equal(objects(open.process_cards).length, 2);
    assert.deepEqual(names(open, 'members'), ['tool0']);
    const token = next(first, 'members');
    await assert.rejects(
      pages.continuation(token, {
        ...request,
        relation: 'members',
        profile: new PageProfile({ limit: 1 }),
      }),
      failure('resync_required'),
    );
  } finally {
    pages.shutdown();
    await f.serving.shutdown();
  }
});

test('missing authorized process card refuses composition, never designation without card', async () => {
  const f = await servingFixture();
  f.scope(['owner', 'post', 'tool0']);
  const pages = new ManagedPagingService({ signer: key(), serving: f.port });
  try {
    await assert.rejects(
      pages.start({
        operation: 'open',
        reference: formatReference(
          'graph',
          f.serving.current!.generation.context.generation_uuid,
          'owner',
        ),
      }),
      failure('permission_denied'),
    );
    assert.equal(pages.counts.snapshots, 0);
  } finally {
    pages.shutdown();
    await f.serving.shutdown();
  }
});

test('serving swap keeps old references/material; current scope revocation drops every continuation', async () => {
  const f = await servingFixture();
  const pages = new ManagedPagingService({ signer: key(), serving: f.port });
  const old = f.serving.current!.generation;
  const request: PagingRequest = {
    operation: 'members',
    reference: formatReference('graph', old.context.generation_uuid, 'owner'),
    profile: new PageProfile({ limit: 1 }),
  };
  try {
    const first = await pages.start(request);
    await f.swap(tree({ label: 'New owner', description: 'New description' }));
    const page = await pages.continuation(next(first, 'members'), {
      ...request,
      relation: 'members',
    });
    assert.equal(page.generation_uuid, old.context.generation_uuid);
    assert.equal(page.revision, '1');
    assert.equal(f.calls.at(-1)!.currentIndex.definition.nodes.owner!.name, 'New owner');
    f.scope(['owner', 'tool0']);
    await assert.rejects(
      pages.continuation(next(first, 'members'), { ...request, relation: 'members' }),
      failure('resync_required'),
    );
    assert.equal(pages.counts.snapshots, 0);
    await old.retire();
  } finally {
    pages.shutdown();
    await f.serving.shutdown();
  }
});

test('complete byte-bound pages and large program/later member fail explicitly without truncation', async () => {
  const f = await servingFixture(tree({ width: 60 }));
  const pages = new ManagedPagingService({ signer: key(), serving: f.port, responseBytes: 1500 });
  let request: PagingRequest = {
    operation: 'members',
    reference: formatReference(
      'graph',
      f.serving.current!.generation.context.generation_uuid,
      'owner',
    ),
  };
  try {
    let page = await pages.start(request);
    const members = [...names(page, 'members')];
    while (!object(page.members_page).complete) {
      assert.ok(canonicalJSON(page).length <= 1500);
      page = await pages.continuation(next(page, 'members'), { ...request, relation: 'members' });
      members.push(...names(page, 'members'));
    }
    assert.equal(new Set(members).size, 64);
    await f.swap(tree({ program: 'P'.repeat(10000) }));
    request = {
      operation: 'open',
      reference: formatReference(
        'graph',
        f.serving.current!.generation.context.generation_uuid,
        'owner',
      ),
    };
    await assert.rejects(pages.start(request), failure('too_large'));
    await f.swap(tree({ description: '界'.repeat(3000) }));
    request = {
      operation: 'members',
      reference: formatReference(
        'graph',
        f.serving.current!.generation.context.generation_uuid,
        'owner',
      ),
      profile: new PageProfile({ limit: 1 }),
    };
    await assert.rejects(pages.start(request), failure('too_large'));
  } finally {
    pages.shutdown();
    await f.serving.shutdown();
  }
});

test('expiry and actor/origin changes revoke model page snapshots', async () => {
  for (const mode of ['expiry', 'actor', 'origin'] as const) {
    const f = await servingFixture();
    const clock = new Clock();
    const pages = new ManagedPagingService({ signer: key(), serving: f.port, clock: clock.read });
    const request: PagingRequest = {
      operation: 'members',
      reference: formatReference(
        'graph',
        f.serving.current!.generation.context.generation_uuid,
        'owner',
      ),
      profile: new PageProfile({ limit: 1 }),
    };
    try {
      const first = await pages.start(request, 5);
      if (mode === 'expiry') clock.now = 5;
      if (mode === 'actor')
        f.context({ actor_id: 'other', tenant_id: 'tenant', authority_revision: 'auth-1' });
      if (mode === 'origin') f.origin('different-incarnation');
      await assert.rejects(
        pages.continuation(next(first, 'members'), { ...request, relation: 'members' }),
        failure('resync_required'),
      );
      assert.equal(pages.counts.snapshots, 0);
    } finally {
      pages.shutdown();
      await f.serving.shutdown();
    }
  }
});

test('unavailable selection cleans retained generation resources, and callers cannot mutate an awaiting request', async () => {
  const f = await servingFixture();
  const pages = new ManagedPagingService({ signer: key(), serving: f.port });
  const old = f.serving.current!.generation;
  let proceed: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await assert.rejects(
      pages.start({ operation: 'routes', selection: ['missing'] }),
      failure('resync_required'),
    );
    assert.equal(pages.counts.pending, 0);
    f.block(async () => {
      entered();
      await blocked;
    });
    const request = {
      operation: 'members' as const,
      reference: formatReference('graph', old.context.generation_uuid, 'owner'),
      profile: new PageProfile({ limit: 1 }),
    };
    const pending = pages.start(request);
    await ready;
    request.reference = formatReference('graph', old.context.generation_uuid, 'hidden');
    proceed();
    assert.deepEqual(names(await pending, 'members'), ['Before']);
    f.block();
    pages.shutdown();
    await f.swap(tree({ label: 'New owner' }));
    await old.retire();
  } finally {
    proceed();
    pages.shutdown();
    await f.serving.shutdown();
  }
});
