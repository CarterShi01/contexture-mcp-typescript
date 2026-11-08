import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDigest, freezeJSON, GraphError } from '../src/core/graph/canonical.js';
import type { JSONObject } from '../src/core/graph/model.js';
import {
  ReleaseRequest,
  emptyReleaseState,
  importReleaseState,
  reduceReleaseEvent,
  replayReleases,
} from '../src/managed-releases.js';
import { nativeReleaseFixture } from './managed-release-fixtures.js';

const uuid = '11111111-1111-1111-1111-111111111111';
function record(
  seq: string,
  events: readonly unknown[],
  extra: Record<string, unknown> = {},
): JSONObject {
  const payload = { events, ...extra };
  const subject = {
    schema: 'contexture.journal-record/v1',
    journal_seq: seq,
    actor_ref: 'actor',
    ...payload,
    payload_digest: canonicalDigest(payload, 'contexture.journal-payload/v1'),
  };
  return freezeJSON({
    ...subject,
    record_hash: canonicalDigest(subject, 'contexture.journal-record/v1'),
  }) as JSONObject;
}

test('release subject uses existing command domain and excludes key/approval only', () => {
  const f = nativeReleaseFixture(),
    request = ReleaseRequest.fromJSON(f.request());
  assert.equal(request.digest(), canonicalDigest(request.subject(), 'contexture.command/v1'));
  assert.equal(
    request.digest(),
    ReleaseRequest.fromJSON(
      f.request({ idempotency_key: 'other', approval_ref: 'other' }),
    ).digest(),
  );
  assert.notEqual(
    request.digest(),
    ReleaseRequest.fromJSON(f.request({ policy: 'latest' })).digest(),
  );
  for (const changed of [
    { schema: 'other' },
    { revision: '0' },
    { expected_desired_epoch: '-1' },
    { unknown: true },
    { manifest_digest: f.request().manifest_digest + '\n' },
  ])
    assert.throws(() => ReleaseRequest.fromJSON(f.request(changed)), GraphError);
});

test('pure release replay preserves desired CAS, supersession, terminal history and old boots', () => {
  const f = nativeReleaseFixture(),
    first = f.request();
  const requested = { type: 'ReleaseRequested', request: first, release_epoch: '1' };
  const release = { graph_id: 'graph', target_id: 'target', release_epoch: '1' };
  const attempt = { release, instance_id: 'instance', boot_id: uuid, attempt_id: 'attempt' };
  const ready = {
    type: 'ReleasePreparationSucceeded',
    attempt,
    generation_id: uuid,
    manifest_digest: first.manifest_digest,
  };
  const observed = {
    type: 'ReplicaObserved',
    observation: {
      release,
      instance_id: 'instance',
      boot_id: uuid,
      generation_id: uuid,
      revision: '1',
      definition_digest: first.definition_digest,
      manifest_digest: first.manifest_digest,
      observed_at: '2026-11-07T00:00:00Z',
    },
  };
  const records = [
    record('1', [requested]),
    record('2', [ready]),
    record('3', [observed]),
    record('4', [
      { type: 'ReleaseSuperseded', release, superseded_by: '2' },
      {
        type: 'ReleaseRequested',
        request: f.request({
          expected_desired_epoch: '1',
          idempotency_key: 'next',
          policy: 'latest',
        }),
        release_epoch: '2',
      },
    ]),
  ];
  const state = replayReleases(records);
  assert.equal(state.desired_releases[0]?.release_epoch, '2');
  assert.deepEqual(
    state.release_operations.map((op) => op.status),
    ['requested', 'superseded', 'requested'],
  );
  assert.equal(state.prepare_attempt_history[0]?.status, 'ready');
  assert.equal(state.observations_history.length, 1);
  assert.deepEqual(importReleaseState(state), state);
  assert.equal(f.counts().handlers + f.counts().decoders + f.counts().nativeValidators, 0);
  assert.throws(() => reduceReleaseEvent(state, ready, record('5', [ready])), GraphError);
  assert.throws(
    () => reduceReleaseEvent(emptyReleaseState(), ready, record('1', [ready])),
    GraphError,
  );
  assert.throws(
    () => replayReleases([record('1', [{ ...requested, release_epoch: '2' }])]),
    GraphError,
  );
});

test('receipt evidence and journal hash provenance cannot be transplanted or silently repaired', () => {
  const f = nativeReleaseFixture(),
    request = ReleaseRequest.fromJSON(f.request());
  const event = { type: 'ReleaseRequested', request: request.asJSON(), release_epoch: '1' };
  const releaseReceipt = {
    schema: 'contexture.release-receipt/v1',
    release: { graph_id: 'graph', target_id: 'target', release_epoch: '1' },
    journal_seq: '1',
    request_digest: request.digest(),
    status: 'requested',
  };
  const receipt = {
    schema: 'contexture.command-receipt/v1',
    graph_id: 'graph',
    actor_ref: 'actor',
    idempotency_key: 'release-key',
    request_digest: request.digest(),
    revision: '1',
    journal_seq: '1',
    status: 'committed',
    durability: 'strict',
    operation_result: { inline: releaseReceipt },
  };
  const valid = record('1', [event], { command_receipt: receipt });
  assert.equal(replayReleases([valid]).desired_releases.length, 1);
  assert.throws(
    () => replayReleases([freezeJSON({ ...valid, actor_ref: 'other' }) as JSONObject]),
    GraphError,
  );
  assert.throws(
    () =>
      replayReleases([
        record('1', [event], { command_receipt: { ...receipt, actor_ref: 'other' } }),
      ]),
    GraphError,
  );
  assert.throws(
    () =>
      replayReleases([
        record('1', [event], { command_receipt: { ...receipt, operation_result: { blob: {} } } }),
      ]),
    GraphError,
  );
  assert.throws(
    () =>
      importReleaseState({
        ...emptyReleaseState(),
        prepare_attempt_history: [
          {
            identity: {
              release: releaseReceipt.release,
              instance_id: 'i',
              boot_id: uuid,
              attempt_id: 'a',
            },
            status: 'pending',
          },
        ],
      }),
    GraphError,
  );
});
