import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canonicalDigest,
  canonicalJSON,
  GraphError,
  MAX_COUNTER,
  thawJSON,
} from '../src/core/graph/canonical.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import { PureRevisionState, prepare } from '../src/core/graph/transactions.js';
import {
  applyEvent,
  applyEventRecords,
  applyFacts,
  bootstrapEvent,
  BootstrapCandidate,
  changeEvent,
  decodeEventRecords,
  decodeGraphEvent,
  decodeResolvedFacts,
  factsDigest,
  resolveFacts,
  resolveMigration,
  RevisionState,
  UnseededState,
} from '../src/core/graph/events.js';
import { definitionDiff } from '../src/core/graph/diff.js';

type Wire = Record<string, unknown>;
const commandDigest = canonicalDigest({}, 'contexture.command/v1');
const options = { commandDigest, reason: 'test' };
function node(id: string, extra: Wire = {}): Wire {
  return {
    node_id: id,
    kind: 'role',
    name: id,
    description: 'description',
    instructions: '',
    ...extra,
  };
}
function definition(extra: Wire = {}): GraphDefinition {
  return GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'g',
    application_name: 'app',
    mode: 'disclosure_only',
    nodes: [node('r', { mutable: true, members: { children: ['a', 'b'] } }), node('a'), node('b')],
    roots: [{ node_id: 'r', plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
    ...extra,
  });
}
function request(base: PureRevisionState, commands: unknown[]): Wire {
  return {
    schema: 'contexture.transaction/v1',
    graph_id: 'g',
    base_revision: base.revision,
    idempotency_key: 'key',
    correlation_id: 'correlation',
    reason: 'test',
    commands,
  };
}
function native(base: PureRevisionState, commands: unknown[]) {
  const p = prepare(base, request(base, commands));
  const change = resolveFacts(base, p.candidate);
  assert.deepEqual(change.facts, p.facts);
  assert.deepEqual(change.tombstones, p.tombstones);
  assert.equal(change.factsDigest, p.factsDigest);
  return {
    p,
    change,
    event: changeEvent(base, change, { commandDigest: p.envelope.commandDigest, reason: 'test' }),
  };
}
function reject(fn: () => unknown, code?: string): void {
  assert.throws(
    fn,
    (e: unknown) => e instanceof GraphError && (code === undefined || String(e.code) === code),
  );
}
const deletion = {
  op: 'delete_nodes',
  targets: ['a'],
  deleted_ids: ['a'],
  disconnections: [{ source_id: 'r', target_id: 'a', relation: 'containment' }],
  policy: 'reject_references',
};

test('native execute -> resolved facts -> event -> immutable replay, exact digests', () => {
  const base = new PureRevisionState(definition(), '7');
  const { p, change, event } = native(base, [
    { op: 'rename_node', node_id: 'a', new_name: 'renamed' },
    { op: 'add_use', source_id: 'a', target_id: 'b' },
  ]);
  const after = applyEvent(base, event, { tombstones: p.tombstones });
  assert.equal(after.revision, '8');
  assert.equal(after.definitionDigest, p.candidate.digest());
  assert.equal(base.definition.nodes.a!.name, 'a');
  assert.deepEqual(
    applyFacts(base, change.facts, {
      tombstones: change.tombstones,
      revision: '8',
      beforeDigest: base.definitionDigest,
      afterDigest: change.candidate.digest(),
      resolvedFactDigest: change.factsDigest,
    }).definition.asJSON(),
    p.candidate.asJSON(),
  );
  assert.ok(Object.isFrozen(after));
  assert.ok(Object.isFrozen(after.definition.nodes.a));
  const raw = thawJSON(event) as Wire;
  const decoded = decodeGraphEvent(raw);
  raw.reason = 'mutated';
  assert.equal(decoded.reason, 'test');
  assert.throws(() => {
    (decoded as Wire).reason = 'mutated';
  }, TypeError);
  assert.equal(factsDigest(change.facts), canonicalDigest(p.facts, 'contexture.facts/v1'));
});

