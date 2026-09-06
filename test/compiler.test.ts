import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileApplication,
  ContainmentCycleError,
  defineApplication,
  DuplicateNameError,
  ModelValidationError,
  UnresolvedReferenceError,
} from '../src/index.js';

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
  assert.equal(first.parentOf(first.find('operations/status'))?.name, 'operations');
  assert.deepEqual(first.dependentsOf('operations/status'), ['operations/diagnose']);
  assert.deepEqual(
    first.ofKind('tool').map((node) => node.name),
    ['status', 'restart'],
  );
  assert.equal(first.executionBound, true);
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
