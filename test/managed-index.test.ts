import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphError } from '../src/core/graph/canonical.js';
import { GraphDefinition, PublicationContract } from '../src/core/graph/model.js';
import { GraphIndex } from '../src/core/graph/index.js';

type Raw = Record<string, unknown>;
function node(id: string, kind = 'role', fields: Raw = {}): Raw {
  return {
    node_id: id,
    kind,
    name: id,
    description: 'description',
    ...(kind !== 'tool' ? { instructions: '' } : {}),
    ...fields,
  };
}
function graph(nodes = [node('r')], fields: Raw = {}): Raw {
  return {
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'g',
    application_name: 'app',
    mode: 'disclosure_only',
    nodes,
    roots: [{ node_id: nodes[0]?.node_id, plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
    ...fields,
  };
}
function binding(fields: Raw = {}): Raw {
  return {
    kind: 'registered',
    binding_id: 'reader',
    version: '1',
    portability: { kind: 'portable', contract_id: 'c' },
    ...fields,
  };
}
function index(raw: unknown): GraphIndex {
  return GraphIndex.build(GraphDefinition.fromJSON(raw));
}
function reject(raw: unknown): void {
  assert.throws(() => index(raw), GraphError);
}
const identities = (nodes: Iterable<{ node_id: string }>): string[] =>
  Array.from(nodes, (node) => node.node_id);

test('all five typed slots, ordered forest planes and compact subtree intervals', () => {
  const raw = graph(
    [
      node('r', 'role', {
        members: {
          pre_process: 'pre',
          children: ['child'],
          post_process: 'post',
          skills: ['skill'],
          tools: ['tool'],
        },
      }),
      node('pre', 'role', { role_variant: 'pre_process' }),
      node('child', 'role', { role_variant: 'post_process' }),
      node('post', 'role', { role_variant: 'post_process' }),
      node('skill', 'skill'),
      node('tool', 'tool'),
      node('root-tool', 'tool'),
      node('root-skill', 'skill'),
    ],
    {
      roots: [
        { node_id: 'root-tool', plane: 'prompt' },
        { node_id: 'r', plane: 'model' },
        { node_id: 'root-skill', plane: 'model' },
      ],
    },
  );
  const result = index(raw);
  assert.deepEqual(result.preorder, [
    'root-tool',
    'r',
    'pre',
    'child',
    'post',
    'skill',
    'tool',
    'root-skill',
  ]);
  assert.deepEqual(identities(result.subtree('r')), ['r', 'pre', 'child', 'post', 'skill', 'tool']);
  assert.deepEqual(identities(result.subtree('r', false)), [
    'pre',
    'child',
    'post',
    'skill',
    'tool',
  ]);
  assert.deepEqual(identities(result.walk('prompt')), ['root-tool']);
  assert.deepEqual(result.locations.post, {
    parent_id: 'r',
    slot: 'post_process',
    ordinal: 0,
    member_ordinal: 2,
    root_ordinal: 1,
    plane: 'model',
    depth: 1,
    preorder: 4,
    subtree_end: 5,
    effective_mutable: false,
    false_barrier: false,
  });
  assert.equal(result.get('/r/skill', 'path'), result.get('skill'));
  assert.equal(result.path('post'), '/r/post');
});

for (const [kind, slot] of [
  ['role', 'tools'],
  ['tool', 'skills'],
  ['skill', 'children'],
  ['role', 'pre_process'],
  ['role', 'post_process'],
] as const)
  test(`wrong kind or process variant ${kind}/${slot}`, () => {
    const placement = slot === 'pre_process' || slot === 'post_process' ? 's' : ['s'];
    reject(graph([node('r', 'role', { members: { [slot]: placement } }), node('s', kind)]));
  });

const invalidForests = [
  graph([node('r'), node('r')]),
  graph([node('r'), node('orphan')]),
  graph([node('r', 'role', { members: { children: ['s', 's'] } }), node('s')]),
  graph([
    node('r', 'role', { members: { children: ['s', 't'] } }),
    node('s', 'role', { members: { children: ['u'] } }),
    node('t', 'role', { members: { children: ['u'] } }),
    node('u'),
  ]),
  graph([
    node('r'),
    node('a', 'role', { members: { children: ['b'] } }),
    node('b', 'role', { members: { children: ['a'] } }),
  ]),
  graph([node('r', 'role', { members: { children: ['r'] } })]),
  graph([node('r', 'role', { members: { children: ['s'] } }), node('s')], {
    roots: [
      { node_id: 'r', plane: 'model' },
      { node_id: 's', plane: 'prompt' },
    ],
  }),
  graph([
    node('r', 'role', { members: { children: ['s'], skills: ['t'] } }),
    node('s', 'role', { name: 'same' }),
    node('t', 'skill', { name: 'same' }),
  ]),
  graph([node('r'), node('t', 'tool', { name: 'r' })], {
    roots: [
      { node_id: 'r', plane: 'model' },
      { node_id: 't', plane: 'prompt' },
    ],
  }),
];
invalidForests.forEach((raw, i) =>
  test(`forest rejects alias/detachment/cycle/name collision ${i}`, () => reject(raw)),
);

test('uses cycles valid, self uses invalid, templates count repeats in source preorder', () => {
  const root = node('r', 'role', { uses: ['a'], members: { children: ['b', 'a'] } });
  delete root.instructions;
  root.instruction_template = {
    parts: [
      { kind: 'Text', text: 'open ' },
      { kind: 'NodeRef', target_id: 'a', label: '' },
      { kind: 'NodeRef', target_id: 'a' },
      { kind: 'NodeRef', target_id: 'r' },
    ],
  };
  const nodes = [root, node('a', 'role', { uses: ['r'] }), node('b', 'role', { uses: ['r'] })];
  const first = index(graph(nodes));
  const second = index(graph([...nodes].reverse(), { roots: [{ node_id: 'r', plane: 'model' }] }));
  assert.deepEqual(first.reverseUses.r, ['b', 'a']);
  assert.deepEqual(first.reverseUses, second.reverseUses);
  assert.equal(first.definition.digest(), second.definition.digest());
  assert.deepEqual(first.templateRefs.a, [
    { source_id: 'r', part_ordinal: 1 },
    { source_id: 'r', part_ordinal: 2 },
  ]);
  assert.deepEqual(first.templateRefs.r, [{ source_id: 'r', part_ordinal: 3 }]);
  reject(graph([node('r', 'role', { uses: ['r'] })]));
});

for (const [policies, expected] of [
  [
    ['inherit', true, 'inherit'],
    [false, true, true],
  ],
  [
    [true, 'inherit', false, true],
    [true, true, false, false],
  ],
  [
    [false, true, true],
    [false, false, false],
  ],
  [
    ['inherit', 'inherit'],
    [false, false],
  ],
] as const)
  test(`effective static mutability ${JSON.stringify(policies)}`, () => {
    const nodes = policies.map((policy, i) =>
      node(String(i), 'role', {
        mutable: policy,
        members: { children: i + 1 < policies.length ? [String(i + 1)] : [] },
      }),
    );
    const result = index(graph(nodes));
    assert.deepEqual(
      result.preorder.map((id) => result.locations[id]!.effective_mutable),
      expected,
    );
  });

test('explicit opaque slash IDs versus author paths; prototype-safe lookup', () => {
  const result = index(
    graph([
      node('a/b', 'role', { name: 'root', members: { children: ['__proto__'] } }),
      node('__proto__', 'role', { name: 'constructor' }),
    ]),
  );
  assert.equal(result.get('a/b').name, 'root');
  assert.equal(result.get('/root/constructor', 'path').node_id, '__proto__');
  assert.equal(result.path('__proto__'), '/root/constructor');
  for (const [identity, by] of [
    ['/root', 'id'],
    ['a/b', 'path'],
    ['/root/', 'path'],
    ['/', 'path'],
  ] as const)
    assert.throws(() => result.get(identity, by), GraphError);
  assert.throws(() => result.get('constructor'), GraphError);
  assert.throws(() => result.get('a/b', 'ref' as 'id'), GraphError);
});

test('prompt reservations are structural, do not become execution or inherited authority', () => {
  const result = index(
    graph(
      [
        node('r', 'role', { members: { skills: ['child'] } }),
        node('child', 'skill'),
        node('p', 'tool'),
      ],
      {
        roots: [
          { node_id: 'r', plane: 'model' },
          { node_id: 'p', plane: 'prompt' },
        ],
        publications: [
          {
            kind: 'prompt',
            publication_id: 'entry',
            name: 'entry',
            description: 'entry',
            opens_id: 'r',
            model_may_open: false,
          },
        ],
      },
    ),
  );
  assert.equal(result.modelMayOpen('r'), false);
  assert.equal(result.modelMayOpen('child'), true);
  assert.equal(result.modelMayOpen('p'), false);
  assert.throws(() => result.modelMayOpen('missing'), GraphError);
});

const resource = {
  kind: 'resource',
  publication_id: 'p',
  name: 'resource',
  uri: 'app://data',
  mime_type: 'application/json',
  opens_id: 't',
};

test('candidate index diagnostics distinguish missing references and binding evidence', () => {
  const check = (action: () => unknown, code: string, location = ''): void => {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.code, code);
      assert.equal(error.location, location);
      return true;
    });
  };
  check(() => GraphDefinition.fromJSON(graph([], { roots: [] })), 'schema_invalid', '/roots');
  check(
    () => GraphDefinition.fromJSON(graph([node('r', 'role', { uses: ['missing'] })])),
    'reference_not_found',
  );
  const result = index(graph([node('r')]));
  check(() => result.get('missing'), 'reference_not_found');
  check(() => result.get('/missing', 'path'), 'reference_not_found');
  check(
    () => GraphDefinition.fromJSON(published([resource])),
    'binding_contract_required',
    '/publications/0',
  );
  const contracts = { t: new PublicationContract(binding(), 'write', true) };
  check(
    () => GraphDefinition.fromJSON(published([resource]), contracts),
    'schema_invalid',
    '/publications/0',
  );
});
function published(publications: unknown, descriptor = binding()): Raw {
  return graph(
    [
      node('t', 'tool', {
        binding: descriptor,
        input_contract: { type: 'object', maxProperties: 0 },
      }),
    ],
    { mode: 'runtime', publications },
  );
}

