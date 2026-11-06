import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphError, canonicalDigest } from '../src/core/graph/canonical.js';
import {
  GraphDefinition,
  PublicationContract,
  bindingDescriptor,
  normalizeLocale,
} from '../src/core/graph/model.js';

type Raw = Record<string, unknown>;
function node(id = 'r', kind = 'role', fields: Raw = {}): Raw {
  return {
    node_id: id,
    kind,
    name: id,
    description: 'description',
    ...(kind !== 'tool' ? { instructions: '' } : {}),
    ...fields,
  };
}
function graph(nodes = [node()], fields: Raw = {}): Raw {
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
    portability: { kind: 'portable', contract_id: 'contract' },
    ...fields,
  };
}
function reject(raw: unknown, message?: RegExp): void {
  assert.throws(
    () => GraphDefinition.fromJSON(raw),
    (error: unknown) => {
      assert.ok(error instanceof GraphError);
      if (message) assert.match(error.message, message);
      return true;
    },
  );
}

test('normalized detached wire, code-point node order, raw UTF8 and native digest', () => {
  const raw = graph([node('𐀀'), node('\ue000', 'skill')], {
    roots: [
      { node_id: '𐀀', plane: 'model' },
      { node_id: '\ue000', plane: 'prompt' },
    ],
  });
  const definition = GraphDefinition.fromJSON(raw);
  const output = definition.asJSON();
  assert.ok(output && typeof output === 'object' && !Array.isArray(output));
  assert.ok(Array.isArray(output.nodes));
  assert.deepEqual(
    output.nodes.map((item) => (item as Record<string, unknown>).node_id),
    ['\ue000', '𐀀'],
  );
  assert.deepEqual(output.publications, []);
  assert.deepEqual(output.extensions, {});
  assert.equal(definition.digest(), canonicalDigest(output, 'contexture.graph/v1'));
  assert.equal(
    GraphDefinition.fromJSON(new TextEncoder().encode(JSON.stringify(output))).definitionDigest,
    definition.digest(),
  );
  assert.equal(GraphDefinition.fromJSON(output).digest(), definition.digest());
  assert.equal(Object.hasOwn(definition.nodes['\ue000']!, 'members'), false);
  assert.deepEqual(definition.nodes['𐀀']!.kind === 'role' && definition.nodes['𐀀']!.members, {
    children: [],
    skills: [],
    tools: [],
  });
});

const graphInvalid: readonly (readonly [string, unknown])[] = [
  ['schema', 'future'],
  ['semantic_version', 1],
  ['mode', 'unknown'],
  ['application_name', 'a/b'],
  ['graph_id', '\ud800'],
  ['graph_id', 'é'.repeat(129)],
  ['nodes', []],
  ['roots', []],
  ['roots', [{ node_id: 'r', plane: 'prompt' }]],
  ['publications', null],
  ['presentations', null],
  ['channels', {}],
  ['revision', '1'],
  ['extensions', { bad: 1 }],
  ['extensions', { 'a:x\n': 1 }],
];
for (const [field, value] of graphInvalid)
  test(`strict graph field: ${field} ${JSON.stringify(value)}`, () =>
    reject(graph([node()], { [field]: value })));

const nodeInvalid: readonly Raw[] = [
  { kind: 'future' },
  { name: '' },
  { name: 'a/b' },
  { name: 'a\u0085b' },
  { description: '' },
  { mutable: 'true' },
  { mutable: null },
  { mutable: 1 },
  { uses: ['r'] },
  { uses: ['missing'] },
  { uses: ['x', 'x'] },
  { members: { future: [] } },
  { members: { pre_process: [] } },
  { members: { post_process: null } },
  { members: { children: null } },
  { members: { children: ['missing'] } },
  { binding: binding() },
  { input_contract: {} },
  { instruction_template: { parts: [] } },
  { instructions: null },
  { instructions: '\ud800' },
  { parent: 'x' },
  { extensions: { 'x:y': Infinity } },
];
nodeInvalid.forEach((fields, i) =>
  test(`strict node fields ${i}`, () => reject(graph([node('r', 'role', fields)]))),
);

for (const [kind, fields] of [
  ['skill', { members: {} }],
  ['skill', { role_variant: 'ordinary' }],
  ['tool', { instructions: '' }],
  ['tool', { members: {} }],
  ['tool', { binding: binding() }],
  ['tool', { input_contract: false }],
] as const)
  test(`kind/mode matrix ${kind} ${JSON.stringify(fields)}`, () =>
    reject(graph([node('r', kind, fields)])));

test('strict root entry and required explicit graph fields', () => {
  for (const field of [
    'schema',
    'semantic_version',
    'graph_id',
    'application_name',
    'mode',
    'nodes',
    'roots',
    'presentations',
  ]) {
    const raw = graph();
    delete raw[field];
    reject(raw);
  }
  reject(graph([node()], { roots: [{ node_id: 'r', plane: 'model', extra: 1 }] }));
  reject(graph([node()], { roots: [{ node_id: 'r', plane: 'future' }] }));
  reject(graph([node()], { presentations: { default_locale: 'en' } }));
});

