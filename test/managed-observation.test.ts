import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphError, RevisionState } from '../src/managed.js';
import { LocalServingCoordinator } from '../src/application/managed-serving.js';
import { barrier, nativeReleaseFixture } from './managed-release-fixtures.js';

test('optional observation hook runs after adoption, backpressures swaps, and never rolls back the pointer', async () => {
  const f = nativeReleaseFixture();
  let fail = true,
    observations = 0;
  const coordinator: LocalServingCoordinator = new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: {
      capture: () => ({
        graph_id: 'graph',
        target_id: 'target',
        release_epoch: '1',
        journal_seq: '2',
        snapshot: new RevisionState(f.definition, '1'),
        manifest_digest: f.plan.manifest.manifestDigest,
      }),
      fence: (_attempt, _ready, adopt) => {
        adopt();
        return true;
      },
    },
    provider: f.provider,
    observation: {
      observe(attempt): void {
        assert.equal(coordinator.current?.attempt, attempt);
        observations++;
        if (fail) throw new Error('observation unavailable');
      },
    },
  });
  try {
    assert.equal((await coordinator.prepare()).status, 'serving_unobserved');
    const active = coordinator.current;
    assert(active);
    assert.equal(active.generation.resourceState, 'prepared');
    assert.throws(() => coordinator.prepare(), GraphError);
    const lease = coordinator.lease();
    lease.resources.close();
    assert.equal(f.counts().disposals, 0);
    fail = false;
    assert.equal((await coordinator.retryObservation()).status, 'local_observed');
    assert.equal(coordinator.current, active);
    assert.equal(observations, 2);
    await coordinator.retryObservation();
    assert.equal(observations, 2);
  } finally {
    await coordinator.shutdown();
  }
  assert.throws(() => coordinator.retryObservation(), GraphError);
});

test('shutdown joins an actual in-flight observation instead of detaching its result', async () => {
  const f = nativeReleaseFixture(),
    entered = barrier<void>(),
    finish = barrier<void>();
  const coordinator = new LocalServingCoordinator({
    graphID: 'graph',
    targetID: 'target',
    instanceID: 'instance',
    authority: {
      capture: () => ({
        graph_id: 'graph',
        target_id: 'target',
        release_epoch: '1',
        journal_seq: '2',
        snapshot: new RevisionState(f.definition, '1'),
        manifest_digest: f.plan.manifest.manifestDigest,
      }),
      fence: (_attempt, _ready, adopt) => {
        adopt();
        return true;
      },
    },
    provider: f.provider,
    observation: {
      async observe() {
        entered.resolve();
        await finish.promise;
      },
    },
  });
  const preparation = coordinator.prepare();
  await entered.promise;
  const shutdown = coordinator.shutdown();
  let stopped = false;
  void shutdown.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish.resolve();
  assert.equal((await preparation).status, 'local_observed');
  await shutdown;
  assert.equal(f.counts().disposals, 1);
});
