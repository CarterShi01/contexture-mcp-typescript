import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import {
  ApplicationRuntime,
  currentGraph,
  RootOutsideSelectionError,
  RootSelection,
  SelectedGraph,
  withGraph,
  compileApplication,
} from '../src/core/index.js';

function graphFixture() {
  let observed: SelectedGraph | undefined;
  const index = compileApplication(
    defineApplication({
      name: 'graph-context',
      roots: [
        () => ({
          kind: 'role',
          name: 'alpha',
          description: 'Alpha.',
          instructions: 'Inspect.',
          tools: [
            () => ({
              kind: 'tool',
              name: 'probe',
              description: 'Probe request graph.',
              readOnly: true,
              input: z.strictObject({}),
              invoke: () => {
                observed = currentGraph();
                assert.throws(() => observed?.find('beta'), RootOutsideSelectionError);
                return 'ok';
              },
            }),
          ],
        }),
        () => ({
          kind: 'role',
          name: 'beta',
          description: 'Beta.',
          instructions: 'Separate.',
        }),
      ],
    }),
  );
  return {
    index,
    all: new SelectedGraph(index),
    alpha: new SelectedGraph(index, RootSelection.only('alpha')),
    observed: () => observed,
  };
}

test('withGraph nests and restores exact graph identities across awaits and failures', async () => {
  const { all, alpha } = graphFixture();

  assert.throws(() => currentGraph(), /No compiled Contexture graph is active/);
  await withGraph(all, async () => {
    assert.equal(currentGraph(), all);
    await withGraph(alpha, async () => {
      await Promise.resolve();
      assert.equal(currentGraph(), alpha);
      assert.throws(() => currentGraph().find('beta'), RootOutsideSelectionError);
    });
    assert.equal(currentGraph(), all);
    await assert.rejects(
      withGraph(alpha, async () => {
        await Promise.resolve();
        throw new Error('nested failure');
      }),
      /nested failure/,
    );
    assert.equal(currentGraph(), all);
  });
  assert.throws(() => currentGraph(), /No compiled Contexture graph is active/);
});

test('withGraph isolates overlapping asynchronous scopes', async () => {
  const { all, alpha } = graphFixture();
  let arrived = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observe = (graph: SelectedGraph) =>
    withGraph(graph, async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      await Promise.resolve();
      return currentGraph();
    });

  const [first, second] = await Promise.all([observe(all), observe(alpha)]);
  assert.equal(first, all);
  assert.equal(second, alpha);
});

test('ApplicationRuntime overrides and restores a caller-bound graph', async () => {
  const { index, all, observed } = graphFixture();
  const runtime = new ApplicationRuntime(index);

  await withGraph(all, async () => {
    assert.equal(
      await runtime.invokeReadOnly('alpha/probe', {}, {}, RootSelection.only('alpha')),
      'ok',
    );
    assert.equal(currentGraph(), all);
  });
  assert.deepEqual(observed()?.selection.names, ['alpha']);
  assert.notEqual(observed(), all);
  assert.throws(() => currentGraph(), /No compiled Contexture graph is active/);
});
