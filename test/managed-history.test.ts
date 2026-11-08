import assert from 'node:assert/strict';
import test from 'node:test';
import { List } from 'immutable';
import { GraphError, canonicalDigest } from '../src/core/graph/canonical.js';
import {
  behaviorDiff,
  definitionDiff,
  executionDiff,
  surfaceDiff,
} from '../src/core/graph/diff.js';
import {
  applyEvent,
  bootstrapEvent,
  changeEvent,
  resolveFacts,
  RevisionState,
  UnseededState,
} from '../src/core/graph/events.js';
import { History, RevisionRecord, revertCandidate } from '../src/core/graph/history.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import { prepare, PureRevisionState } from '../src/core/graph/transactions.js';

type Wire = Record<string, unknown>;
const options = { commandDigest: canonicalDigest({}, 'contexture.command/v1'), reason: 'test' };
function definition(): GraphDefinition {
  return GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'g',
    application_name: 'app',
    mode: 'disclosure_only',
    nodes: [
      {
        node_id: 'r',
        kind: 'role',
        name: 'root',
        description: 'root',
        mutable: true,
        instructions: '',
        members: { children: ['a', 'b'] },
      },
      ...['a', 'b'].map((id) => ({
        node_id: id,
        kind: 'role',
        name: id,
        description: id,
        instructions: '',
      })),
    ],
    roots: [{ node_id: 'r', plane: 'model' }],
    publications: [
      {
        kind: 'prompt',
        publication_id: 'pa',
        opens_id: 'a',
        name: 'prompt',
        description: 'prompt',
        model_may_open: true,
      },
    ],
    presentations: { default_locale: 'en', catalogs: [] },
  });
}
function native(base: RevisionState, commands: unknown[]) {
  const p = prepare(new PureRevisionState(base.definition, base.revision, base.tombstones), {
    schema: 'contexture.transaction/v1',
    graph_id: 'g',
    base_revision: base.revision,
    idempotency_key: 'key',
    correlation_id: 'correlation',
    reason: 'test',
    commands,
  });
  const change = resolveFacts(base, p.candidate);
  assert.deepEqual(change.facts, p.facts);
  return { event: changeEvent(base, change, options), tombstones: p.tombstones };
}
function reject(fn: () => unknown, code?: string): void {
  assert.throws(
    fn,
    (e: unknown) => e instanceof GraphError && (code === undefined || String(e.code) === code),
  );
}

test('append validates only the new link and public construction still validates the full prefix', () => {
  const state = new RevisionState(definition(), '12');
  const original = History.seed(state, { journalSeq: '1' });
  const event = changeEvent(state, resolveFacts(state, state.definition), options);
  let visitedRecords = 0;
  const some = Array.prototype.some;
  Array.prototype.some = function (
    this: unknown[],
    predicate: (value: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return some.call(this, (value: unknown, index: number, array: unknown[]) => {
      if (value instanceof RevisionRecord) visitedRecords++;
      return predicate.call(thisArg, value, index, array);
    });
  };
  try {
    let history = original;
    for (let i = 2; i <= 101; i++)
      history = history.append(event, { journalSeq: String(i), tombstones: [] });
    assert.equal(visitedRecords, 0);
    assert.equal(original.records.length, 1);
    assert.equal(original.head.revision, '12');
    assert.equal(new History(history.records).records.length, 101);
    assert.equal(visitedRecords, 101);
    reject(() => new History([history.records[1]!, history.records[0]!]));
  } finally {
    Array.prototype.some = some;
  }
});

test('append refuses forged prefix and records despite frozen prototype-shaped objects', () => {
  const state = new RevisionState(definition(), '12');
  const original = History.seed(state, { journalSeq: '1' });
  const event = changeEvent(state, resolveFacts(state, state.definition), options);
  const forged = Object.freeze(
    Object.create(History.prototype, { records: { value: original.records } }),
  ) as History;
  reject(() => forged.append(event, { journalSeq: '2', tombstones: [] }), 'schema_invalid');
  const fakeRecord = Object.freeze(
    Object.create(RevisionRecord.prototype, {
      journalSeq: { value: '1' },
      state: { value: state },
      event: { value: null },
    }),
  ) as RevisionRecord;
  reject(() => new History([fakeRecord]), 'schema_invalid');
});

test('persistent history append/head/at do not materialize public arrays', () => {
  const state = new RevisionState(definition(), '12');
  const original = History.seed(state, { journalSeq: '1' });
  const event = changeEvent(state, resolveFacts(state, state.definition), options);
  let materializations = 0;
  const toArray = List.prototype.toArray;
  List.prototype.toArray = function (this: List<RevisionRecord>) {
    materializations++;
    return toArray.call(this);
  };
  try {
    let history = original;
    for (let sequence = 2; sequence <= 1001; sequence++)
      history = history.append(event, { journalSeq: String(sequence), tombstones: [] });
    assert.equal(history.head.revision, '12');
    assert.equal(history.at('12'), history.head);
    assert.equal(history.retainedLowerBound, '12');
    assert.equal(materializations, 0);
    assert.equal(original.records.length, 1);
    const records = history.records;
    assert.equal(records.length, 1001);
    assert.ok(Object.isFrozen(records));
    assert.equal(history.records, records);
    assert.equal(materializations, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(history)).records.length, 1001);
    assert.equal(materializations, 1);
  } finally {
    List.prototype.toArray = toArray;
  }
});

