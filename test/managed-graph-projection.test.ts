import assert from 'node:assert/strict';
import test from 'node:test';
import { List as PersistentList, Map as PersistentMap } from 'immutable';
import { GraphError, freezeJSON } from '../src/core/graph/canonical.js';
import { GraphDefinition } from '../src/core/graph/model.js';
import type { JSONObject } from '../src/core/graph/model.js';
import { RevisionState, changeEvent, resolveFacts } from '../src/core/graph/events.js';
import { PureRevisionState, prepare } from '../src/core/graph/transactions.js';
import { GraphJournalProjection, projectGraphJournal } from '../src/managed-graph.js';
import { graphFixture, signedRecords } from './managed-graph-fixtures.js';

test('suffix extension does not enumerate receipt indexes or materialize public record arrays', () => {
  const fixture = graphFixture();
  const accepted = signedRecords();
  accepted.append([fixture.seed]);
  const original = new GraphJournalProjection(accepted.records);
  let recordArrays = 0;
  let indexWalks = 0;
  const toArray = PersistentList.prototype.toArray;
  const values = PersistentMap.prototype.values;
  PersistentList.prototype.toArray = function (this: PersistentList<unknown>) {
    recordArrays++;
    return toArray.call(this);
  };
  PersistentMap.prototype.values = function (this: PersistentMap<unknown, unknown>) {
    indexWalks++;
    return values.call(this);
  };
  try {
    let current = original;
    for (let sequence = 2; sequence <= 1001; sequence++) {
      const record = accepted.append(
        [
          {
            type: 'CommandCompleted',
            graph_id: 'graph',
            revision: '1',
            command_digest: fixture.seedDigest,
            status: 'noop',
          },
        ],
        {
          schema: 'contexture.command-receipt/v1',
          graph_id: 'graph',
          actor_ref: 'tenant-actor',
          idempotency_key: `noop-${sequence}`,
          request_digest: fixture.seedDigest,
          revision: '1',
          journal_seq: String(sequence),
          status: 'noop',
          durability: 'strict',
          operation_result: { inline: null },
        },
      );
      current = current.extend([record]);
      assert.equal(current.lastRecordHash, record.record_hash);
    }
    assert.equal(recordArrays, 0);
    assert.equal(indexWalks, 0);
    assert.equal(original.watermark, '1');
    assert.equal(current.watermark, '1001');
    const checkpoint = current.checkpoint;
    assert.equal((checkpoint.receipts_index as readonly unknown[]).length, 1000);
    assert.equal(indexWalks, 2);
    assert.equal(current.checkpoint, checkpoint);
    assert.equal(indexWalks, 2);
    assert.equal(current.records.length, 1001);
    assert.equal(recordArrays, 1);
    assert.equal((original.checkpoint.receipts_index as readonly unknown[]).length, 0);
  } finally {
    PersistentList.prototype.toArray = toArray;
    PersistentMap.prototype.values = values;
  }
});

test('verified prefix extension equals full replay and rejects bad suffix without changing the prefix', () => {
  const f = graphFixture(),
    accepted = signedRecords();
  accepted.append([f.seed]);
  const first = new GraphJournalProjection(accepted.records);
  const original = first.checkpoint;
  const prepared = prepare(new PureRevisionState(f.definition, '1'), f.transaction());
  accepted.append([
    changeEvent(
      new RevisionState(f.definition, '1'),
      resolveFacts(new RevisionState(f.definition, '1'), prepared.candidate),
      { commandDigest: prepared.envelope.commandDigest, reason: 'native edit' },
    ),
  ]);
  const suffix = accepted.records.slice(1);
  const extended = first.extend(suffix);
  assert.deepEqual(extended.checkpoint, new GraphJournalProjection(accepted.records).checkpoint);
  assert.deepEqual(extended.records, accepted.records);
  assert.equal(extended.history('graph').head.revision, '2');
  assert.equal(first.history('graph').head.revision, '1');
  assert.deepEqual(first.checkpoint, original);
  assert.deepEqual(first.extend([]).checkpoint, first.checkpoint);
  assert.throws(() => first.extend([{ ...suffix[0], actor_ref: 'tampered' }]), GraphError);
  assert.throws(() => first.extend(accepted.records), GraphError);
  assert.deepEqual(first.checkpoint, original);
  assert.deepEqual(first.extend(suffix).checkpoint, extended.checkpoint);
});

test('complete same-Journal graph replay gives exact immutable history/checkpoint without Host callbacks', () => {
  const f = graphFixture(),
    accepted = signedRecords();
  accepted.append([f.seed]);
  const prepared = prepare(new PureRevisionState(f.definition, '1'), f.transaction());
  const base = new RevisionState(f.definition, '1'),
    change = resolveFacts(base, prepared.candidate);
  assert.deepEqual(change.facts, prepared.facts);
  assert.deepEqual(change.tombstones, prepared.tombstones);
  accepted.append([
    changeEvent(base, change, {
      commandDigest: prepared.envelope.commandDigest,
      reason: 'native edit',
    }),
  ]);
  const projection = new GraphJournalProjection(accepted.records);
  assert.equal(projection.history('graph').head.revision, '2');
  assert.equal(projection.history('graph').at('1').definition.nodes.root?.description, 'original');
  assert.equal(projection.history('graph').at('2').definition.nodes.root?.description, 'changed');
  assert(Object.isFrozen(projection.history('graph').head));
  assert(Object.isFrozen(projection.checkpoint));
  assert.deepEqual(
    Object.keys(projection.checkpoint).sort(),
    [
      'blob_refs',
      'desired_releases',
      'graphs',
      'observations_history',
      'prepare_attempt_history',
      'projection_versions',
      'receipts_index',
      'release_operations',
    ].sort(),
  );
  assert.deepEqual(projectGraphJournal(accepted.records), projection.checkpoint);
  assert.deepEqual(f.counts(), { currentCalls: 0, approvalCalls: 0, decisions: 0 });
});

