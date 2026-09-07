import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, ModelValidationError, NodeNotFoundError } from '../src/index.js';
import { compileApplication, compileDisclosureApplication } from '../src/core/index.js';
import type { Index } from '../src/server/index.js';

function queryIndex(): Index {
  return compileApplication(
    defineApplication({
      name: 'index-query',
      roots: [
        () => ({
          kind: 'role',
          name: 'alpha',
          description: 'Alpha.',
          instructions: 'Route.',
          children: [
            () => ({
              kind: 'role',
              name: 'child',
              description: 'Child.',
              instructions: 'Route.',
              children: [
                () => ({
                  kind: 'role',
                  name: 'grand',
                  description: 'Grand.',
                  instructions: 'Route.',
                }),
              ],
            }),
          ],
          skills: [
            () => ({
              kind: 'skill',
              name: 'diagnose',
              description: 'Diagnose.',
              instructions: 'Read.',
              uses: ['beta/read'],
            }),
            () => ({
              kind: 'skill',
              name: 'inspect',
              description: 'Inspect.',
              instructions: 'Read.',
            }),
          ],
          tools: [
            () => ({
              kind: 'tool',
              name: 'write',
              description: 'Write.',
              readOnly: false,
              input: z.strictObject({ value: z.string() }),
              invoke: () => 'ok',
            }),
          ],
        }),
        () => ({
          kind: 'role',
          name: 'beta',
          description: 'Beta.',
          instructions: 'Route.',
          tools: [
            () => ({
              kind: 'tool',
              name: 'read',
              description: 'Read.',
              readOnly: true,
              input: z.strictObject({}),
              invoke: () => 'ok',
            }),
          ],
        }),
      ],
    }),
  );
}

test('Index exposes immutable canonical containment and typed traversals', () => {
  const index = queryIndex();
  assert.equal(index.size, 8);
  assert.equal(index.isBound, true);
  assert.equal(index.executionBound, true);
  assert.equal(index.has('alpha/child/grand'), true);
  assert.equal(index.has('/alpha/child/grand/'), false);
  assert.equal(index.has('alpha/missing'), false);
  assert.deepEqual(
    [...index.nodesWithRefs()].map(([ref]) => ref),
    [
      'alpha',
      'alpha/child',
      'alpha/child/grand',
      'alpha/diagnose',
      'alpha/inspect',
      'alpha/write',
      'beta',
      'beta/read',
    ],
  );
  assert.deepEqual(
    [...index.rolesWithRefs()].map(([ref]) => ref),
    ['alpha', 'alpha/child', 'alpha/child/grand', 'beta'],
  );
  assert.deepEqual(
    [...index.rolesByLevel()].map(([ref]) => ref),
    ['alpha', 'beta', 'alpha/child', 'alpha/child/grand'],
  );
  assert.deepEqual(
    [...index.skills()].map(([ref]) => ref),
    ['alpha/diagnose', 'alpha/inspect'],
  );
  const first = [...index.nodesWithRefs()][0];
  assert.ok(first !== undefined);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => {
    (first as unknown as [string, unknown])[0] = 'forged';
  }, TypeError);
  assert.equal(index.find('alpha').name, 'alpha');
});

test('Index binding, schema, signpost, and crossing facts remain guarded and immutable', () => {
  const index = queryIndex();
  const read = index.tool('beta/read');
  assert.strictEqual(index.bindingOf('beta/read'), read.binding);
  const schema = index.schemaOf(read);
  assert.deepEqual(schema, { type: 'object', properties: {} });
  assert.equal(Object.isFrozen(schema), true);
  assert.throws(() => {
    (schema as { type: string }).type = 'forged';
  }, TypeError);
  assert.throws(() => index.bindingOf('alpha'), NodeNotFoundError);
  assert.throws(() => index.schemaOf({ ...read }), ModelValidationError);
  assert.throws(() => index.childrenOf({ ...read }), ModelValidationError);
  assert.deepEqual(index.signpost('/alpha//child//grand/'), [
    { ref: 'alpha', subRoleCount: 1 },
    { ref: 'alpha/child', subRoleCount: 1 },
  ]);
  assert.throws(() => index.signpost('missing/child'), NodeNotFoundError);
  assert.deepEqual(
    [...index.crossings()],
    [{ sourceRef: 'alpha/diagnose', targetRef: 'beta/read', targetRoot: 'beta' }],
  );
});

test('Index ranks all refs by Python relevance and code-point rules without changing selection limits', () => {
  const index = queryIndex();
  assert.deepEqual(index.matchingRefs(' child ', 8), {
    values: ['alpha/child', 'alpha/child/grand'],
    total: 2,
  });
  assert.deepEqual(index.matchingRefs('agn', 1), {
    values: ['alpha/diagnose'],
    total: 1,
  });
  assert.deepEqual(index.matchingRefs('ins', 1), {
    values: ['alpha/inspect'],
    total: 1,
  });
  assert.deepEqual(index.matchingRefs('', -1), { values: [], total: 8 });
  assert.throws(() => index.matchingRefs('', 1.5), RangeError);

  const unicode = compileApplication(
    defineApplication({
      name: 'unicode-index',
      roots: [
        () => ({
          kind: 'role',
          name: 'root',
          description: 'Root.',
          instructions: 'Route.',
          children: [
            () => ({
              kind: 'role',
              name: 'a中',
              description: 'Chinese.',
              instructions: 'Route.',
            }),
            () => ({
              kind: 'role',
              name: 'abcd',
              description: 'ASCII.',
              instructions: 'Route.',
            }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(unicode.matchingRefs('a', 1), { values: ['root/a中'], total: 2 });
});

test('a disclosure-only Index keeps structural traversal but refuses executable bindings', () => {
  const index = compileDisclosureApplication(
    defineApplication({
      name: 'unbound-index',
      roots: [
        () => ({
          kind: 'tool',
          name: 'status',
          description: 'Status.',
          readOnly: true,
          input: z.strictObject({}),
          invoke: () => 'ok',
        }),
      ],
    }),
  );
  assert.equal(index.isBound, false);
  assert.deepEqual(
    [...index.nodesWithRefs()].map(([ref]) => ref),
    ['status'],
  );
  assert.throws(() => index.bindingOf('status'), ModelValidationError);
  assert.throws(() => index.schemaOf(index.tool('status')), ModelValidationError);
});