test('publication evidence is required again for each pure index build, never inferred from assertion', () => {
  const descriptor = binding();
  const raw = published([resource], descriptor);
  assert.throws(() => GraphDefinition.fromJSON(raw), /Pinned registry contract/u);
  const contracts = { t: new PublicationContract(descriptor, 'read_only', true) };
  const definition = GraphDefinition.fromJSON(raw, contracts);
  assert.throws(() => GraphIndex.build(definition), /Pinned registry contract/u);
  const result = GraphIndex.build(definition, contracts);
  assert.deepEqual(result.publications.t, ['p']);
  assert.equal(JSON.stringify(definition.asJSON()).includes('argument_free'), false);
  for (const [effect, free] of [
    ['write', true],
    ['read_only', false],
  ] as const)
    assert.throws(
      () => GraphDefinition.fromJSON(raw, { t: new PublicationContract(descriptor, effect, free) }),
      GraphError,
    );
  for (const fields of [
    { version: '2' },
    { config: { x: 1 } },
    { secret_refs: ['vault:x'] },
    { expected_contract_digest: `sha256:${'a'.repeat(64)}` },
    { portability: { kind: 'portable', contract_id: 'different' } },
  ])
    assert.throws(
      () =>
        GraphDefinition.fromJSON(raw, {
          t: new PublicationContract(binding(fields), 'read_only', true),
        }),
      GraphError,
    );
  const forged = {
    binding: descriptor,
    effect: 'read_only',
    argument_free: true,
  } as unknown as PublicationContract;
  assert.throws(() => GraphDefinition.fromJSON(raw, { t: forged }), GraphError);
  const prototypeForgery = Object.create(PublicationContract.prototype) as PublicationContract;
  assert.throws(() => GraphDefinition.fromJSON(raw, { t: prototypeForgery }), GraphError);
});

