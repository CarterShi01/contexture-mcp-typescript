import assert from 'node:assert/strict';
import test from 'node:test';

import { defineApplication } from '../src/index.js';
import {
  LookupFailure,
  NodeNotFoundError,
  RootOutsideSelectionError,
  RootSelection,
  SelectedGraph,
  compileApplication,
} from '../src/core/index.js';

const privateUse = '\uE000';
const astral = '\u{10000}';

function index() {
  return compileApplication(
    defineApplication({
      name: 'selected-graph',
      roots: [
        () => ({
          kind: 'role',
          name: 'alpha',
          description: 'Alpha root.',
          instructions: 'Inspect alpha.',
          children: [
            () => ({
              kind: 'role',
              name: 'child',
              description: 'Alpha child.',
              instructions: 'Inspect child.',
            }),
          ],
        }),
        () => ({ kind: 'skill', name: 'beta', description: 'Beta.', instructions: 'Read beta.' }),
        () => ({ kind: 'skill', name: 'aa', description: 'ASCII.', instructions: 'Read ASCII.' }),
        () => ({
          kind: 'skill',
          name: privateUse,
          description: 'Private-use Unicode.',
          instructions: 'Read private-use Unicode.',
        }),
        () => ({
          kind: 'skill',
          name: astral,
          description: 'Astral Unicode.',
          instructions: 'Read astral Unicode.',
        }),
      ],
    }),
  );
}

test('SelectedGraph rejects excluded refs but leaves the canonical empty-ref diagnostic intact', () => {
  const compiled = index();
  const graph = new SelectedGraph(compiled, RootSelection.only('alpha'));

  assert.equal(graph.find('alpha/child').name, 'child');
  assert.throws(() => graph.find('beta'), RootOutsideSelectionError);
  assert.throws(
    () => graph.find(''),
    (error: unknown) =>
      error instanceof NodeNotFoundError && error.reason === LookupFailure.EMPTY_REF,
  );
});

test('SelectedGraph projects parent and complete children inside a selected tree', () => {
  const compiled = index();
  const graph = new SelectedGraph(compiled, RootSelection.only('alpha'));
  const alpha = graph.find('alpha');
  const child = graph.find('alpha/child');

  assert.equal(graph.parentOf(child), alpha);
  assert.deepEqual(graph.childrenOf(alpha), [child]);
});

test('SelectedGraph matching uses projected Unicode code-point ordering and retains total before limit', () => {
  const graph = new SelectedGraph(index(), RootSelection.only([privateUse, astral, 'aa']));

  assert.deepEqual(graph.matchingRefs('', 2), {
    values: [privateUse, astral],
    total: 3,
  });
  assert.deepEqual(graph.matchingRefs('', -1), { values: [], total: 3 });
  assert.equal(graph.matchingRefs('', 8).values.includes('alpha'), false);
  const walked = [...graph.walk()][0];
  assert.ok(walked !== undefined);
  assert.equal(Object.isFrozen(walked), true);
  assert.throws(() => {
    (walked as unknown as [string, unknown])[0] = 'forged';
  }, TypeError);
});
