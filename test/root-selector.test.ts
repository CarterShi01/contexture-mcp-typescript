import assert from 'node:assert/strict';
import test from 'node:test';

import { defineApplication, Principal } from '../src/index.js';
import { compileApplication, RootSelection } from '../src/core/index.js';
import { HeaderRootSelector, ROOTS_HEADER } from '../src/server/index.js';

function index() {
  return compileApplication(
    defineApplication({
      name: 'roots',
      roots: [
        () => ({ kind: 'role', name: 'diagnose', description: 'Diagnose.', instructions: 'Read.' }),
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
    /effective root selection is empty/,
  );
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
  assert.throws(
    () => countLimited.select(compiled, { [ROOTS_HEADER]: 'missing' }),
    /Unknown Contexture root selection/,
  );
});

test('header root selection trims and deduplicates without leaking excluded roots', () => {
  const selected = new HeaderRootSelector().select(index(), {
    [ROOTS_HEADER]: ' diagnose, diagnose ',
  });
  assert.deepEqual(selected.names, ['diagnose']);
  assert.equal(selected.containsRef('/diagnose/child'), true);
  assert.equal(selected.containsRef('release'), false);
});
