import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  ContainmentCycleError,
  defineApplication,
  DuplicateNameError,
  LookupFailure,
  ModelValidationError,
  NodeNotFoundError,
  UnresolvedReferenceError,
} from '../src/index.js';
import { compileApplication } from '../src/core/index.js';

function application() {
  return defineApplication({
    name: 'operations',
    roots: [
      () => ({
        kind: 'role',
        name: 'operations',
        description: 'Operate services.',
        instructions: 'Inspect first.',
        children: [
          () => ({
            kind: 'role',
            name: 'platform',
            description: 'Platform work.',
            instructions: 'Coordinate carefully.',
          }),
        ],
        skills: [
          () => ({
            kind: 'skill',
            name: 'diagnose',
            description: 'Diagnose failures.',
            instructions: 'Read evidence before acting.',
            uses: ['operations/status'],
          }),
        ],
        tools: [
          () => ({
            kind: 'tool',
            name: 'status',
            description: 'Read service status.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => ({ ok: true }),
          }),
        ],
      }),
    ],
    promptRoots: [
      () => ({
        kind: 'tool',
        name: 'restart',
        description: 'Restart a service.',
        readOnly: false,
        input: z.strictObject({}),
        invoke: () => ({ restarted: true }),
      }),
    ],
  });
}

test('compilation creates a fresh canonical forest with both root audiences', () => {
  const declaration = application();
  const first = compileApplication(declaration);
  const second = compileApplication(declaration);

  assert.deepEqual(
    [...first.walk()].map(([ref]) => ref),
    ['operations', 'operations/platform', 'operations/diagnose', 'operations/status', 'restart'],
  );
  assert.deepEqual(
    first.modelRoots.map((node) => node.name),
    ['operations'],
  );
  assert.deepEqual(
    first.promptRoots.map((node) => node.name),
    ['restart'],
  );
  assert.notEqual(first.find('operations'), second.find('operations'));
  const firstTool = first.find('operations/status');
  const secondTool = second.find('operations/status');
  assert.equal(firstTool.kind, 'tool');
  assert.equal(secondTool.kind, 'tool');
  if (firstTool.kind !== 'tool' || secondTool.kind !== 'tool') throw new Error('Expected Tools.');
  assert.notEqual(firstTool.binding, secondTool.binding);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.parentOf(first.find('operations/status'))?.name, 'operations');
  assert.deepEqual(first.dependentsOf('operations/status'), ['operations/diagnose']);
  assert.deepEqual(
    first.ofKind('tool').map((node) => node.name),
    ['status', 'restart'],
  );
  assert.equal(first.executionBound, true);
});

test('compiled lookup carries the Python Index.find failure facts exactly', () => {
  const index = compileApplication(application());
  const failure = (operation: () => unknown): NodeNotFoundError => {
    try {
      operation();
    } catch (error) {
      assert.ok(error instanceof NodeNotFoundError);
      return error;
    }
    assert.fail('Expected a NodeNotFoundError.');
  };
  const facts = (error: NodeNotFoundError) => ({
    reason: error.reason,
    ref: error.ref,
    segment: error.segment,
    scope: error.scope,
    kind: error.kind,
    wanted: error.wanted,
    known: error.known,
  });

  assert.deepEqual(facts(failure(() => index.find('//'))), {
    reason: LookupFailure.EMPTY_REF,
    ref: '//',
    segment: undefined,
    scope: undefined,
    kind: undefined,
    wanted: undefined,
    known: [],
  });

  assert.deepEqual(facts(failure(() => index.find('/missing/path'))), {
    reason: LookupFailure.NO_SUCH_ROOT,
    ref: '/missing/path',
    segment: 'missing',
    scope: 'missing',
    kind: undefined,
    wanted: undefined,
    known: ['operations', 'restart'],
  });

  assert.deepEqual(facts(failure(() => index.find('operations/missing'))), {
    reason: LookupFailure.NO_SUCH_MEMBER,
    ref: 'operations/missing',
    segment: 'missing',
    scope: 'operations',
    kind: 'role',
    wanted: undefined,
    known: ['diagnose', 'platform', 'status'],
  });

  assert.deepEqual(facts(failure(() => index.find('operations/diagnose/deeper'))), {
    reason: LookupFailure.NOT_A_CONTAINER,
    ref: 'operations/diagnose/deeper',
    segment: 'deeper',
    scope: 'diagnose',
    kind: 'skill',
    wanted: undefined,
    known: [],
  });

  assert.deepEqual(facts(failure(() => index.tool('operations/diagnose'))), {
    reason: LookupFailure.WRONG_KIND,
    ref: 'operations/diagnose',
    segment: undefined,
    scope: undefined,
    kind: 'skill',
    wanted: 'tool',
    known: [],
  });
  assert.strictEqual(index.find('/operations//status/'), index.find('operations/status'));
  assert.equal(index.tool('operations/status').kind, 'tool');
});

