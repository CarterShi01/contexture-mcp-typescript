import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  defineApplication,
  LookupFailure,
  ModelValidationError,
  NodeNotFoundError,
} from '../src/index.js';
import { compileApplication, Disclosure, RootSelection } from '../src/core/index.js';

test('a compiled Role exposes immutable, ordered local membership facts', () => {
  const declaration = {
    kind: 'role' as const,
    name: 'operations',
    description: 'Operate services.',
    instructions: 'Choose the applicable branch.',
    uses: ['support'],
    children: [
      () => ({
        kind: 'role' as const,
        name: 'incidents',
        description: 'Handle incidents.',
        instructions: 'Read evidence.',
      }),
      () => ({
        kind: 'role' as const,
        name: 'changes',
        description: 'Handle changes.',
        instructions: 'Plan first.',
      }),
    ],
    skills: [
      () => ({
        kind: 'skill' as const,
        name: 'triage',
        description: 'Triage an incident.',
        instructions: 'Classify evidence.',
      }),
    ],
    tools: [
      () => ({
        kind: 'tool' as const,
        name: 'status',
        description: 'Read status.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => 'ok',
      }),
    ],
  };
  const index = compileApplication(
    defineApplication({
      name: 'role-members',
      roots: [() => declaration],
      promptRoots: [
        () => ({
          kind: 'skill' as const,
          name: 'support',
          description: 'Provide support.',
          instructions: 'Support the operator.',
        }),
      ],
    }),
  );
  const role = index.find('operations');
  assert.equal(role.kind, 'role');
  if (role.kind !== 'role') throw new Error('Expected a compiled Role.');

  assert.deepEqual(
    role.branches().map((node) => node.name),
    ['incidents', 'changes'],
  );
  assert.deepEqual(
    role.members().map((node) => node.name),
    ['incidents', 'changes', 'triage', 'status'],
  );
  assert.equal(index.refOf(role.member('triage')), 'operations/triage');
  assert.equal(role.member('status').kind, 'tool');
  assert.equal(role.members().every(Object.isFrozen), true);
  assert.notEqual(role.members(), role.members());
  assert.throws(
    () => (role.members() as unknown as { push(value: unknown): void }).push({}),
    TypeError,
  );
  assert.throws(() => {
    (role.member('status') as { name: string }).name = 'forged';
  }, TypeError);
  assert.equal(role.member('status').name, 'status');

  assert.throws(
    () => role.member('absent'),
    (error: unknown) => {
      assert.ok(error instanceof NodeNotFoundError);
      assert.deepEqual(
        {
          reason: error.reason,
          ref: error.ref,
          segment: error.segment,
          scope: error.scope,
          kind: error.kind,
          known: error.known,
        },
        {
          reason: LookupFailure.NO_SUCH_MEMBER,
          ref: undefined,
          segment: 'absent',
          scope: 'operations',
          kind: 'role',
          known: ['changes', 'incidents', 'status', 'triage'],
        },
      );
      return true;
    },
  );

  declaration.instructions = 'Mutated after compilation.';
  declaration.children = [];
  assert.equal(role.instructions, 'Choose the applicable branch.');
  assert.deepEqual(
    role.members().map((node) => node.name),
    ['incidents', 'changes', 'triage', 'status'],
  );

  const selected = new Disclosure(index)
    .select(RootSelection.only('operations'))
    .open('operations');
  assert.deepEqual(selected.uses, []);
  assert.doesNotMatch(JSON.stringify(selected), /support/);
  assert.deepEqual(
    (selected.roles as readonly Record<string, unknown>[]).map((card) => card.ref),
    ['operations/incidents', 'operations/changes'],
  );
  assert.deepEqual(
    (selected.skills as readonly Record<string, unknown>[]).map((card) => card.ref),
    ['operations/triage'],
  );
  assert.deepEqual(
    (selected.tools as readonly Record<string, unknown>[]).map((card) => card.ref),
    ['operations/status'],
  );
});

test('compilation rejects a Role that names its own canonical ref in uses', () => {
  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'role-self-use',
          roots: [
            () => ({
              kind: 'role' as const,
              name: 'operations',
              description: 'Operate services.',
              instructions: 'Inspect evidence.',
              uses: ['operations'],
            }),
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof ModelValidationError && !/unknown Contexture reference/.test(error.message),
  );
});