for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
  test(`route pinned effect ${method}`, () => {
    const raw = published([
      { kind: 'route', publication_id: 'p', method, path: '/entry', opens_id: 't' },
    ]);
    const effect = method === 'GET' || method === 'HEAD' ? 'read_only' : 'write';
    GraphDefinition.fromJSON(raw, { t: new PublicationContract(binding(), effect, false) });
    assert.throws(
      () =>
        GraphDefinition.fromJSON(raw, {
          t: new PublicationContract(binding(), effect === 'write' ? 'read_only' : 'write', true),
        }),
      GraphError,
    );
  });

test('publication identities, cross-kind names, URIs and method/path pairs unique', () => {
  const contracts = { t: new PublicationContract(binding(), 'read_only', true) };
  const prompt = {
    kind: 'prompt',
    publication_id: 'p2',
    name: 'resource',
    description: 'entry',
    opens_id: 't',
    model_may_open: true,
  };
  for (const pubs of [
    [resource, { ...resource, name: 'different' }],
    [resource, prompt],
    [resource, { ...resource, publication_id: 'p2', name: 'different' }],
    [
      resource,
      { kind: 'route', publication_id: 'p2', method: 'GET', path: '/', opens_id: 't' },
      { kind: 'route', publication_id: 'p3', method: 'GET', path: '/', opens_id: 't' },
    ],
  ])
    assert.throws(() => GraphDefinition.fromJSON(published(pubs), contracts), GraphError);
  for (const fields of [
    { opens_id: 'missing' },
    { uri: 'relative/path' },
    { uri: 'app://[broken]' },
    { uri: 'app://host name' },
    { uri: 'app://host：port' },
    { extra: true },
  ])
    assert.throws(
      () => GraphDefinition.fromJSON(published([{ ...resource, ...fields }]), contracts),
      GraphError,
    );
  for (const uri of [
    'urn:data:one',
    'app://[::1]:port',
    'app://[::ffff:192.0.2.1]',
    'app://[v1.a]',
    'app:///path',
  ])
    GraphDefinition.fromJSON(published([{ ...resource, uri }]), contracts);
});