test('bootstrap owns no revision-zero forest; strict exact seed transition', () => {
  const base = new UnseededState('g'),
    seed = definition(),
    candidate = BootstrapCandidate.own(seed);
  assert.equal(base.definitionDigest, canonicalDigest(null, 'contexture.graph/v1'));
  const event = bootstrapEvent(base, candidate, { ...options, approvalRef: 'approved' });
  const after = applyEvent(base, canonicalJSON(event), { tombstones: [] });
  assert.equal(after.revision, '1');
  assert.equal(after.definitionDigest, seed.digest());
  for (const patch of [
    { result_revision: '2' },
    { before_digest: seed.digest() },
    { graph_id: 'other' },
    { migration: { kind: 'bootstrap', approval_ref: 'approved', source_digest: seed.digest() } },
    {
      resolved_facts: [
        {
          type: 'GraphSeeded',
          before: null,
          after: { ...(seed.asJSON() as Wire), extensions: undefined },
        },
      ],
    },
  ])
    reject(() => applyEvent(base, { ...event, ...patch }, { tombstones: [] }));
  reject(() => applyEvent(base, event, { tombstones: [{}] }));
  reject(() => new RevisionState(seed, '0'));
  reject(() => BootstrapCandidate.own({} as GraphDefinition));
});

test('native endpoint no-op keeps revision and retained evidence; cannot invent change revision', () => {
  const base = new PureRevisionState(definition(), '7');
  const { p, change, event } = native(base, [
    { op: 'rename_node', node_id: 'a', new_name: 'temporary' },
    { op: 'rename_node', node_id: 'a', new_name: 'a' },
  ]);
  assert.ok(change.noop);
  assert.ok(p.noop);
  assert.equal(event.type, 'CommandCompleted');
  assert.equal(applyEvent(base, event, { tombstones: [] }).revision, '7');
  for (const patch of [
    { status: 'ok' },
    { revision: '8' },
    { graph_id: 'other' },
    { reason: 'extra' },
    { command_digest: 'bad' },
  ])
    reject(() => applyEvent(base, { ...event, ...patch }, { tombstones: [] }));
  reject(() =>
    applyFacts(base, [], {
      tombstones: [],
      revision: '8',
      beforeDigest: base.definitionDigest,
      afterDigest: base.definitionDigest,
    }),
  );
});

test('native deletion then native historical restoration retains exact identity tombstone', () => {
  const base = new PureRevisionState(definition(), '7');
  const erased = native(base, [deletion]);
  const removed = applyEvent(base, erased.event, { tombstones: erased.p.tombstones });
  assert.equal(removed.definition.nodes.a, undefined);
  assert.equal(removed.tombstones[0]!.deleted_revision, '8');
  const next = new PureRevisionState(removed.definition, removed.revision, removed.tombstones);
  const p = prepare(
    next,
    request(next, [
      { op: 'restore_nodes', revision: '7', node_ids: ['a'] },
      {
        op: 'attach_node',
        node_id: 'a',
        target: { parent_id: 'r', slot: 'children', position: 0 },
      },
    ]),
    { history: [base] },
  );
  const change = resolveFacts(next, p.candidate);
  assert.deepEqual(change.facts, p.facts);
  assert.equal(change.facts[0]!.type, 'NodeRestored');
  const restored = applyEvent(next, changeEvent(next, change, options), {
    tombstones: p.tombstones,
  });
  assert.equal(restored.definitionDigest, base.definitionDigest);
  assert.deepEqual(restored.tombstones, removed.tombstones);
  reject(() => applyEvent(base, erased.event, { tombstones: [] }));
  reject(
    () => new RevisionState(base.definition, '9', [{ ...removed.tombstones[0], mutable: false }]),
  );
  const changed = definition({
    nodes: [
      node('r', { mutable: true, members: { children: ['a', 'b'] } }),
      node('a', { mutable: false }),
      node('b'),
    ],
  });
  reject(() => resolveFacts(removed, changed));
});