test('history bootstrap, append and no-op retain immutable records and noncontiguous store sequences', () => {
  const base = new UnseededState('g'),
    event = bootstrapEvent(base, definition(), { ...options, approvalRef: 'approval' });
  const original = History.bootstrap(base, event, { journalSeq: '3' }),
    rename = native(original.head, [{ op: 'rename_node', node_id: 'a', new_name: 'renamed' }]);
  const next = original.append(rename.event, { ...rename, journalSeq: '9' });
  const noop = changeEvent(next.head, resolveFacts(next.head, next.head.definition), options);
  const last = next.append(noop, { journalSeq: '11', tombstones: [] });
  assert.equal(original.head.revision, '1');
  assert.equal(next.head.revision, '2');
  assert.equal(last.head.revision, '2');
  assert.equal(last.records.length, 3);
  assert.equal(last.at('2'), last.head);
  assert.equal(last.retainedLowerBound, '1');
  assert.equal(last.records[0]!.event!.type, 'GraphChangeCommitted');
  assert.ok(Object.isFrozen(last.records));
  assert.ok(Object.isFrozen(last.records[1]!.event));
  reject(() => last.at('0'), 'history_unavailable');
  reject(() => last.append(noop, { journalSeq: '10', tombstones: [] }));
  const seed = History.seed(new RevisionState(definition(), '8'), { journalSeq: '20' });
  assert.equal(seed.retainedLowerBound, '8');
  reject(() => seed.at('7'), 'history_unavailable');
});

test('exact diff separates field, whole relation/root order, ordered publications and presentations', () => {
  const base = new RevisionState(definition(), '7');
  const change = native(base, [
    { op: 'rename_node', node_id: 'a', new_name: 'new' },
    { op: 'reorder_members', parent_id: 'r', slot: 'children', node_ids: ['b', 'a'] },
    { op: 'add_use', source_id: 'a', target_id: 'b' },
    { op: 'put_presentation', locale: 'fr', presentation: { node_id: 'a', title: 'Bonjour' } },
  ]);
  const after = applyEvent(base, change.event, { tombstones: change.tombstones }),
    diff = definitionDiff(base.definition, after.definition);
  const av = base.definition.nodes.a!,
    bv = after.definition.nodes.a!;
  assert.deepEqual(diff.asJSON(), {
    nodes: [
      {
        id: 'a',
        field: '/name',
        before: { present: true, value: av.name },
        after: { present: true, value: bv.name },
      },
    ],
    membership: [
      {
        id: 'r',
        field: '/members',
        before: { present: true, value: (base.definition.nodes.r as unknown as Wire).members },
        after: { present: true, value: (after.definition.nodes.r as unknown as Wire).members },
      },
    ],
    uses: [
      {
        id: 'a',
        field: '/uses',
        before: { present: true, value: [] },
        after: { present: true, value: ['b'] },
      },
    ],
    publications: [],
    locales: [
      {
        id: 'g',
        field: '/presentations',
        before: { present: true, value: base.definition.presentations },
        after: { present: true, value: after.definition.presentations },
      },
    ],
  });
  assert.ok(!diff.empty);
  assert.ok(definitionDiff(base.definition, base.definition).empty);
  const copy = diff.asJSON();
  (copy.nodes as Wire[]).length = 0;
  assert.equal((diff.asJSON().nodes as unknown[]).length, 1);
  const h = History.seed(base, { journalSeq: '1' }).append(change.event, {
    journalSeq: '2',
    tombstones: [],
  });
  assert.deepEqual(h.diff('7', '8').asJSON(), diff.asJSON());
});