test('compilation rejects a declaration object reused at different addresses', () => {
  const shared = {
    kind: 'skill' as const,
    name: 'shared',
    description: 'A reused object.',
    instructions: 'Do not reuse declaration identity.',
  };
  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'identity',
          roots: [
            () => ({
              kind: 'role',
              name: 'left',
              description: 'Left.',
              instructions: 'Left.',
              skills: [() => shared],
            }),
            () => ({
              kind: 'role',
              name: 'right',
              description: 'Right.',
              instructions: 'Right.',
              skills: [() => shared],
            }),
          ],
        }),
      ),
    DuplicateNameError,
  );
});

test('declaration and compiled collections cannot be mutated into a served surface', () => {
  const roots = [
    () => ({
      kind: 'skill' as const,
      name: 'read',
      description: 'Read a document.',
      instructions: 'Read it.',
    }),
  ];
  const declaration = defineApplication({ name: 'immutable', roots });
  roots.length = 0;
  const index = compileApplication(declaration);

  assert.equal(index.size, 1);
  assert.throws(() => {
    (index.roots as unknown as { push(value: unknown): void }).push({});
  }, TypeError);
  assert.throws(() => {
    (index.find('read') as { name: string }).name = 'changed';
  }, TypeError);
  assert.equal(index.find('read').name, 'read');
});

test('compilation rejects invalid global forest structure', () => {
  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'duplicate',
          roots: [
            () => ({
              kind: 'role',
              name: 'root',
              description: 'Root.',
              instructions: 'Act.',
              skills: [
                () => ({ kind: 'skill', name: 'same', description: 'One.', instructions: 'One.' }),
              ],
              tools: [
                () => ({
                  kind: 'tool',
                  name: 'same',
                  description: 'Two.',
                  readOnly: true,
                  input: z.strictObject({}),
                  invoke: () => undefined,
                }),
              ],
            }),
          ],
        }),
      ),
    DuplicateNameError,
  );

  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'unresolved',
          roots: [
            () => ({
              kind: 'skill',
              name: 'root',
              description: 'Root.',
              instructions: 'Act.',
              uses: ['missing'],
            }),
          ],
        }),
      ),
    UnresolvedReferenceError,
  );
});

test('compilation rejects recursive factories and invalid declared node facts', () => {
  const recursive = () => ({
    kind: 'role' as const,
    name: 'loop',
    description: 'Loop.',
    instructions: 'Loop.',
    children: [recursive],
  });
  assert.throws(
    () => compileApplication(defineApplication({ name: 'cycle', roots: [recursive] })),
    ContainmentCycleError,
  );
  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'bad-name',
          roots: [
            () => ({
              kind: 'skill',
              name: 'bad/name',
              description: 'Bad.',
              instructions: 'Bad.',
            }),
          ],
        }),
      ),
    ModelValidationError,
  );
});