test('complete normalized facts reject duplicates, omission, reordering and poisoned before values', () => {
  const base = new PureRevisionState(definition(), '7');
  const { p, event } = native(base, [
    { op: 'rename_node', node_id: 'a', new_name: 'renamed' },
    { op: 'add_use', source_id: 'a', target_id: 'b' },
  ]);
  const f = p.facts;
  for (const facts of [
    [...f].reverse(),
    [f[0]],
    [...f, f[0]],
    [{ ...f[0], before: { name: { present: true, value: 'wrong' } } }, f[1]],
    [{ ...f[0], extra: true }, f[1]],
    [{ ...f[0], after: { name: { present: false, value: 'illegal' } } }, f[1]],
    [{ type: 'FutureRequiredFact' }],
  ])
    reject(() => applyEvent(base, { ...event, resolved_facts: facts }, { tombstones: [] }));
  for (const patch of [
    { base_revision: '6' },
    { result_revision: '9' },
    { after_digest: base.definitionDigest },
    { before_digest: p.candidate.digest() },
    { semantic_version: '2' },
    { type: 'FutureEvent' },
    { command_digest: commandDigest + '\n' },
  ])
    reject(() => applyEvent(base, { ...event, ...patch }, { tombstones: [] }));
  reject(() =>
    applyFacts(base, f, {
      tombstones: [],
      revision: '8',
      beforeDigest: base.definitionDigest,
      afterDigest: p.candidate.digest(),
      resolvedFactDigest: commandDigest,
    }),
  );
  assert.equal(base.definition.nodes.a!.name, 'a');
});

test('closed fact/event/batch decoders reject unknown keys, unsafe raw integers and unknown events', () => {
  const base = new PureRevisionState(definition(), '7'),
    { event } = native(base, [{ op: 'rename_node', node_id: 'a', new_name: 'renamed' }]);
  for (const value of [
    [{ type: 'GraphSeeded', before: null, after: {}, extra: 1 }],
    [
      {
        type: 'NodeFieldsSet',
        node_id: 'a',
        before: { name: { present: false, value: null } },
        after: {},
      },
    ],
    [{ type: 'Future' }],
  ])
    reject(() => decodeResolvedFacts(value));
  reject(() => decodeGraphEvent({ ...event, extra: 1 }));
  reject(() =>
    decodeEventRecords([{ journal_seq: '1', event: { type: 'ReleaseActivated' }, tombstones: [] }]),
  );
  reject(() =>
    decodeEventRecords(
      new TextEncoder().encode('[{"journal_seq":"1","event":9007199254740993,"tombstones":[]}]'),
    ),
  );
  reject(() => decodeEventRecords([{ journal_seq: '1', event, tombstones: [], extra: true }]));
  reject(() => decodeEventRecords([{ journal_seq: '0', event, tombstones: [] }]));
  let invoked = 0;
  const bad = {
    get type() {
      invoked++;
      return 'CommandCompleted';
    },
  };
  reject(() => decodeGraphEvent(bad));
  assert.equal(invoked, 0);
});

test('graph-local batches allow store gaps but require increasing sequence and atomic detached output', () => {
  const base = new UnseededState('g'),
    seed = bootstrapEvent(base, definition(), { ...options, approvalRef: 'approved' });
  const first = applyEvent(base, seed, { tombstones: [] });
  const next = new PureRevisionState(first.definition, '1');
  const { event, p } = native(next, [{ op: 'rename_node', node_id: 'a', new_name: 'new' }]);
  const records = [
    { journal_seq: '5', event: seed, tombstones: [] },
    { journal_seq: '9', event, tombstones: p.tombstones },
  ];
  const result = applyEventRecords(base, canonicalJSON(records));
  assert.equal(result.journalSeq, '9');
  assert.equal(result.state.revision, '2');
  assert.equal(result.state.definitionDigest, p.candidate.digest());
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(decodeEventRecords(records)[0]!.event));
  reject(() => applyEventRecords(base, [records[0], { ...records[1], journal_seq: '5' }]));
  reject(() => applyEventRecords(base, records, { afterSeq: '6' }));
  reject(() => applyEventRecords(base, []));
  reject(() =>
    applyEventRecords(base, [
      records[0],
      { ...records[1], event: { ...event, after_digest: first.definitionDigest } },
    ]),
  );
  assert.equal(base.revision, '0');
  assert.equal(first.definition.nodes.a!.name, 'a');
});

test('publication shifts and full presentation order replay native final permutation', () => {
  const prompt = (id: string, target: string) => ({
    kind: 'prompt',
    publication_id: id,
    name: id,
    description: id,
    opens_id: target,
    model_may_open: true,
  });
  const base = new PureRevisionState(
    definition({ publications: [prompt('pa', 'a'), prompt('pb', 'b')] }),
    '7',
  );
  const { event, p } = native(base, [
    { op: 'remove_publication', publication_id: 'pa' },
    { op: 'put_presentation', locale: 'fr', presentation: { node_id: 'a', title: 'Bonjour' } },
  ]);
  const after = applyEvent(base, event, { tombstones: p.tombstones });
  assert.equal(after.definitionDigest, p.candidate.digest());
  assert.ok(p.facts.some((f) => f.type === 'PublicationPut' && f.position === 0));
  const bad = p.facts.map((f) => (f.type === 'PublicationPut' ? { ...f, position: 1 } : f));
  reject(() => applyEvent(base, { ...event, resolved_facts: bad }, { tombstones: [] }));
});