test('a signed suffix cannot attach a receipt for another accepted graph result', () => {
  const f = graphFixture();
  const receipt = {
    schema: 'contexture.command-receipt/v1',
    graph_id: 'graph',
    actor_ref: 'tenant-actor',
    idempotency_key: 'seed',
    request_digest: f.seedDigest,
    revision: '1',
    journal_seq: '1',
    status: 'committed',
    durability: 'strict',
    operation_result: { inline: {} },
  };
  for (const changed of [{ revision: '2' }, { graph_id: 'other' }, { status: 'noop' }]) {
    const accepted = signedRecords();
    accepted.append([f.seed], { ...receipt, ...changed });
    assert.throws(() => new GraphJournalProjection(accepted.records), GraphError);
    assert.throws(() => new GraphJournalProjection([]).extend(accepted.records), GraphError);
  }
});

test('tombstones and history-backed restore reuse the existing ordinary/event kernels', () => {
  const f = graphFixture(),
    accepted = signedRecords();
  accepted.append([f.seed]);
  const deleted = prepare(
    new PureRevisionState(f.definition, '1'),
    f.transaction({
      commands: [
        {
          op: 'delete_nodes',
          targets: ['tool'],
          deleted_ids: ['tool'],
          policy: 'reject_references',
          disconnections: [{ source_id: 'root', target_id: 'tool', relation: 'containment' }],
        },
      ],
    }),
  );
  const change = resolveFacts(new RevisionState(f.definition, '1'), deleted.candidate);
  accepted.append([
    changeEvent(new RevisionState(f.definition, '1'), change, {
      commandDigest: deleted.envelope.commandDigest,
      reason: 'delete tool',
    }),
  ]);
  const projection = new GraphJournalProjection(accepted.records),
    deletedState = projection.history('graph').head;
  assert.equal(deletedState.tombstones[0]?.node_id, 'tool');
  const restored = prepare(
    new PureRevisionState(deletedState.definition, '2', deletedState.tombstones),
    f.transaction({
      base_revision: '2',
      commands: [
        { op: 'restore_nodes', node_ids: ['tool'], revision: '1' },
        {
          op: 'attach_node',
          node_id: 'tool',
          target: { parent_id: 'root', slot: 'tools', position: 0 },
        },
      ],
    }),
    { history: [new PureRevisionState(f.definition, '1')] },
  );
  const restore = resolveFacts(deletedState, restored.candidate);
  assert.deepEqual(restore.tombstones, restored.tombstones);
  accepted.append([
    changeEvent(deletedState, restore, {
      commandDigest: restored.envelope.commandDigest,
      reason: 'restore tool',
    }),
  ]);
  const head = new GraphJournalProjection(accepted.records).history('graph').head;
  assert.equal(head.revision, '3');
  assert.equal(head.definition.nodes.tool?.kind, 'tool');
  assert.equal(head.tombstones[0]?.node_id, 'tool');
});

test('chain/store/header/batch corruption and unregistered facts refuse, not empty-project', () => {
  const f = graphFixture(),
    accepted = signedRecords();
  accepted.append([f.seed]);
  assert.throws(
    () => new GraphJournalProjection([freezeJSON({ ...accepted.records[0], actor_ref: 'other' })]),
    GraphError,
  );
  assert.throws(() => new GraphJournalProjection([{}]), GraphError);
  const unknown = signedRecords();
  unknown.append([{ type: 'InventedAcceptedEvent' }]);
  assert.throws(() => new GraphJournalProjection(unknown.records), {
    code: 'unsupported_contract',
  });
  const unseeded = signedRecords();
  unseeded.append([
    {
      type: 'CommandCompleted',
      graph_id: 'graph',
      revision: '0',
      command_digest: f.seedDigest,
      status: 'noop',
    },
  ]);
  assert.throws(() => new GraphJournalProjection(unseeded.records), GraphError);
  assert.deepEqual(projectGraphJournal([]).graphs, []);
});

test('same-record multiple graph transitions expose the existing History contract gap explicitly', () => {
  const f = graphFixture(),
    accepted = signedRecords();
  const raw = f.definition.asJSON() as JSONObject;
  const next = GraphDefinition.fromJSON({ ...raw, application_name: 'later' });
  const transition = changeEvent(
    new RevisionState(f.definition, '1'),
    resolveFacts(new RevisionState(f.definition, '1'), next),
    {
      commandDigest: f.seedDigest,
      reason: 'second accepted revision',
    },
  );
  accepted.append([f.seed, transition]);
  assert.throws(() => new GraphJournalProjection(accepted.records), {
    code: 'unsupported_contract',
  });
});