test('presentation exact/parent/extension lookup then explicit en default, no field merging', () => {
  const result = index(
    graph([node('r')], {
      presentations: {
        default_locale: 'en',
        catalogs: [
          { locale: 'en', entries: [{ node_id: 'r', title: 'English', description: 'fallback' }] },
          { locale: 'zh-Hant', entries: [{ node_id: 'r', title: '繁體' }] },
          { locale: 'de', entries: [] },
        ],
      },
    }),
  );
  assert.equal(result.presentation('r', 'zh-hant-TW')?.title, '繁體');
  assert.equal(result.presentation('r', 'zh-Hant-TW-u-ca-gregory')?.title, '繁體');
  assert.equal(result.presentation('r', 'zh-Hant')?.description, undefined);
  assert.equal(result.presentation('r', 'de-DE')?.title, 'English');
  assert.equal(result.presentation('r', 'x-private')?.title, 'English');
  assert.deepEqual(result.presentationRefs.r, ['en', 'zh-Hant']);
  assert.equal(index(graph()).presentation('r', 'fr'), undefined);
});

test('reusable forest snapshots detached from inputs, immutable index tables/locations/reverse lists', () => {
  const children = ['c'];
  const raw = graph([
    node('r', 'role', { members: { children } }),
    node('c', 'role', { uses: ['r'] }),
  ]);
  const definition = GraphDefinition.fromJSON(raw);
  const first = GraphIndex.build(definition);
  const second = GraphIndex.build(definition);
  children.push('missing');
  assert.deepEqual(first.preorder, ['r', 'c']);
  assert.deepEqual(second.preorder, first.preorder);
  assert.equal(first.definition, definition);
  assert.notEqual(first.locations, second.locations);
  for (const target of [
    first,
    first.locations,
    first.locations.c!,
    first.preorder,
    first.reverseUses,
    first.reverseUses.r!,
    first.childNames.r!,
    first.rootNames,
  ])
    assert.equal(Reflect.set(target, 'changed', true), false);
  assert.throws(
    () => GraphIndex.build(Object.create(GraphDefinition.prototype) as GraphDefinition),
    GraphError,
  );
});

test('2000-deep forest validates and indexes iteratively without stored full paths', (t) => {
  const depth = 2000;
  const nodes = Array.from({ length: depth + 1 }, (_, i) =>
    node(`n${i}`, 'role', {
      members: { children: i < depth ? [`n${i + 1}`] : [] },
    }),
  );
  const start = performance.now();
  const result = index(graph(nodes));
  const elapsed = performance.now() - start;
  assert.equal(result.locations[`n${depth}`]!.depth, depth);
  assert.equal(result.locations.n0!.subtree_end, depth + 1);
  assert.equal(identities(result.subtree('n1999')).length, 2);
  const path = result.path(`n${depth}`);
  assert.equal(result.get(path, 'path').node_id, `n${depth}`);
  assert.equal(result.preorder.length, depth + 1);
  assert.equal(Object.keys(result.locations).length, depth + 1);
  assert.equal(
    Object.values(result.locations).some((loc) =>
      Object.keys(loc).some((key) => /path|ancestors/u.test(key)),
    ),
    false,
  );
  assert.equal(
    GraphDefinition.fromJSON(result.definition.asJSON()).digest(),
    result.definition.digest(),
  );
  t.diagnostic(
    `depth=${depth}; nodes=${nodes.length}; build_ms=${elapsed.toFixed(2)}; path_bytes=${Buffer.byteLength(path)}; locations=${Object.keys(result.locations).length}`,
  );
});