test('all binding descriptor fields preserved, detached, exact digest and native portability', () => {
  const config = { nested: [{ value: null as string | null }] };
  const raw = binding({
    kind: 'remote',
    config,
    secret_refs: ['vault:handle'],
    expected_contract_digest: `sha256:${'a'.repeat(64)}`,
    portability: {
      kind: 'native',
      language: 'typescript',
      version: '22',
      factory: 'module:factory',
    },
  });
  const definition = GraphDefinition.fromJSON(
    graph([node('t', 'tool', { binding: raw, input_contract: false })], { mode: 'runtime' }),
  );
  const tool = definition.nodes.t!;
  assert.equal(tool.kind, 'tool');
  if (tool.kind !== 'tool') throw new Error('test setup');
  assert.equal(tool.binding?.kind, 'remote');
  assert.equal(tool.binding?.expected_contract_digest, `sha256:${'a'.repeat(64)}`);
  assert.equal(tool.input_contract, false);
  const digest = definition.digest();
  config.nested[0]!.value = 'changed';
  assert.equal(definition.digest(), digest);
  assert.equal(Reflect.set(tool.binding!.config, 'x', 1), false);
  assert.equal(GraphDefinition.fromJSON(definition.asJSON()).digest(), digest);
});

for (const fields of [
  { kind: 'future' },
  { config: [] },
  { config: null },
  { secret_refs: ['x', 'x'] },
  { expected_contract_digest: `sha256:${'a'.repeat(64)}\n` },
  { expected_contract_digest: null },
  { handler: 'code' },
  { portability: { kind: 'native', language: 'ruby', version: '1', factory: 'f' } },
  { portability: { kind: 'portable', contract_id: 'c', factory: 'f' } },
])
  test(`invalid binding ${JSON.stringify(fields)}`, () =>
    reject(graph([node('t', 'tool', { binding: binding(fields) })], { mode: 'runtime' })));

test('runtime requires binding; disclosure assertions cannot masquerade as contracts', () => {
  reject(graph([node('t', 'tool')], { mode: 'runtime' }));
  reject(graph([node('r', 'role', { effect: 'read_only' })]));
  assert.throws(() => new PublicationContract(binding(), 'read_only', 1), GraphError);
  assert.throws(() => new PublicationContract(binding(), 'future', true), GraphError);
});

test('bounded input schema assertion syntax is pure and explicit about unsupported keywords', () => {
  const load = (contract: unknown): GraphDefinition =>
    GraphDefinition.fromJSON(
      graph([node('t', 'tool', { binding: binding(), input_contract: contract })], {
        mode: 'runtime',
      }),
    );
  load({
    $ref: 'https://invalid.invalid/no-fetch',
    type: 'object',
    properties: { x: { type: 'string' } },
    required: ['x'],
  });
  for (const bad of [
    { type: 'future' },
    { required: 'x' },
    { properties: { x: 1 } },
    { minItems: -1 },
    { multipleOf: 0 },
    { enum: [1, 1] },
  ])
    assert.throws(() => load(bad), GraphError);
  for (const unsupported of [
    { pattern: '[' },
    { patternProperties: {} },
    { $dynamicRef: '#x' },
    { $vocabulary: {} },
    { futureKeyword: 1 },
  ])
    assert.throws(() => load(unsupported), /Unsupported input_contract profile keyword/u);
});

test('strict template part union, optional labels and unknown target', () => {
  const load = (part: unknown): void => {
    const raw = node();
    delete raw.instructions;
    raw.instruction_template = { parts: [part] };
    GraphDefinition.fromJSON(graph([raw]));
  };
  load({ kind: 'Text', text: '' });
  load({ kind: 'NodeRef', target_id: 'r', label: '' });
  for (const bad of [
    { kind: 'NodeRef', target_id: 'missing' },
    { kind: 'NodeRef', target_id: 'r', label: null },
    { kind: 'Text', text: 1 },
    { kind: 'Text', text: '', extra: 1 },
    { kind: 'Ref' },
  ])
    assert.throws(() => load(bad), GraphError);
});

for (const [raw, expected] of [
  ['EN-us', 'en-US'],
  ['zh-hant-cn', 'zh-Hant-CN'],
  ['es-419', 'es-419'],
  ['en-u-CA-gregory-x-PRIVATE', 'en-u-ca-gregory-x-private'],
  ['x-PRIVATE', 'x-private'],
  ['I-KLINGON', 'i-klingon'],
  ['SGN-be-fr', 'sgn-BE-FR'],
  ['de-CH-1901', 'de-CH-1901'],
  ['en-abc-def-ghi-Latn-US', 'en-abc-def-ghi-Latn-US'],
] as const)
  test(`native locale casing ${raw}`, () => assert.equal(normalizeLocale(raw), expected));