test('replay bypasses protection, does not resolve latest bindings and rejects ordinary policy mutation', () => {
  const base = new RevisionState(definition({ nodes: [node('r', { mutable: false })] }), '7');
  const raw = base.definition.asJSON() as Wire;
  const nodes = raw.nodes as Wire[];
  nodes[0]!.description = 'trusted accepted edit';
  const change = resolveFacts(base, GraphDefinition.fromJSON(raw));
  const after = applyEvent(base, changeEvent(base, change, options), { tombstones: [] });
  assert.equal(after.definition.nodes.r!.description, 'trusted accepted edit');
  nodes[0]!.mutable = true;
  reject(() => resolveFacts(base, GraphDefinition.fromJSON(raw)));
  const source = readFileSync(new URL('../src/core/graph/events.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /from ['"].*(?:transactions|policy|registry|runtime|storage|node:fs)/u,
  );
  const tool = GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'g',
    application_name: 'app',
    mode: 'runtime',
    nodes: [
      {
        node_id: 't',
        kind: 'tool',
        name: 'tool',
        description: 'tool',
        binding: {
          kind: 'registered',
          binding_id: 'unresolved',
          version: 'latest',
          portability: {
            kind: 'native',
            language: 'typescript',
            version: '1',
            factory: 'never-invoke',
          },
        },
      },
    ],
    roots: [{ node_id: 't', plane: 'model' }],
    presentations: { default_locale: 'en', catalogs: [] },
  });
  const b = new RevisionState(tool, '1'),
    wire = tool.asJSON() as Wire;
  (wire.nodes as Wire[])[0]!.description = 'changed';
  const c = resolveFacts(b, GraphDefinition.fromJSON(wire));
  assert.equal(
    applyEvent(b, changeEvent(b, c, options), { tombstones: [] }).definitionDigest,
    c.candidate.digest(),
  );
});

test('migration requires exact diff, source partition and matching provenance; not authorization', () => {
  const base = new RevisionState(definition(), '7'),
    wire = base.definition.asJSON() as Wire;
  (wire.nodes as Wire[]).find((n) => n.node_id === 'a')!.mutable = false;
  const candidate = GraphDefinition.fromJSON(wire),
    mapping = { retained_ids: ['a', 'b', 'r'], new_ids: [], deleted_ids: [] },
    exactDiff = definitionDiff(base.definition, candidate).asJSON();
  const change = resolveMigration(base, candidate, {
    migrationID: 'migration',
    exactDiff,
    sourceMapping: mapping,
  });
  const migration = {
    kind: 'migration',
    approval_ref: 'approval',
    source_digest: base.definitionDigest,
    migration_id: 'migration',
    exact_diff: exactDiff,
  };
  const event = changeEvent(base, change, { ...options, migration });
  assert.equal(applyEvent(base, event, { tombstones: [] }).definitionDigest, candidate.digest());
  reject(() =>
    applyEvent(base, { ...event, migration: { ...migration, exact_diff: {} } }, { tombstones: [] }),
  );
  reject(() => applyEvent(base, { ...event, migration: undefined }, { tombstones: [] }));
  reject(() =>
    resolveMigration(base, candidate, {
      migrationID: 'migration',
      exactDiff,
      sourceMapping: { ...mapping, new_ids: ['a'] },
    }),
  );
});

test('revision exhaustion refuses real change but permits no-op at maximum', () => {
  const base = new RevisionState(definition(), String(MAX_COUNTER));
  assert.equal(
    changeEvent(base, resolveFacts(base, base.definition), options).type,
    'CommandCompleted',
  );
  const wire = base.definition.asJSON() as Wire;
  wire.application_name = 'changed';
  const change = resolveFacts(base, GraphDefinition.fromJSON(wire));
  reject(() => changeEvent(base, change, options), 'limit_exceeded');
});
