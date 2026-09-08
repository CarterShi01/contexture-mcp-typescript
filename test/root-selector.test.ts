import assert from 'node:assert/strict';
import test from 'node:test';

import { defineApplication, Principal, SurfaceSelection } from '../src/index.js';
import { compileApplication, RootSelection, RootSelectionError } from '../src/core/index.js';
import {
  HeaderRootSelector,
  HeaderSurfaceSelector,
  ROOTS_HEADER,
  SELECT_HEADER,
} from '../src/server/index.js';

function index() {
  return compileApplication(
    defineApplication({
      name: 'roots',
      roots: [
        () => ({
          kind: 'role',
          name: 'diagnose',
          description: 'Diagnose.',
          instructions: 'Read.',
          children: [
            () => ({
              kind: 'role',
              name: 'service',
              description: 'Service.',
              instructions: 'Inspect.',
            }),
          ],
        }),
        () => ({ kind: 'role', name: 'release', description: 'Release.', instructions: 'Read.' }),
      ],
    }),
  );
}

test('header root selection attenuates but cannot widen an identity ceiling', () => {
  const compiled = index();
  const selector = new HeaderRootSelector({
    ceiling: (principal) =>
      principal?.scopes.has('support') ? RootSelection.all() : RootSelection.only('diagnose'),
  });
  const requested = selector.select(
    compiled,
    { 'contexture-roots': 'diagnose' },
    new Principal({ scopes: ['support'] }),
  );
  assert.equal(requested.containsRef('diagnose/tool'), true);
  assert.equal(requested.containsRef('release/tool'), false);
  const limited = selector.select(compiled);
  assert.equal(limited.containsRef('diagnose/tool'), true);
  assert.equal(limited.containsRef('release/tool'), false);
  assert.throws(
    () => selector.select(compiled, { [ROOTS_HEADER]: 'release' }),
    /effective surface selection is empty/,
  );
});

test('a selector without a header or identity ceiling retains the compatibility all-roots surface', () => {
  const selected = new HeaderRootSelector().select(index());

  assert.equal(selected.names, undefined);
  assert.equal(selected.containsRef('diagnose/tool'), true);
  assert.equal(selected.containsRef('release/tool'), true);
});

test('header root selection validates size, count, and named roots', () => {
  const compiled = index();
  const selector = new HeaderRootSelector({ maxLength: 4, maxRoots: 1 });
  assert.throws(() => selector.select(compiled, { [ROOTS_HEADER]: 'diagnose' }), /character limit/);
  const countLimited = new HeaderRootSelector({ maxRoots: 1 });
  assert.throws(
    () => countLimited.select(compiled, { [ROOTS_HEADER]: 'diagnose,release' }),
    /root limit/,
  );
  let unknown: unknown;
  try {
    countLimited.select(compiled, { [ROOTS_HEADER]: 'missing' });
  } catch (error) {
    unknown = error;
  }
  assert.ok(unknown instanceof RootSelectionError);
  assert.match(unknown.message, /Unknown or empty Contexture selector: "missing"/);
  assert.doesNotMatch(unknown.message, /diagnose|release/);
});

test('header root selection trims and deduplicates without leaking excluded roots', () => {
  const selected = new HeaderRootSelector().select(index(), {
    [ROOTS_HEADER]: ' diagnose, diagnose ',
  });
  assert.deepEqual(selected.names, ['diagnose']);
  assert.equal(selected.containsRef('diagnose/child'), true);
  assert.equal(selected.containsRef('/diagnose/child'), false);
  assert.equal(selected.containsRef('release'), false);
});

test('surface header selects exact paths and direct children with legacy compatibility', () => {
  const compiled = index();
  const selector = new HeaderSurfaceSelector();
  const exact = selector.select(compiled, { [SELECT_HEADER]: 'diagnose/service' });
  const wildcard = selector.select(compiled, { [SELECT_HEADER]: 'diagnose/*' });
  assert.deepEqual(exact.names, ['diagnose/service']);
  assert.deepEqual(wildcard.names, exact.names);
  assert.deepEqual(
    new HeaderRootSelector().select(compiled, { 'contexture-roots': 'diagnose' }).names,
    ['diagnose'],
  );
  assert.throws(
    () =>
      selector.select(compiled, {
        [SELECT_HEADER]: 'diagnose',
        [ROOTS_HEADER]: 'release',
      }),
    RootSelectionError,
  );
});

test('surface ceiling can only narrow a path request', () => {
  const selected = new HeaderSurfaceSelector({
    ceiling: () => SurfaceSelection.only('diagnose'),
  }).select(index(), { [SELECT_HEADER]: 'diagnose/service,release' });
  assert.deepEqual(selected.names, ['diagnose/service']);
});
