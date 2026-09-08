import assert from 'node:assert/strict';
import test from 'node:test';

import { defineApplication } from '../src/index.js';
import {
  Disclosure,
  RootOutsideSelectionError,
  RootSelection,
  RootSelectionError,
  SelectedGraph,
  SurfaceSelection,
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

test('SelectedGraph rejects every ref outside the exact selected surface', () => {
  const compiled = index();
  const graph = new SelectedGraph(compiled, RootSelection.only('alpha'));

  assert.equal(graph.find('alpha/child').name, 'child');
  assert.throws(() => graph.find('beta'), RootOutsideSelectionError);
  assert.throws(() => graph.find(''), RootOutsideSelectionError);
  assert.throws(() => graph.find('/alpha/child'), RootOutsideSelectionError);
});

test('SelectedGraph projects parent and complete children inside a selected tree', () => {
  const compiled = index();
  const graph = new SelectedGraph(compiled, RootSelection.only('alpha'));
  const alpha = graph.find('alpha');
  const child = graph.find('alpha/child');

  assert.equal(graph.parentOf(child), alpha);
  assert.deepEqual(graph.childrenOf(alpha), [child]);
});

test('SurfaceSelection resolves exact paths to an antichain and expands direct children only', () => {
  const compiled = index();
  const selected = SurfaceSelection.only(['alpha', 'alpha/child']).resolve(compiled);
  assert.deepEqual(selected.names, ['alpha']);
  const wildcard = SurfaceSelection.only('alpha/*').resolve(compiled);
  assert.deepEqual(wildcard.names, ['alpha/child']);
  assert.equal(wildcard.containsRef('alpha/child/tool'), true);
  assert.equal(wildcard.containsRef('alpha'), false);
  for (const selectors of [[], ['alpha/**'], ['alpha/ch*'], ['alpha/*/inspect']]) {
    assert.throws(() => SurfaceSelection.only(selectors), RootSelectionError);
  }
  let unknown: unknown;
  try {
    SurfaceSelection.only('missing').resolve(compiled);
  } catch (error) {
    unknown = error;
  }
  assert.ok(unknown instanceof RootSelectionError);
  assert.doesNotMatch(unknown.message, /alpha|beta/);
});

test('SurfaceSelection intersection is path-aware, monotonic, and commutative', () => {
  const alpha = RootSelection.only('alpha');
  const child = RootSelection.only('alpha/child');
  const both = RootSelection.only(['alpha', 'beta']);
  assert.deepEqual(alpha.intersect(both).names, both.intersect(alpha).names);
  assert.deepEqual(alpha.intersect(child).names, ['alpha/child']);
  assert.deepEqual(RootSelection.all().intersect(alpha).names, ['alpha']);
});

test('SelectedGraph promotes a selected descendant and hides its parent', () => {
  const compiled = index();
  const graph = new SelectedGraph(compiled, SurfaceSelection.only('alpha/child'));
  assert.deepEqual(
    graph.roots.map((node) => graph.refOf(node)),
    ['alpha/child'],
  );
  const child = graph.find('alpha/child');
  assert.equal(graph.parentOf(child), undefined);
  assert.deepEqual(
    [...graph.walk()].map(([ref]) => ref),
    ['alpha/child'],
  );
  assert.throws(() => graph.find('alpha'), RootOutsideSelectionError);
});

test('Disclosure discovers and opens a promoted descendant surface root', () => {
  const compiled = index();
  const disclosure = new Disclosure(compiled).select(SurfaceSelection.only('alpha/child'));
  assert.deepEqual(
    disclosure.discover().roles.map((card) => card.ref),
    ['alpha/child'],
  );
  assert.equal(disclosure.open('alpha/child').ref, 'alpha/child');
  assert.throws(() => disclosure.open('alpha'), RootOutsideSelectionError);
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
