import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GraphError, canonicalJSON } from '../src/core/graph/canonical.js';
import { GraphDefinition, PublicationContract } from '../src/core/graph/model.js';
import {
  DEFAULT_LIMITS,
  PureRevisionState,
  TransactionEnvelope,
  SUPPORTED_COMMANDS,
  UNSUPPORTED_COMMANDS,
  prepare,
  recheckPrepared,
} from '../src/core/graph/transactions.js';

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
function state(fields: Raw = {}, revision = '7', tombstones: unknown = []): PureRevisionState {
  return new PureRevisionState(
    GraphDefinition.fromJSON({
      schema: 'contexture.graph/v1',
      semantic_version: '1',
      graph_id: 'g',
      application_name: 'app',
      mode: 'disclosure_only',
      nodes: [
        node('r', { mutable: true, members: { children: ['a', 'b'] } }),
        node('a'),
        node('b'),
      ],
      roots: [{ node_id: 'r', plane: 'model' }],
      presentations: { default_locale: 'en', catalogs: [] },
      ...fields,
    }),
    revision,
    tombstones,
  );
}
function envelope(commands: unknown[], fields: Raw = {}): Raw {
  return {
    schema: 'contexture.transaction/v1',
    graph_id: 'g',
    base_revision: '7',
    idempotency_key: 'key',
    correlation_id: 'correlation',
    reason: 'edit',
    commands,
    ...fields,
  };
}
const rename = (id: string, name: string) => ({ op: 'rename_node', node_id: id, new_name: name });
const member = (parent = 'r', position = 0, slot = 'children') => ({
  parent_id: parent,
  slot,
  position,
});
function reject(base: PureRevisionState, commands: unknown[], code = 'schema_invalid'): void {
  const before = canonicalJSON(base.definition.asJSON());
  assert.throws(
    () => prepare(base, envelope(commands)),
    (error: unknown) => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.code, code);
      return true;
    },
  );
  assert.deepEqual(canonicalJSON(base.definition.asJSON()), before);
}
function hash(value: unknown, domain: string): string {
  // Independent tiny JCS oracle on these safe ASCII/integer subjects.
  function jcs(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
    return `{${Object.keys(v)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcs((v as Raw)[key])}`)
      .join(',')}}`;
  }
  return `sha256:${createHash('sha256')
    .update(domain + '\0' + jcs(value))
    .digest('hex')}`;
}

test('native rename facts, full impact, independent command/facts/preview hash subjects', () => {
  const base = state();
  const command = rename('a', 'renamed');
  const request = envelope([command]);
  const p = prepare(base, request);
  assert.equal(p.status, 'prepared-pure-candidate');
  assert.equal(p.candidate.nodes.a!.name, 'renamed');
  assert.equal(base.definition.nodes.a!.name, 'a');
  assert.deepEqual(p.facts, [
    {
      type: 'NodeFieldsSet',
      node_id: 'a',
      before: { name: { present: true, value: 'a' } },
      after: { name: { present: true, value: 'renamed' } },
    },
  ]);
  assert.deepEqual(p.protection, {
    impact: ['a', 'r'],
    reference_targets: [],
    roots_changed: false,
  });
  assert.equal(p.resultRevision, '8');
  const commandSubject = {
    schema: request.schema,
    graph_id: 'g',
    base_revision: '7',
    commands: [command],
    reason: 'edit',
  };
  assert.equal(p.envelope.commandDigest, hash(commandSubject, 'contexture.command/v1'));
  assert.equal(p.factsDigest, hash(p.facts, 'contexture.facts/v1'));
  assert.deepEqual(p.approvalSubject, {
    schema: 'contexture.preview/v1',
    graph_id: 'g',
    base_revision: '7',
    base_digest: base.definitionDigest,
    candidate_digest: p.candidate.digest(),
    command_digest: hash(commandSubject, 'contexture.command/v1'),
    resolved_fact_digest: p.factsDigest,
  });
  assert.equal(p.approvalSubjectDigest, hash(p.approvalSubject, 'contexture.preview/v1'));
});

test('all eleven supported command operations execute in one ordered native batch', () => {
  const base = state();
  const p = prepare(
    base,
    envelope([
      { op: 'create_node', node: node('c') },
      { op: 'update_node', node_id: 'c', set_fields: { description: 'new' }, unset_fields: [] },
      rename('c', 'child'),
      { op: 'attach_node', node_id: 'c', target: member('r', 2) },
      { op: 'move_node', node_id: 'c', target: member('r', 0) },
      { op: 'detach_node', node_id: 'c' },
      { op: 'add_root', node_id: 'c', plane: 'prompt', position: 1 },
      { op: 'remove_root', node_id: 'c' },
      { op: 'attach_node', node_id: 'c', target: member('r', 2) },
      { op: 'reorder_members', parent_id: 'r', slot: 'children', node_ids: ['c', 'b', 'a'] },
      { op: 'add_use', source_id: 'c', target_id: 'a' },
      { op: 'remove_use', source_id: 'c', target_id: 'a' },
    ]),
  );
  const r = p.candidate.nodes.r!;
  assert.ok(r.kind === 'role');
  assert.deepEqual(r.members.children, ['c', 'b', 'a']);
  assert.equal(p.candidate.nodes.c!.name, 'child');
  assert.equal(p.candidate.nodes.c!.description, 'new');
  assert.equal(p.facts[0]!.type, 'NodeCreated');
  assert.deepEqual(
    p.facts.map((f) => f.type),
    ['NodeCreated', 'MembersAssigned'],
  );
  assert.equal(p.rootOperations, true);
  assert.equal(p.protection.roots_changed, false);
});

test('same-slot move insertion is checked after removal', () => {
  const p = prepare(state(), envelope([{ op: 'move_node', node_id: 'a', target: member('r', 1) }]));
  const r = p.candidate.nodes.r!;
  assert.ok(r.kind === 'role');
  assert.deepEqual(r.members.children, ['b', 'a']);
  reject(state(), [{ op: 'move_node', node_id: 'a', target: member('r', 2) }]);
});

test('temporary invalid names and field unions repaired before final validation; last write wins', () => {
  const p = prepare(
    state(),
    envelope([
      rename('a', 'b'),
      rename('b', 'a'),
      {
        op: 'update_node',
        node_id: 'a',
        set_fields: { instruction_template: { parts: [{ kind: 'Text', text: 'first' }] } },
        unset_fields: [],
      },
      {
        op: 'update_node',
        node_id: 'a',
        set_fields: { instruction_template: { parts: [{ kind: 'Text', text: 'last' }] } },
        unset_fields: ['instructions'],
      },
    ]),
  );
  assert.equal(p.candidate.nodes.a!.name, 'b');
  assert.equal(p.candidate.nodes.b!.name, 'a');
  const a = p.candidate.nodes.a!;
  assert.ok(a.kind === 'role');
  assert.deepEqual(a.instruction_template, { parts: [{ kind: 'Text', text: 'last' }] });
  assert.equal(Object.hasOwn(a, 'instructions'), false);
});

test('uses cycles are legal, ordered and independently indexed', () => {
  const p = prepare(
    state(),
    envelope([
      { op: 'add_use', source_id: 'a', target_id: 'b' },
      { op: 'add_use', source_id: 'b', target_id: 'a', position: 0 },
      { op: 'add_use', source_id: 'a', target_id: 'r', position: 0 },
    ]),
  );
  assert.deepEqual(p.candidate.nodes.a!.uses, ['r', 'b']);
  assert.deepEqual(p.candidate.nodes.b!.uses, ['a']);
  assert.deepEqual(p.protection.reference_targets, ['a', 'b', 'r']);
  assert.deepEqual(
    p.facts.map((f) => f.type),
    ['UsesAssigned', 'UsesAssigned'],
  );
});

test('rename back and transient relation writes are endpoint noops with exact empty facts', () => {
  const base = state();
  const p = prepare(
    base,
    envelope([
      rename('a', 'changed'),
      rename('a', 'a'),
      { op: 'add_use', source_id: 'a', target_id: 'b' },
      { op: 'remove_use', source_id: 'a', target_id: 'b' },
    ]),
  );
  assert.equal(p.noop, true);
  assert.equal(p.resultRevision, '7');
  assert.equal(p.candidate.digest(), base.definitionDigest);
  assert.deepEqual(p.facts, []);
  assert.deepEqual(p.protection.impact, []);
  assert.equal(p.factsDigest, hash([], 'contexture.facts/v1'));
});

test('root transient noop retains root-operation authority intent without claiming authorization', () => {
  const p = prepare(
    state(),
    envelope([
      { op: 'remove_root', node_id: 'r' },
      { op: 'add_root', node_id: 'r', plane: 'model', position: 0 },
    ]),
  );
  assert.equal(p.noop, true);
  assert.equal(p.rootOperations, true);
  assert.equal(p.protection.roots_changed, false);
});

test('root move changes derived planes and emits complete roots assignment', () => {
  const p = prepare(
    state(),
    envelope([{ op: 'move_node', node_id: 'a', target: { plane: 'prompt', position: 1 } }]),
  );
  assert.deepEqual(p.candidate.roots, [
    { node_id: 'r', plane: 'model' },
    { node_id: 'a', plane: 'prompt' },
  ]);
  assert.deepEqual(
    p.facts.map((f) => f.type),
    ['RootsAssigned', 'MembersAssigned'],
  );
  assert.equal(p.protection.roots_changed, true);
});

test('deep frozen schemas, extensions, field values and request aliases cannot mutate proposal', () => {
  const config = { nested: [{ value: 1 }] };
  const base = state({ nodes: [node('r', { mutable: true })] });
  const request = envelope([
    {
      op: 'create_node',
      node: {
        node_id: 't',
        kind: 'tool',
        name: 'tool',
        description: 'tool',
        extensions: { 'test:data': config },
      },
    },
    { op: 'attach_node', node_id: 't', target: member('r', 0, 'tools') },
  ]);
  const p = prepare(base, request);
  config.nested[0]!.value = 99;
  assert.deepEqual(p.candidate.nodes.t!.extensions, { 'test:data': { nested: [{ value: 1 }] } });
  assert.ok(Object.isFrozen(p.facts));
  assert.ok(Object.isFrozen(p.envelope.value.commands));
  assert.throws(() => {
    (p.approvalSubject as Raw).base_revision = '99';
  }, TypeError);
  assert.throws(() => {
    ((p.facts[0]!.node as Raw).extensions as Raw)['test:data'] = null;
  }, TypeError);
  assert.equal(base.definition.nodes.r!.kind, 'role');
});

test('runtime update schema/config remains deeply frozen with no latest binding resolution', () => {
  const base = state({
    mode: 'runtime',
    nodes: [
      node('r', { mutable: true, members: { tools: ['t'] } }),
      {
        node_id: 't',
        kind: 'tool',
        name: 'tool',
        description: 'tool',
        binding: {
          kind: 'registered',
          binding_id: 'binding',
          version: 'latest',
          portability: { kind: 'native', language: 'typescript', version: '1', factory: 'inert' },
        },
      },
    ],
  });
  const schema = { type: 'object', properties: { x: { type: 'string' } } };
  const p = prepare(
    base,
    envelope([
      { op: 'update_node', node_id: 't', set_fields: { input_contract: schema }, unset_fields: [] },
    ]),
  );
  schema.properties.x.type = 'number';
  const tool = p.candidate.nodes.t!;
  assert.ok(tool.kind === 'tool');
  assert.equal(tool.binding!.version, 'latest');
  assert.deepEqual(tool.input_contract, { type: 'object', properties: { x: { type: 'string' } } });
  assert.ok(Object.isFrozen((tool.input_contract as Raw).properties));
});

test('CAS validates revision, digest and retained history and rebuilds exact proposal', () => {
  const base = state();
  const p = prepare(base, envelope([rename('a', 'new')]));
  assert.equal(recheckPrepared(base, p).approvalSubjectDigest, p.approvalSubjectDigest);
  for (const current of [
    state({}, '8'),
    state({ application_name: 'other' }),
    state({}, '7', [{ node_id: 'past', kind: 'skill', mutable: true, deleted_revision: '2' }]),
  ])
    assert.throws(
      () => recheckPrepared(current, p),
      (e: unknown) => e instanceof GraphError && e.code === 'revision_conflict',
    );
  assert.throws(() => recheckPrepared(base, { ...p, rootOperations: true }));
  assert.throws(() => recheckPrepared(base, { ...p, facts: [] }));
  assert.throws(() =>
    recheckPrepared(base, { ...p, approvalSubjectDigest: `sha256:${'0'.repeat(64)}` }),
  );
});

test('request provenance excluded from command hash but reason/ordered commands retained', () => {
  const first = TransactionEnvelope.fromJSON(envelope([rename('a', 'new')]));
  const second = TransactionEnvelope.fromJSON(
    envelope([rename('a', 'new')], {
      idempotency_key: 'other',
      correlation_id: 'other',
      approval_ref: 'approval',
    }),
  );
  assert.equal(first.commandDigest, second.commandDigest);
  assert.notEqual(
    first.commandDigest,
    TransactionEnvelope.fromJSON(envelope([rename('a', 'new')], { reason: 'other' })).commandDigest,
  );
});

for (const [label, commands, code] of [
  [
    'forward use',
    [
      { op: 'add_use', source_id: 'a', target_id: 'c' },
      { op: 'create_node', node: node('c') },
    ],
    'reference_not_found',
  ],
  [
    'forward NodeRef',
    [
      {
        op: 'update_node',
        node_id: 'a',
        set_fields: { instruction_template: { parts: [{ kind: 'NodeRef', target_id: 'c' }] } },
        unset_fields: ['instructions'],
      },
      { op: 'create_node', node: node('c') },
    ],
    'reference_not_found',
  ],
  ['duplicate ID', [{ op: 'create_node', node: node('a') }], 'identity_conflict'],
  [
    'double create',
    [
      { op: 'create_node', node: node('c') },
      { op: 'create_node', node: node('c') },
    ],
    'identity_conflict',
  ],
  ['unowned final node', [{ op: 'detach_node', node_id: 'a' }], 'schema_invalid'],
  ['unattached create', [{ op: 'create_node', node: node('c') }], 'schema_invalid'],
  ['attach owned', [{ op: 'attach_node', node_id: 'a', target: member() }], 'schema_invalid'],
  [
    'missing placement',
    [
      { op: 'detach_node', node_id: 'a' },
      { op: 'detach_node', node_id: 'a' },
    ],
    'schema_invalid',
  ],
  ['remove nonroot', [{ op: 'remove_root', node_id: 'a' }], 'schema_invalid'],
  ['cycle', [{ op: 'move_node', node_id: 'r', target: member('a') }], 'schema_invalid'],
  [
    'wrong slot kind',
    [{ op: 'move_node', node_id: 'a', target: member('r', 0, 'tools') }],
    'schema_invalid',
  ],
  [
    'wrong process variant',
    [{ op: 'move_node', node_id: 'a', target: member('r', 0, 'pre_process') }],
    'schema_invalid',
  ],
  [
    'reorder changed set',
    [{ op: 'reorder_members', parent_id: 'r', slot: 'children', node_ids: ['a'] }],
    'schema_invalid',
  ],
  [
    'duplicate use',
    [
      { op: 'add_use', source_id: 'a', target_id: 'b' },
      { op: 'add_use', source_id: 'a', target_id: 'b' },
    ],
    'schema_invalid',
  ],
  ['self use', [{ op: 'add_use', source_id: 'a', target_id: 'a' }], 'schema_invalid'],
  ['missing use', [{ op: 'remove_use', source_id: 'a', target_id: 'b' }], 'schema_invalid'],
  ['name collision', [rename('a', 'b')], 'schema_invalid'],
  ['invalid name', [rename('a', 'bad/name')], 'schema_invalid'],
  [
    'unknown update',
    [{ op: 'update_node', node_id: 'a', set_fields: { mutable: true }, unset_fields: [] }],
    'schema_invalid',
  ],
  [
    'set unset conflict',
    [
      {
        op: 'update_node',
        node_id: 'a',
        set_fields: { instructions: '' },
        unset_fields: ['instructions'],
      },
    ],
    'schema_invalid',
  ],
  [
    'unset required',
    [{ op: 'update_node', node_id: 'a', set_fields: {}, unset_fields: ['description'] }],
    'schema_invalid',
  ],
  [
    'prepopulated create uses',
    [{ op: 'create_node', node: node('c', { uses: ['a'] }) }],
    'schema_invalid',
  ],
  [
    'prepopulated create members',
    [{ op: 'create_node', node: node('c', { members: { children: ['a'] } }) }],
    'schema_invalid',
  ],
] as const)
  test(`atomic rejection: ${label}`, () => reject(state(), [...commands], code));

for (const op of UNSUPPORTED_COMMANDS)
  test(`unsupported command explicitly fails closed: ${op}`, () =>
    reject(state(), [{ op }], 'unsupported_contract'));

test('retained tombstone prevents reuse even when currently absent', () => {
  reject(
    state({}, '7', [{ node_id: 'c', kind: 'role', mutable: 'inherit', deleted_revision: '3' }]),
    [{ op: 'create_node', node: node('c') }],
    'identity_conflict',
  );
});

test('limits enforce command/inline/definition/resolved/node/edge/depth/node-byte budgets', () => {
  const base = state();
  const request = envelope([rename('a', 'new'), rename('b', 'newer')]);
  for (const limits of [
    { ...DEFAULT_LIMITS, max_commands: 1 },
    { ...DEFAULT_LIMITS, max_transaction_bytes: 20 },
    { ...DEFAULT_LIMITS, max_definition_bytes: 20 },
    { ...DEFAULT_LIMITS, max_resolved_bytes: 1 },
    { ...DEFAULT_LIMITS, max_nodes: 1 },
    { ...DEFAULT_LIMITS, max_edges: 1 },
    { ...DEFAULT_LIMITS, max_node_bytes: 1 },
  ])
    assert.throws(
      () => prepare(base, request, { limits }),
      (e: unknown) => e instanceof GraphError && e.code === 'limit_exceeded',
    );
  const deep = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['a'] } }),
      node('a', { members: { children: ['b'] } }),
      node('b'),
    ],
  });
  assert.throws(() =>
    prepare(deep, envelope([rename('b', 'new')]), { limits: { ...DEFAULT_LIMITS, max_depth: 1 } }),
  );
});

test('raw lexical gate and closed envelope reject malformed requests', () => {
  for (const request of [
    envelope([]),
    envelope([rename('a', 'new')], { extra: true }),
    envelope([rename('a', 'new')], { base_revision: '07' }),
    envelope([{ ...rename('a', 'new'), extra: true }]),
    envelope([{ op: 'add_root', node_id: 'a', plane: 'model', position: 0.5 }]),
  ])
    assert.throws(() => prepare(state(), request));
  const raw = JSON.stringify(envelope([rename('a', 'new')]));
  assert.equal(prepare(state(), new TextEncoder().encode(raw)).candidate.nodes.a!.name, 'new');
  assert.throws(() =>
    prepare(
      state(),
      new TextEncoder().encode(raw.replace('"commands":', '"reason":"duplicate","commands":')),
    ),
  );
  assert.throws(() =>
    prepare(
      state(),
      new TextEncoder().encode(
        JSON.stringify(
          envelope([{ op: 'add_use', source_id: 'a', target_id: 'b', position: 1 }]),
        ).replace('"position":1', '"position":9007199254740993'),
      ),
    ),
  );
});

test('counter overflow refuses change but allows exact endpoint noop', () => {
  const base = state({}, '99999999999999999999');
  assert.throws(
    () => prepare(base, envelope([rename('a', 'new')], { base_revision: base.revision })),
    (e: unknown) => e instanceof GraphError && e.code === 'limit_exceeded',
  );
  assert.equal(
    prepare(base, envelope([rename('a', 'a')], { base_revision: base.revision })).resultRevision,
    base.revision,
  );
});

test('ordered creates permit later NodeRefs with normalized defaults in command digest', () => {
  const p = prepare(
    state(),
    envelope([
      { op: 'create_node', node: node('target') },
      {
        op: 'create_node',
        node: {
          node_id: 'source',
          kind: 'skill',
          name: 'source',
          description: 'description',
          instruction_template: { parts: [{ kind: 'NodeRef', target_id: 'target', label: '' }] },
        },
      },
      { op: 'attach_node', node_id: 'target', target: member('r', 2) },
      { op: 'attach_node', node_id: 'source', target: member('r', 0, 'skills') },
    ]),
  );
  assert.deepEqual(
    p.facts.map((f) => (f.node as Raw | undefined)?.node_id ?? f.type),
    ['source', 'target', 'MembersAssigned'],
  );
  const commands = p.envelope.value.commands as readonly Raw[];
  const created = commands[0]!.node as Raw;
  assert.deepEqual(created.members, { children: [], skills: [], tools: [] });
  assert.deepEqual(created.uses, []);
  assert.equal(created.mutable, 'inherit');
  assert.equal(
    p.envelope.commandDigest,
    hash(
      {
        schema: 'contexture.transaction/v1',
        graph_id: 'g',
        base_revision: '7',
        commands,
        reason: 'edit',
      },
      'contexture.command/v1',
    ),
  );
  assert.deepEqual(p.protection.reference_targets, ['target']);
});

test('singleton replacement cannot overwrite an occupied slot; explicit detach then repair works', () => {
  const base = state({
    nodes: [
      node('r', { mutable: true, members: { pre_process: 'a', children: ['b'] } }),
      node('a', { role_variant: 'pre_process' }),
      node('b', { role_variant: 'pre_process' }),
    ],
  });
  reject(base, [{ op: 'move_node', node_id: 'b', target: member('r', 0, 'pre_process') }]);
  const p = prepare(
    base,
    envelope([
      { op: 'detach_node', node_id: 'a' },
      { op: 'move_node', node_id: 'b', target: member('r', 0, 'pre_process') },
      { op: 'attach_node', node_id: 'a', target: member('r', 0) },
    ]),
  );
  const root = p.candidate.nodes.r!;
  assert.ok(root.kind === 'role');
  assert.equal(root.members.pre_process, 'b');
  assert.deepEqual(root.members.children, ['a']);
});

test('root and use insertion bounds reject rather than silently clamp', () => {
  reject(state(), [{ op: 'move_node', node_id: 'a', target: { plane: 'prompt', position: 2 } }]);
  reject(state(), [{ op: 'add_use', source_id: 'a', target_id: 'b', position: 1 }]);
  reject(state(), [{ op: 'add_use', source_id: 'a', target_id: 'b', position: -1 }]);
});

test('stale base revision and cross graph refuse before building a draft', () => {
  for (const fields of [{ base_revision: '6' }, { graph_id: 'other' }])
    assert.throws(
      () => prepare(state(), envelope([rename('a', 'new')], fields)),
      (error: unknown) => error instanceof GraphError && error.code === 'revision_conflict',
    );
});

test('unicode fact IDs follow scalar order, not UTF16 sorting', () => {
  const base = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['𐀀', '\ue000'] } }),
      node('𐀀'),
      node('\ue000'),
    ],
  });
  const p = prepare(base, envelope([rename('𐀀', 'astral'), rename('\ue000', 'bmp')]));
  assert.deepEqual(
    p.facts.map((f) => f.node_id),
    ['\ue000', '𐀀'],
  );
});

const prompt = (id = 'pa', target = 'a', fields: Raw = {}) => ({
  kind: 'prompt',
  publication_id: id,
  name: id,
  description: 'prompt',
  opens_id: target,
  model_may_open: true,
  ...fields,
});
const disconnect = (source_id: string, target_id: string, relation = 'containment') => ({
  source_id,
  target_id,
  relation,
});
const deletion = (
  targets = ['a'],
  deleted_ids = targets,
  disconnections = [disconnect('r', 'a')],
  policy = 'reject_references',
) => ({
  op: 'delete_nodes',
  targets,
  deleted_ids,
  disconnections,
  policy,
});
function payloadCommand(
  op: string,
  raw: unknown,
  retained = ['a'],
  added: string[] = [],
  removed: string[] = [],
  scope = ['a'],
): Raw {
  return {
    op,
    ...(op === 'replace_subtree' ? { anchor_id: scope[0] } : { scope_ids: scope }),
    id_mapping: { retained_ids: retained, new_ids: added, deleted_ids: removed },
    payload: { inline: raw },
  };
}
function changed(base: PureRevisionState, edit: (wire: Raw, nodes: Raw[]) => void): Raw {
  const wire = base.definition.asJSON() as Raw;
  edit(wire, wire.nodes as Raw[]);
  return wire;
}
function codeIs(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GraphError && String(e.code) === code;
}

test('all twenty original ordinary command names are decoded, unknown operations fail closed', () => {
  assert.equal(SUPPORTED_COMMANDS.length, 20);
  assert.deepEqual(UNSUPPORTED_COMMANDS, []);
  reject(state(), [{ op: 'execute_handler' }], 'unsupported_contract');
});

test('delete_nodes emits exact base-to-final facts and retained tombstones without mutating base', () => {
  const base = state();
  const p = prepare(base, envelope([deletion()]));
  const root = p.candidate.nodes.r!;
  assert.ok(root.kind === 'role');
  assert.deepEqual(root.members.children, ['b']);
  assert.deepEqual(p.facts, [
    {
      type: 'MembersAssigned',
      node_id: 'r',
      before: (base.definition.nodes.r as unknown as Raw).members,
      after: root.members,
    },
    {
      type: 'NodeDeleted',
      node_id: 'a',
      before: base.definition.nodes.a,
      tombstone: { node_id: 'a', kind: 'role', mutable: 'inherit', deleted_revision: '8' },
    },
  ]);
  assert.deepEqual(p.tombstones, [
    { node_id: 'a', kind: 'role', mutable: 'inherit', deleted_revision: '8' },
  ]);
  assert.equal(p.factsDigest, hash(p.facts, 'contexture.facts/v1'));
  assert.equal(base.tombstones.length, 0);
  assert.ok(base.definition.nodes.a);
  assert.ok(Object.isFrozen(p.tombstones[0]));
  assert.deepEqual(recheckPrepared(base, p).tombstones, p.tombstones);
  assert.throws(() => recheckPrepared(base, { ...p, tombstones: [] }), codeIs('revision_conflict'));
});

test('delete subtree closure including descendants uses exact sorted deletion facts', () => {
  const base = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['a'] } }),
      node('a', { members: { children: ['z'] } }),
      node('z'),
    ],
  });
  const p = prepare(base, envelope([deletion(['a'], ['z', 'a'])]));
  assert.deepEqual(
    p.facts.filter((f) => f.type === 'NodeDeleted').map((f) => f.node_id),
    ['a', 'z'],
  );
  assert.deepEqual(
    p.tombstones.map((t) => t.node_id),
    ['a', 'z'],
  );
  reject(base, [deletion(['a'], ['a'])]);
});

test('explicit cascade removes uses and publications only with exact boundary declarations', () => {
  const base = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['a', 'b'] } }),
      node('a'),
      node('b', { uses: ['a'] }),
    ],
    publications: [prompt()],
  });
  const edges = [
    disconnect('r', 'a'),
    disconnect('b', 'a', 'uses'),
    disconnect('pa', 'a', 'publication'),
  ];
  const p = prepare(base, envelope([deletion(['a'], ['a'], edges, 'explicit_cascade')]));
  assert.deepEqual(p.candidate.nodes.b!.uses, []);
  assert.deepEqual(p.candidate.publications, []);
  assert.deepEqual(
    p.facts.map((f) => f.type),
    ['MembersAssigned', 'UsesAssigned', 'PublicationRemoved', 'NodeDeleted'],
  );
  reject(base, [deletion(['a'], ['a'], edges)]);
  reject(base, [deletion(['a'], ['a'], edges.slice(1), 'explicit_cascade')]);
  reject(base, [deletion(['a'], ['a'], [...edges, edges[0]!], 'explicit_cascade')]);
});

test('delete requires explicit NodeRef and translation repairs before cascading', () => {
  const b = node('b', { instruction_template: { parts: [{ kind: 'NodeRef', target_id: 'a' }] } });
  delete b.instructions;
  const base = state({
    nodes: [node('r', { mutable: true, members: { children: ['a', 'b'] } }), node('a'), b],
    presentations: {
      default_locale: 'en',
      catalogs: [{ locale: 'en', entries: [{ node_id: 'a', title: 'A' }] }],
    },
  });
  reject(base, [deletion()]);
  const repair = {
    op: 'update_node',
    node_id: 'b',
    set_fields: { instructions: '' },
    unset_fields: ['instruction_template'],
  };
  reject(base, [repair, deletion()]);
  const p = prepare(
    base,
    envelope([repair, { op: 'remove_presentation', locale: 'EN', node_id: 'a' }, deletion()]),
  );
  assert.equal(p.candidate.nodes.a, undefined);
  assert.deepEqual(p.candidate.presentations.catalogs, [{ locale: 'en', entries: [] }]);
});

test('transient create/delete is a noop with no invented tombstone; same batch reuse is forbidden', () => {
  const create = { op: 'create_node', node: node('c') };
  const erase = deletion(['c'], ['c'], []);
  const p = prepare(state(), envelope([create, erase]));
  assert.deepEqual(p.facts, []);
  assert.deepEqual(p.tombstones, []);
  reject(state(), [create, erase, create], 'identity_conflict');
});

test('root deletion preserves root-operation intent and does not invent an empty serving forest', () => {
  const base = state({
    nodes: [node('r', { mutable: true }), node('a', { mutable: true })],
    roots: [
      { node_id: 'r', plane: 'model' },
      { node_id: 'a', plane: 'prompt' },
    ],
  });
  const p = prepare(base, envelope([deletion(['a'], ['a'], [disconnect('g', 'a')])]));
  assert.equal(p.rootOperations, true);
  assert.equal(p.protection.roots_changed, true);
  reject(base, [deletion(['r'], ['r'], [disconnect('g', 'r')])]);
});

test('restore_nodes uses retained immutable history, emits NodeRestored and keeps tombstones', () => {
  const past = state({}, '2');
  const deleted = prepare(state(), envelope([deletion()]));
  const base = new PureRevisionState(deleted.candidate, '8', deleted.tombstones);
  const commands = [
    { op: 'restore_nodes', revision: '2', node_ids: ['a'] },
    { op: 'attach_node', node_id: 'a', target: member('r', 0) },
  ];
  const p = prepare(base, envelope(commands, { base_revision: '8' }), { history: [past] });
  assert.equal(p.candidate.digest(), past.definitionDigest);
  assert.deepEqual(p.facts[0], {
    type: 'NodeRestored',
    node: past.definition.nodes.a,
    tombstone: base.tombstones[0],
  });
  assert.deepEqual(p.tombstones, base.tombstones);
  assert.equal(recheckPrepared(base, p, { history: [past] }).factsDigest, p.factsDigest);
  assert.throws(() => recheckPrepared(base, p), codeIs('history_unavailable'));
  const altered = state(
    {
      nodes: [
        node('r', { mutable: true, members: { children: ['a', 'b'] } }),
        node('a', { description: 'different history' }),
        node('b'),
      ],
    },
    '2',
  );
  assert.throws(
    () => recheckPrepared(base, p, { history: [altered] }),
    codeIs('revision_conflict'),
  );
});

test('restore exact historical subtree requires all members and ordered placement repairs', () => {
  const past = state(
    {
      nodes: [
        node('r', { mutable: true, members: { children: ['a'] } }),
        node('a', { members: { children: ['z'] } }),
        node('z'),
      ],
    },
    '2',
  );
  const erased = prepare(
    new PureRevisionState(past.definition, '7'),
    envelope([deletion(['a'], ['z', 'a'])]),
  );
  const base = new PureRevisionState(erased.candidate, '8', erased.tombstones);
  const attach = { op: 'attach_node', node_id: 'a', target: member() };
  assert.throws(() =>
    prepare(
      base,
      envelope([{ op: 'restore_nodes', revision: '2', node_ids: ['a'] }, attach], {
        base_revision: '8',
      }),
      { history: [past] },
    ),
  );
  const p = prepare(
    base,
    envelope([{ op: 'restore_nodes', revision: '2', node_ids: ['z', 'a'] }, attach], {
      base_revision: '8',
    }),
    { history: [past] },
  );
  assert.equal(p.candidate.digest(), past.definitionDigest);
  assert.deepEqual(
    p.facts.filter((f) => f.type === 'NodeRestored').map((f) => (f.node as Raw).node_id),
    ['a', 'z'],
  );
});

test('delete then historical restore of an existing node resolves to endpoint noop', () => {
  const base = state();
  const p = prepare(
    base,
    envelope([
      deletion(),
      { op: 'restore_nodes', revision: '7', node_ids: ['a'] },
      { op: 'attach_node', node_id: 'a', target: member() },
    ]),
    { history: [base] },
  );
  assert.equal(p.noop, true);
  assert.deepEqual(p.tombstones, []);
});

for (const [label, command, history, expected] of [
  [
    'missing evidence',
    { op: 'restore_nodes', revision: '2', node_ids: ['c'] },
    [],
    'history_unavailable',
  ],
  [
    'future history',
    { op: 'restore_nodes', revision: '8', node_ids: ['c'] },
    [state({}, '8')],
    'history_unavailable',
  ],
  [
    'wrong graph',
    { op: 'restore_nodes', revision: '2', node_ids: ['c'] },
    [state({ graph_id: 'other' }, '2')],
    'history_unavailable',
  ],
  [
    'live identity',
    { op: 'restore_nodes', revision: '2', node_ids: ['a'] },
    [state({}, '2')],
    'identity_conflict',
  ],
  [
    'invented identity',
    { op: 'restore_nodes', revision: '2', node_ids: ['c'] },
    [
      state(
        {
          nodes: [node('r', { mutable: true }), node('c')],
          roots: [
            { node_id: 'r', plane: 'model' },
            { node_id: 'c', plane: 'prompt' },
          ],
        },
        '2',
      ),
    ],
    'history_unavailable',
  ],
] as const)
  test(`restore atomic rejection: ${label}`, () => {
    const base = state();
    const digest = base.definitionDigest;
    assert.throws(
      () => prepare(base, envelope([rename('b', 'temporary'), command]), { history }),
      codeIs(expected),
    );
    assert.equal(base.definitionDigest, digest);
    assert.deepEqual(base.tombstones, []);
  });

for (const op of ['replace_subtree', 'import', 'reconcile']) {
  test(`${op} executes complete scoped candidate with exact new/deleted partition`, () => {
    const base = state();
    const raw = changed(base, (_wire, nodes) => {
      const a = nodes.find((n) => n.node_id === 'a')!;
      a.members = { children: ['c'] };
      a.description = 'replacement';
      nodes.push(node('c'));
    });
    const p = prepare(base, envelope([payloadCommand(op, raw, ['a'], ['c'])]));
    assert.deepEqual(p.candidate.nodes.a, GraphDefinition.fromJSON(raw).nodes.a);
    assert.equal(p.candidate.nodes.c!.name, 'c');
    assert.deepEqual(
      p.facts.map((f) => f.type),
      ['NodeCreated', 'NodeFieldsSet', 'MembersAssigned'],
    );
    assert.deepEqual(p.protection.impact, ['a', 'c', 'r']);
    assert.deepEqual(p.candidate.nodes.b, base.definition.nodes.b);
    assert.equal(recheckPrepared(base, p).approvalSubjectDigest, p.approvalSubjectDigest);
  });
  test(`${op} atomic rejection preserves outside fields and identity`, () => {
    const base = state();
    const raw = changed(base, (_wire, nodes) => {
      nodes.find((n) => n.node_id === 'b')!.description = 'outside';
    });
    const before = canonicalJSON(base.definition.asJSON());
    assert.throws(
      () => prepare(base, envelope([rename('a', 'temporary'), payloadCommand(op, raw)])),
      codeIs('scope_escape'),
    );
    assert.deepEqual(canonicalJSON(base.definition.asJSON()), before);
  });
}

test('replacement checks the preceding command draft, permitting explicit boundary repair first', () => {
  const base = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['a', 'b'] } }),
      node('a'),
      node('b', { uses: ['a'] }),
    ],
  });
  const raw = changed(base, (_wire, nodes) => {
    nodes.find((n) => n.node_id === 'b')!.uses = [];
    nodes.find((n) => n.node_id === 'a')!.description = 'changed';
  });
  assert.throws(
    () => prepare(base, envelope([payloadCommand('reconcile', raw)])),
    codeIs('scope_escape'),
  );
  assert.equal(
    prepare(
      base,
      envelope([
        { op: 'remove_use', source_id: 'b', target_id: 'a' },
        payloadCommand('reconcile', raw),
      ]),
    ).candidate.nodes.a!.description,
    'changed',
  );
});

test('replacement deletes scoped identities with exact mapping and cannot resurrect tombstones', () => {
  const base = state();
  const raw = changed(base, (_wire, nodes) => {
    nodes.splice(
      nodes.findIndex((n) => n.node_id === 'a'),
      1,
    );
    (nodes.find((n) => n.node_id === 'r')!.members as Raw).children = ['b'];
  });
  const p = prepare(base, envelope([payloadCommand('replace_subtree', raw, [], [], ['a'])]));
  assert.equal(p.facts.at(-1)!.type, 'NodeDeleted');
  assert.deepEqual(
    p.tombstones.map((t) => t.node_id),
    ['a'],
  );
  const current = new PureRevisionState(p.candidate, '8', p.tombstones);
  assert.throws(
    () =>
      prepare(
        current,
        envelope([payloadCommand('import', base.definition.asJSON(), [], ['a'])], {
          base_revision: '8',
        }),
      ),
    codeIs('identity_conflict'),
  );
  reject(base, [payloadCommand('replace_subtree', raw, [], [], [])]);
});

for (const [label, edit, expected] of [
  [
    'application rename',
    (wire: Raw) => {
      wire.application_name = 'other';
    },
    'identity_conflict',
  ],
  [
    'partial metadata',
    (wire: Raw) => {
      wire.extensions = { 'test:meta': 1 };
    },
    'scope_escape',
  ],
  [
    'partial locale',
    (wire: Raw) => {
      (wire.presentations as Raw).default_locale = 'fr';
    },
    'scope_escape',
  ],
  [
    'cross graph',
    (wire: Raw) => {
      wire.graph_id = 'other';
    },
    'schema_invalid',
  ],
  [
    'policy rewrite',
    (_wire: Raw, nodes: Raw[]) => {
      nodes.find((n) => n.node_id === 'a')!.mutable = true;
    },
    'identity_conflict',
  ],
  [
    'variant rewrite',
    (_wire: Raw, nodes: Raw[]) => {
      nodes.find((n) => n.node_id === 'a')!.role_variant = 'pre_process';
    },
    'identity_conflict',
  ],
  [
    'scope crossing',
    (_wire: Raw, nodes: Raw[]) => {
      (nodes.find((n) => n.node_id === 'r')!.members as Raw).children = ['a'];
      nodes.find((n) => n.node_id === 'a')!.members = { children: ['b'] };
    },
    'scope_escape',
  ],
] as const)
  test(`replacement atomic rejection: ${label}`, () => {
    const base = state();
    const raw = changed(base, edit);
    assert.throws(
      () => prepare(base, envelope([payloadCommand('reconcile', raw)])),
      codeIs(expected),
    );
    assert.equal(base.definition.nodes.a!.name, 'a');
  });

test('whole-graph reconcile permits metadata and catalog order with complete facts', () => {
  const base = state();
  const raw = changed(base, (wire) => {
    wire.extensions = { 'test:graph': 1 };
    wire.presentations = {
      default_locale: 'fr',
      catalogs: [{ locale: 'fr', entries: [{ node_id: 'a', title: 'A' }] }],
    };
    wire.roots = [{ node_id: 'r', plane: 'model' }];
  });
  const p = prepare(
    base,
    envelope([payloadCommand('reconcile', raw, ['r', 'a', 'b'], [], [], ['r'])]),
  );
  assert.deepEqual(
    p.facts.map((f) => f.type),
    ['GraphFieldsSet', 'PresentationsAssigned'],
  );
  assert.deepEqual(p.facts[0], {
    type: 'GraphFieldsSet',
    before: { extensions: {} },
    after: { extensions: { 'test:graph': 1 } },
  });
});

test('blob replacements use exact content-addressed canonical bytes without callbacks', () => {
  const base = state();
  const raw = changed(base, (_wire, nodes) => {
    nodes.find((n) => n.node_id === 'a')!.description = 'blob';
  });
  const bytes = canonicalJSON(raw);
  const ref = (data: Uint8Array) => ({
    digest: 'sha256:' + createHash('sha256').update(data).digest('hex'),
    size: String(data.length),
    media_type: 'application/json',
  });
  const command = { ...payloadCommand('reconcile', raw), payload: { blob: ref(bytes) } };
  const p = prepare(base, envelope([command]), { payloads: [bytes] });
  assert.equal(p.candidate.nodes.a!.description, 'blob');
  assert.equal(recheckPrepared(base, p, { payloads: [bytes] }).factsDigest, p.factsDigest);
  assert.throws(() => prepare(base, envelope([command])), codeIs('unsupported_contract'));
  assert.throws(
    () => prepare(base, envelope([command]), { payloads: [new Uint8Array()] }),
    codeIs('schema_invalid'),
  );
  const noncanonical = new TextEncoder().encode(JSON.stringify(raw, null, 2));
  assert.throws(
    () =>
      prepare(base, envelope([{ ...command, payload: { blob: ref(noncanonical) } }]), {
        payloads: [noncanonical],
      }),
    codeIs('schema_invalid'),
  );
  bytes.fill(0);
  assert.equal(p.candidate.nodes.a!.description, 'blob');
  assert.throws(() => recheckPrepared(base, p, { payloads: [bytes] }), codeIs('schema_invalid'));
});

test('replacement expansion and blob size are bounded before candidate publication', () => {
  const base = state();
  const raw = base.definition.asJSON();
  assert.throws(
    () =>
      prepare(base, envelope([payloadCommand('reconcile', raw, ['r', 'a', 'b'], [], [], ['r'])]), {
        limits: { ...DEFAULT_LIMITS, max_expanded_operations: 2 },
      }),
    codeIs('limit_exceeded'),
  );
  assert.throws(
    () =>
      prepare(
        base,
        envelope([
          {
            ...payloadCommand('reconcile', raw),
            payload: {
              blob: {
                digest: `sha256:${'0'.repeat(64)}`,
                size: '99999999999999999999',
                media_type: 'application/json',
              },
            },
          },
        ]),
        { payloads: [] },
      ),
    codeIs('limit_exceeded'),
  );
});

test('put/remove_publication retain insertion positions and emit shifted PublicationPut facts', () => {
  const base = state({ publications: [prompt('p1'), prompt('p2', 'b')] });
  const p = prepare(
    base,
    envelope([
      { op: 'remove_publication', publication_id: 'p1' },
      { op: 'put_publication', publication: prompt('p3') },
      { op: 'put_publication', publication: prompt('p3', 'b', { description: 'last' }) },
    ]),
  );
  assert.deepEqual(p.candidate.publications, [
    prompt('p2', 'b'),
    prompt('p3', 'b', { description: 'last' }),
  ]);
  assert.deepEqual(p.facts, [
    { type: 'PublicationRemoved', before: prompt('p1'), position: 0 },
    {
      type: 'PublicationPut',
      before: { present: true, value: prompt('p2', 'b') },
      after: prompt('p2', 'b'),
      position: 0,
    },
    {
      type: 'PublicationPut',
      before: { present: false },
      after: prompt('p3', 'b', { description: 'last' }),
      position: 1,
    },
  ]);
  assert.deepEqual(p.protection.reference_targets, ['a', 'b']);
  reject(base, [{ op: 'remove_publication', publication_id: 'missing' }]);
  reject(
    base,
    [{ op: 'put_publication', publication: prompt('new', 'absent') }],
    'reference_not_found',
  );
  reject(base, [{ op: 'put_publication', publication: { ...prompt(), model_may_open: 'true' } }]);
});

test('put/remove_presentation normalizes locale, replaces in place and retains empty catalogs', () => {
  const base = state();
  const p = prepare(
    base,
    envelope([
      { op: 'put_presentation', locale: 'EN-us', presentation: { node_id: 'b', title: 'B' } },
      { op: 'put_presentation', locale: 'en-US', presentation: { node_id: 'a', description: 'A' } },
      { op: 'put_presentation', locale: 'en-US', presentation: { node_id: 'b', title: 'last' } },
      { op: 'remove_presentation', locale: 'en-US', node_id: 'a' },
    ]),
  );
  assert.deepEqual(p.candidate.presentations.catalogs, [
    { locale: 'en-US', entries: [{ node_id: 'b', title: 'last' }] },
  ]);
  assert.deepEqual(p.facts, [
    {
      type: 'PresentationsAssigned',
      before: base.definition.presentations,
      after: p.candidate.presentations,
    },
  ]);
  const empty = prepare(
    state(),
    envelope([
      { op: 'put_presentation', locale: 'fr', presentation: { node_id: 'a', title: 'A' } },
      { op: 'remove_presentation', locale: 'fr', node_id: 'a' },
    ]),
  );
  assert.equal(empty.noop, false);
  assert.deepEqual(empty.candidate.presentations.catalogs, [{ locale: 'fr', entries: [] }]);
  reject(base, [{ op: 'remove_presentation', locale: 'en', node_id: 'a' }]);
  reject(
    base,
    [{ op: 'put_presentation', locale: 'en', presentation: { node_id: 'missing', title: 'A' } }],
    'reference_not_found',
  );
  reject(base, [{ op: 'put_presentation', locale: 'en', presentation: { node_id: 'a' } }]);
});

test('new commands all share endpoint protection, including publication and presentation surfaces', () => {
  const base = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['a', 'b'] } }),
      node('a', { mutable: false }),
      node('b'),
    ],
    publications: [prompt()],
    presentations: {
      default_locale: 'en',
      catalogs: [{ locale: 'en', entries: [{ node_id: 'a', title: 'A' }] }],
    },
  });
  for (const command of [
    { op: 'put_publication', publication: prompt('pa', 'a', { description: 'changed' }) },
    { op: 'remove_publication', publication_id: 'pa' },
    { op: 'put_presentation', locale: 'en', presentation: { node_id: 'a', title: 'changed' } },
    { op: 'remove_presentation', locale: 'en', node_id: 'a' },
  ])
    reject(base, [command], 'mutation_protected');
  const withoutSurfaces = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['a', 'b'] } }),
      node('a', { mutable: false }),
      node('b'),
    ],
  });
  reject(withoutSurfaces, [deletion()], 'mutation_protected');
  const raw = changed(withoutSurfaces, (_wire, nodes) => {
    nodes.find((n) => n.node_id === 'a')!.description = 'blocked';
  });
  for (const op of ['replace_subtree', 'import', 'reconcile'])
    reject(withoutSurfaces, [payloadCommand(op, raw)], 'mutation_protected');
});

test('payload publication, catalog and entry reorders cannot cross locked targets', () => {
  const base = state({
    nodes: [
      node('r', { mutable: true, members: { children: ['a', 'b'] } }),
      node('a', { mutable: false }),
      node('b'),
    ],
    publications: [prompt('p1'), prompt('p2', 'b')],
    presentations: {
      default_locale: 'en',
      catalogs: [
        {
          locale: 'en',
          entries: [
            { node_id: 'a', title: 'A' },
            { node_id: 'b', title: 'B' },
          ],
        },
        { locale: 'fr', entries: [{ node_id: 'b', title: 'B' }] },
      ],
    },
  });
  for (const edit of [
    (wire: Raw) => {
      (wire.publications as unknown[]).reverse();
    },
    (wire: Raw) => {
      ((wire.presentations as Raw).catalogs as Raw[]).reverse();
    },
    (wire: Raw) => {
      (((wire.presentations as Raw).catalogs as Raw[])[0]!.entries as unknown[]).reverse();
    },
  ])
    reject(
      base,
      [payloadCommand('reconcile', changed(base, edit), ['r', 'a', 'b'], [], [], ['r'])],
      'mutation_protected',
    );
});

for (const slot of ['pre_process', 'children', 'post_process', 'skills', 'tools'])
  test(`typed slot reorder preserves exact set and variants: ${slot}`, () => {
    const single = slot === 'pre_process' || slot === 'post_process';
    const kind = slot === 'skills' ? 'skill' : slot === 'tools' ? 'tool' : 'role';
    const make = (id: string) => {
      const n = node(id, { kind, ...(single ? { role_variant: slot } : {}) });
      if (kind === 'tool') delete n.instructions;
      return n;
    };
    const base = state({
      nodes: [
        node('r', { mutable: true, members: { [slot]: single ? 'a' : ['a', 'b'] } }),
        make('a'),
        ...(!single ? [make('b')] : []),
      ],
    });
    const p = prepare(
      base,
      envelope([
        { op: 'reorder_members', parent_id: 'r', slot, node_ids: single ? ['a'] : ['b', 'a'] },
      ]),
    );
    const r = p.candidate.nodes.r!;
    assert.ok(r.kind === 'role');
    assert.deepEqual(r.members[slot as keyof typeof r.members], single ? 'a' : ['b', 'a']);
    assert.equal(p.noop, single);
    reject(base, [{ op: 'reorder_members', parent_id: 'r', slot, node_ids: [] }]);
  });

for (const kind of ['resource', 'route'])
  test(`put_publication validates ${kind} with pinned inert binding evidence`, () => {
    const binding = {
      kind: 'registered',
      binding_id: 'inert',
      version: 'latest',
      portability: {
        kind: 'native',
        language: 'typescript',
        version: '1',
        factory: 'never-execute',
      },
    };
    const base = state({
      mode: 'runtime',
      nodes: [
        node('r', { mutable: true, members: { tools: ['t'] } }),
        { node_id: 't', kind: 'tool', name: 'tool', description: 'tool', binding },
      ],
    });
    const pub =
      kind === 'resource'
        ? {
            kind,
            publication_id: 'p',
            opens_id: 't',
            name: 'resource',
            uri: 'urn:test:resource',
            mime_type: 'application/json',
          }
        : { kind, publication_id: 'p', opens_id: 't', method: 'GET', path: '/test' };
    const command = { op: 'put_publication', publication: pub };
    assert.throws(() => prepare(base, envelope([command])), codeIs('binding_contract_required'));
    const contracts = { t: new PublicationContract(binding, 'read_only', true) };
    const p = prepare(base, envelope([command]), { publicationContracts: contracts });
    assert.deepEqual(p.facts, [
      { type: 'PublicationPut', before: { present: false }, after: pub, position: 0 },
    ]);
    assert.equal(
      recheckPrepared(base, p, { publicationContracts: contracts }).factsDigest,
      p.factsDigest,
    );
    assert.throws(() =>
      prepare(base, envelope([command]), {
        publicationContracts: { t: new PublicationContract(binding, 'write', true) },
      }),
    );
  });

test('publication and presentation transient edits normalize to endpoint noop', () => {
  const base = state({
    publications: [prompt()],
    presentations: {
      default_locale: 'en',
      catalogs: [{ locale: 'en', entries: [{ node_id: 'a', title: 'A' }] }],
    },
  });
  const p = prepare(
    base,
    envelope([
      { op: 'remove_publication', publication_id: 'pa' },
      { op: 'put_publication', publication: prompt() },
      { op: 'put_presentation', locale: 'en', presentation: { node_id: 'a', title: 'temporary' } },
      { op: 'put_presentation', locale: 'en', presentation: { node_id: 'a', title: 'A' } },
    ]),
  );
  assert.equal(p.noop, true);
  assert.deepEqual(p.facts, []);
});

test('partial replacement allows only scoped entries in new nonempty catalogs', () => {
  const base = state();
  for (const entries of [[], [{ node_id: 'b', title: 'outside' }]]) {
    const raw = changed(base, (wire) => {
      wire.presentations = { default_locale: 'en', catalogs: [{ locale: 'fr', entries }] };
    });
    assert.throws(
      () => prepare(base, envelope([payloadCommand('import', raw)])),
      codeIs('scope_escape'),
    );
  }
  const raw = changed(base, (wire) => {
    wire.presentations = {
      default_locale: 'en',
      catalogs: [{ locale: 'fr', entries: [{ node_id: 'a', title: 'inside' }] }],
    };
  });
  assert.equal(
    prepare(base, envelope([payloadCommand('import', raw)])).facts[0]!.type,
    'PresentationsAssigned',
  );
});

test('partial replacement cannot rebind an outside publication identity into scope', () => {
  const base = state({ publications: [prompt('p', 'b')] });
  const raw = changed(base, (wire) => {
    wire.publications = [prompt('p', 'a')];
  });
  assert.throws(
    () => prepare(base, envelope([payloadCommand('reconcile', raw)])),
    codeIs('scope_escape'),
  );
});

test('restoration policy mismatch and protected destination both refuse atomically', () => {
  const historical = state(
    {
      nodes: [
        node('r', { mutable: true, members: { children: ['a'] } }),
        node('a', { mutable: true }),
      ],
    },
    '2',
  );
  const base = state({ nodes: [node('r', { mutable: true })] }, '7', [
    { node_id: 'a', kind: 'role', mutable: 'inherit', deleted_revision: '3' },
  ]);
  const commands = [
    { op: 'restore_nodes', revision: '2', node_ids: ['a'] },
    { op: 'attach_node', node_id: 'a', target: member() },
  ];
  assert.throws(
    () => prepare(base, envelope(commands), { history: [historical] }),
    codeIs('identity_conflict'),
  );
  const locked = state({ nodes: [node('r', { mutable: false })] }, '7', base.tombstones);
  assert.throws(
    () => prepare(locked, envelope(commands), { history: [state({}, '2')] }),
    codeIs('mutation_protected'),
  );
  assert.equal(locked.definition.nodes.a, undefined);
});

test('new closed command shapes reject malformed mappings, blobs, scopes and presentations', () => {
  const base = state();
  for (const command of [
    {
      op: 'delete_nodes',
      targets: [],
      deleted_ids: [],
      disconnections: [],
      policy: 'reject_references',
    },
    { op: 'restore_nodes', revision: '0', node_ids: ['a'] },
    { op: 'restore_nodes', revision: '2', node_ids: [] },
    { ...payloadCommand('import', base.definition.asJSON()), scope_ids: [] },
    {
      ...payloadCommand('import', base.definition.asJSON()),
      payload: { inline: base.definition.asJSON(), blob: {} },
    },
    {
      ...payloadCommand('import', base.definition.asJSON()),
      id_mapping: { retained_ids: ['a', 'a'], new_ids: [], deleted_ids: [] },
    },
    {
      ...payloadCommand('import', base.definition.asJSON()),
      payload: {
        blob: { digest: `sha256:${'A'.repeat(64)}`, size: '1', media_type: 'application/json' },
      },
    },
    {
      op: 'put_presentation',
      locale: 'en',
      presentation: { node_id: 'a', title: '', unexpected: true },
    },
  ]) {
    const before = canonicalJSON(base.definition.asJSON());
    assert.throws(() => prepare(base, envelope([rename('b', 'temporary'), command])));
    assert.deepEqual(canonicalJSON(base.definition.asJSON()), before);
  }
});
