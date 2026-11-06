import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphError } from '../src/core/graph/canonical.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import { protectChange } from '../src/core/graph/policy.js';
import { PureRevisionState, prepare } from '../src/core/graph/transactions.js';

type Raw = Record<string, unknown>;
function node(id: string, fields: Raw = {}): Raw {
  return {
    node_id: id,
    kind: 'role',
    name: id,
    description: 'description',
    instructions: '',
    ...fields,
  };
}
function graph(nodes: Raw[], fields: Raw = {}): GraphDefinition {
  return GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'g',
    application_name: 'app',
    mode: 'disclosure_only',
    nodes,
    roots: [{ node_id: 'r', plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
    ...fields,
  });
}
function run(base: GraphDefinition, commands: unknown[]) {
  return prepare(new PureRevisionState(base, '1'), {
    schema: 'contexture.transaction/v1',
    graph_id: 'g',
    base_revision: '1',
    idempotency_key: 'key',
    correlation_id: 'correlation',
    reason: 'edit',
    commands,
  });
}
const rename = (node_id: string, new_name: string) => ({ op: 'rename_node', node_id, new_name });
function protectedChange(callback: () => unknown): void {
  assert.throws(
    callback,
    (e: unknown) => e instanceof GraphError && e.code === 'mutation_protected',
  );
}

test('default root inherit is protected; endpoint noop is legal, not a bypass grant', () => {
  const base = graph([node('r')]);
  protectedChange(() => run(base, [rename('r', 'new')]));
  assert.equal(run(base, [rename('r', 'temporary'), rename('r', 'r')]).noop, true);
});

test('false ancestor barrier overrides explicit true descendants and blocks path changes', () => {
  const base = graph([
    node('r', { mutable: true, members: { children: ['a'] } }),
    node('a', { mutable: false, members: { children: ['b'] } }),
    node('b', { mutable: true }),
  ]);
  protectedChange(() => run(base, [rename('b', 'new')]));
  protectedChange(() => run(base, [rename('r', 'new')]));
  protectedChange(() =>
    run(base, [
      { op: 'move_node', node_id: 'b', target: { parent_id: 'r', slot: 'children', position: 1 } },
    ]),
  );
});

test('ordinary endpoints cannot rewrite kind, role variant or mutable creation policy', () => {
  const before = graph([node('r', { mutable: true })]);
  for (const fields of [{ mutable: false }, { role_variant: 'pre_process' }, { kind: 'skill' }]) {
    const after = graph([node('r', { mutable: true, ...fields })]);
    assert.throws(
      () => protectChange(before, after),
      (e: unknown) => e instanceof GraphError && e.code === 'identity_conflict',
    );
  }
});

test('locked member cannot be crossed; inserted sibling ordinal shift is allowed and not impact', () => {
  const base = graph([
    node('r', { mutable: true, members: { children: ['a', 'b'] } }),
    node('a'),
    node('b', { mutable: false }),
  ]);
  protectedChange(() =>
    run(base, [{ op: 'reorder_members', parent_id: 'r', slot: 'children', node_ids: ['b', 'a'] }]),
  );
  const p = run(base, [
    { op: 'create_node', node: node('c') },
    { op: 'attach_node', node_id: 'c', target: { parent_id: 'r', slot: 'children', position: 0 } },
  ]);
  assert.deepEqual(p.protection.impact, ['c', 'r']);
});

test('creating a false barrier under a mutable parent is legal, children below it are not', () => {
  const base = graph([node('r', { mutable: true })]);
  assert.equal(
    run(base, [
      { op: 'create_node', node: node('a', { mutable: false }) },
      {
        op: 'attach_node',
        node_id: 'a',
        target: { parent_id: 'r', slot: 'children', position: 0 },
      },
    ]).candidate.nodes.a!.mutable,
    false,
  );
  protectedChange(() =>
    run(base, [
      { op: 'create_node', node: node('a', { mutable: false }) },
      { op: 'create_node', node: node('b', { mutable: true }) },
      {
        op: 'attach_node',
        node_id: 'a',
        target: { parent_id: 'r', slot: 'children', position: 0 },
      },
      {
        op: 'attach_node',
        node_id: 'b',
        target: { parent_id: 'a', slot: 'children', position: 0 },
      },
    ]),
  );
});

test('locked uses and NodeRef routing cards protect externally renamed targets', () => {
  for (const reference of [
    { uses: ['a'] },
    {
      instructions: undefined,
      instruction_template: { parts: [{ kind: 'NodeRef', target_id: 'a' }] },
    },
  ]) {
    const locked = node('b', { mutable: false, ...reference });
    if (locked.instructions === undefined) delete locked.instructions;
    const base = graph([
      node('r', { mutable: true, members: { children: ['a', 'b'] } }),
      node('a'),
      locked,
    ]);
    protectedChange(() => run(base, [rename('a', 'renamed')]));
  }
});

test('renaming ancestor includes moved descendant paths and external reference surfaces', () => {
  const base = graph([
    node('r', { mutable: true, members: { children: ['a', 'x'] } }),
    node('a', { members: { children: ['b'] } }),
    node('b'),
    node('x', { uses: ['b'] }),
  ]);
  const p = run(base, [rename('a', 'new')]);
  assert.deepEqual(p.protection.impact, ['a', 'b', 'r', 'x']);
  assert.deepEqual(p.protection.reference_targets, ['b']);
});

test('reorder impact includes both inversion endpoints but not following unchanged siblings', () => {
  const base = graph([
    node('r', { mutable: true, members: { children: ['a', 'b', 'c'] } }),
    node('a'),
    node('b'),
    node('c'),
  ]);
  assert.deepEqual(
    run(base, [
      { op: 'reorder_members', parent_id: 'r', slot: 'children', node_ids: ['b', 'a', 'c'] },
    ]).protection.impact,
    ['a', 'b', 'r'],
  );
});

test('publication and presentation order cannot cross locked targets', () => {
  const nodes = [
    node('r', { mutable: true, members: { children: ['a', 'b'] } }),
    node('a', { mutable: false }),
    node('b'),
  ];
  const publications = ['a', 'b'].map((id) => ({
    kind: 'prompt',
    publication_id: id,
    name: id,
    description: 'prompt',
    opens_id: id,
    model_may_open: true,
  }));
  const before = graph(nodes, { publications });
  protectedChange(() =>
    protectChange(before, graph(nodes, { publications: [...publications].reverse() })),
  );
  const presentations = {
    default_locale: 'en',
    catalogs: [
      {
        locale: 'en',
        entries: [
          { node_id: 'a', title: 'a' },
          { node_id: 'b', title: 'b' },
        ],
      },
    ],
  };
  protectedChange(() =>
    protectChange(
      graph(nodes, { presentations }),
      graph(nodes, {
        presentations: {
          default_locale: 'en',
          catalogs: [{ locale: 'en', entries: [...presentations.catalogs[0]!.entries].reverse() }],
        },
      }),
    ),
  );
});

test('locked deletion and graph metadata surface mutation refuse', () => {
  const before = graph([
    node('r', { mutable: true, members: { children: ['a'] } }),
    node('a', { mutable: false }),
  ]);
  protectedChange(() => protectChange(before, graph([node('r', { mutable: true })])));
  const nodes = [
    node('r', { mutable: true, members: { children: ['a'] } }),
    node('a', { mutable: false }),
  ];
  protectedChange(() => protectChange(before, graph(nodes, { extensions: { 'test:meta': 1 } })));
});