for (const raw of [
  'en_',
  'a',
  'en--US',
  'x',
  'en-a',
  'en-u-ca-u-nu',
  'sl-rozaj-rozaj',
  'éé',
  'en-US\n',
])
  test(`invalid locale ${JSON.stringify(raw)}`, () =>
    assert.throws(() => normalizeLocale(raw), GraphError));

test('presentations reject normalized collisions, repeated targets and unknown fields', () => {
  const catalogs = (value: unknown): Raw =>
    graph([node()], { presentations: { default_locale: 'en', catalogs: value } });
  reject(
    catalogs([
      { locale: 'EN-us', entries: [] },
      { locale: 'en-US', entries: [] },
    ]),
  );
  reject(
    catalogs([
      {
        locale: 'en',
        entries: [
          { node_id: 'r', title: 'a' },
          { node_id: 'r', description: 'b' },
        ],
      },
    ]),
  );
  reject(catalogs([{ locale: 'en', entries: [{ node_id: 'r' }] }]));
  reject(catalogs([{ locale: 'en', entries: [{ node_id: 'missing', title: 'a' }] }]));
  reject(catalogs([{ locale: 'en', entries: [{ node_id: 'r', title: 'a', name: 'alias' }] }]));
});

test('deep immutable definition and detached aliases across definitions and wire exports', () => {
  const metadata = { nested: [{ value: 1 }] };
  const raw = graph([node('r', 'role', { extensions: { 'a:data': metadata } })]);
  const first = GraphDefinition.fromJSON(raw);
  const second = GraphDefinition.fromJSON(raw);
  const digest = first.digest();
  metadata.nested[0]!.value = 9;
  assert.equal(first.digest(), digest);
  assert.equal(second.digest(), digest);
  assert.notEqual(first.nodes.r, second.nodes.r);
  assert.equal(Reflect.set(first, 'mode', 'runtime'), false);
  assert.equal(Reflect.set(first.nodes, 'new', first.nodes.r), false);
  assert.equal(Reflect.set(first.nodes.r!, 'name', 'changed'), false);
  const nested = first.nodes.r!.extensions['a:data'];
  assert.ok(nested && typeof nested === 'object');
  assert.equal(Object.isFrozen(nested), true);
  const output = first.asJSON() as { nodes: { name: string }[] };
  output.nodes[0]!.name = 'changed';
  assert.equal(first.digest(), digest);
  const forged = Object.create(GraphDefinition.prototype) as GraphDefinition;
  assert.equal(GraphDefinition.isValidated(forged), false);
});

test('opaque IDs include slash and prototype names, but scalar/UTF8 budgets remain enforced', () => {
  for (const id of [
    '__proto__',
    'constructor',
    'hasOwnProperty',
    'a/b',
    '\u0000',
    'é'.repeat(128),
  ]) {
    const definition = GraphDefinition.fromJSON(graph([node(id, 'role', { name: 'root' })]));
    assert.equal(definition.nodes[id]!.node_id, id);
  }
  reject(graph([node('', 'role', { name: 'root' })]));
  const cyclic: Raw = graph();
  cyclic.extensions = { 'a:x': cyclic };
  reject(cyclic);
  const accessor = graph();
  Object.defineProperty(accessor, 'graph_id', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  reject(accessor);
});

test('raw number safety delegates native canonical decoder without adding graph counters', () => {
  const source = JSON.stringify(graph([node('r', 'role', { extensions: { 'a:data': 1 } })]));
  reject(new TextEncoder().encode(source.replace('"a:data":1', '"a:data":9007199254740993')));
  reject(new TextEncoder().encode(source.replace('"a:data":1', '"a:data":1e9999')));
  reject(graph([node()], { revision: '9007199254740991' }));
});

test('node decode diagnostics retain the candidate node ordinal and error code', () => {
  for (const [raw, location] of [
    [graph([node('r', 'role', { name: '' })]), '/nodes/0'],
    [graph([node('r'), node('r')]), '/nodes/1/node_id'],
  ] as const) {
    assert.throws(
      () => GraphDefinition.fromJSON(raw),
      (error: unknown) => {
        assert.ok(error instanceof GraphError);
        assert.equal(error.code, 'schema_invalid');
        assert.equal(error.location, location);
        return true;
      },
    );
  }
});

test('normalization defaults and literal Unicode preserve intended digest semantics', () => {
  const first = GraphDefinition.fromJSON(graph());
  const explicit = GraphDefinition.fromJSON(
    graph(
      [
        node('r', 'role', {
          mutable: 'inherit',
          uses: [],
          extensions: {},
          role_variant: 'ordinary',
          members: { children: [], skills: [], tools: [] },
        }),
      ],
      { publications: [], extensions: {} },
    ),
  );
  assert.equal(first.digest(), explicit.digest());
  assert.notEqual(
    GraphDefinition.fromJSON(graph([node('r', 'role', { instructions: 'é' })])).digest(),
    GraphDefinition.fromJSON(graph([node('r', 'role', { instructions: 'e\u0301' })])).digest(),
  );
  assert.deepEqual(bindingDescriptor(binding()).secret_refs, []);
});