test('node history includes placement ordinal, locale default and publications; publication history tracks shifts', () => {
  let history = History.seed(new RevisionState(definition(), '1'), { journalSeq: '1' });
  const reorder = native(history.head, [
    { op: 'reorder_members', parent_id: 'r', slot: 'children', node_ids: ['b', 'a'] },
  ]);
  history = history.append(reorder.event, { journalSeq: '3', tombstones: [] });
  assert.equal(history.forNode('a').length, 1);
  assert.equal(history.forNode('b').length, 1);
  assert.equal(history.forPublication('pa').length, 0);
  const wire = history.head.definition.asJSON() as Wire;
  (wire.presentations as Wire).default_locale = 'fr';
  const event = changeEvent(
    history.head,
    resolveFacts(history.head, GraphDefinition.fromJSON(wire)),
    options,
  );
  history = history.append(event, { journalSeq: '5', tombstones: [] });
  assert.equal(history.forNode('a').length, 2);
  assert.equal(history.forNode('absent').length, 1);
  const remove = native(history.head, [{ op: 'remove_publication', publication_id: 'pa' }]);
  history = history.append(remove.event, { journalSeq: '8', tombstones: [] });
  assert.equal(history.forPublication('pa').length, 1);
  assert.equal(history.forNode('a').length, 3);
  assert.equal(history.forNode('r').length, 2);
});

test('whole and scoped revert propose new facts, preserve current tombstones and never rewind head', () => {
  const target = new RevisionState(definition(), '7');
  const rename = native(target, [
    { op: 'rename_node', node_id: 'a', new_name: 'changed' },
    { op: 'rename_node', node_id: 'b', new_name: 'unrelated' },
  ]);
  const head = applyEvent(target, rename.event, { tombstones: [] });
  const scoped = revertCandidate(head, target, { nodeIDs: ['a'] });
  assert.equal(scoped.change.candidate.nodes.a!.name, 'a');
  assert.equal(scoped.change.candidate.nodes.b!.name, 'unrelated');
  assert.equal(head.definition.nodes.a!.name, 'changed');
  const all = revertCandidate(head, target);
  assert.equal(all.change.candidate.digest(), target.definitionDigest);
  assert.equal(all.baseRevision, '8');
  assert.equal(all.targetRevision, '7');
  reject(() => revertCandidate(head, target, { nodeIDs: ['a', 'a'] }));
  reject(() => revertCandidate(head, target, { nodeIDs: ['missing'] }), 'reference_not_found');
  reject(() => revertCandidate(target, head), 'history_unavailable');
});

test('revert resurrection requires retained identity evidence and emits restoration not creation', () => {
  const target = new RevisionState(definition(), '7');
  const p = native(target, [
    { op: 'remove_publication', publication_id: 'pa' },
    {
      op: 'delete_nodes',
      targets: ['a'],
      deleted_ids: ['a'],
      policy: 'reject_references',
      disconnections: [{ source_id: 'r', target_id: 'a', relation: 'containment' }],
    },
  ]);
  const base = applyEvent(target, p.event, { tombstones: p.tombstones });
  const revert = revertCandidate(base, target);
  assert.equal(revert.change.facts[0]!.type, 'NodeRestored');
  assert.deepEqual(revert.change.tombstones, base.tombstones);
  reject(
    () => revertCandidate(new RevisionState(base.definition, '8'), target),
    'history_unavailable',
  );
  reject(() => revertCandidate(base, target, { nodeIDs: ['a'] }));
});

test('definition additions/removals use absent OptionalValue and publication group retains order', () => {
  const base = definition(),
    wire = base.asJSON() as Wire;
  const pubs = wire.publications as Wire[];
  pubs.push({ ...pubs[0], publication_id: 'pb', name: 'pb', opens_id: 'b' });
  const added = GraphDefinition.fromJSON(wire);
  const d = definitionDiff(base, added).asJSON();
  assert.equal((d.publications as Wire[]).length, 2);
  assert.deepEqual((d.publications as Wire[]).find((e) => e.id === 'pb')!.before, {
    present: false,
  });
  pubs.reverse();
  const reversed = GraphDefinition.fromJSON(wire);
  assert.equal((definitionDiff(added, reversed).asJSON().publications as Wire[]).length, 1);
  wire.graph_id = 'other';
  reject(() => definitionDiff(base, GraphDefinition.fromJSON(wire)));
});

test('behavior/surface/execution diffs require supplied normalized projections, not graph-text inference', () => {
  for (const [fn, kind] of [
    [behaviorDiff, 'behavior'],
    [surfaceDiff, 'surface'],
    [executionDiff, 'execution'],
  ] as const) {
    const raw = { ordered: ['a', 'b'] },
      diff = fn(raw, { ordered: ['b', 'a'] });
    raw.ordered.reverse();
    assert.equal(diff.kind, kind);
    assert.equal(diff.equal, false);
    assert.deepEqual(diff.before, { ordered: ['a', 'b'] });
    assert.ok(Object.isFrozen(diff));
    reject(() => fn([], {}));
    reject(() => fn({}, null));
    assert.equal(fn({ a: 1 }, { a: 1 }).equal, true);
  }
});
