import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, ModelValidationError } from '../src/index.js';
import { compileApplication, Disclosure } from '../src/core/index.js';

test('Role and Skill declarations reject blank text and blank uses during compilation', () => {
  const tool = () => ({
    kind: 'tool' as const,
    name: 'tool',
    description: 'Tool.',
    readOnly: true,
    input: z.strictObject({}),
    invoke: () => 'ok',
  });
  const invalid = [
    () => ({ kind: 'role' as const, name: ' ', description: 'Role.', instructions: 'Route.' }),
    () => ({ kind: 'role' as const, name: 'role', description: ' ', instructions: 'Route.' }),
    () => ({ kind: 'role' as const, name: 'role', description: 'Role.', instructions: ' ' }),
    () => ({
      kind: 'role' as const,
      name: 'role',
      description: 'Role.',
      instructions: 'Route.',
      uses: [' '],
    }),
    () => ({ kind: 'skill' as const, name: ' ', description: 'Skill.', instructions: 'Read.' }),
    () => ({ kind: 'skill' as const, name: 'skill', description: ' ', instructions: 'Read.' }),
    () => ({ kind: 'skill' as const, name: 'skill', description: 'Skill.', instructions: ' ' }),
    () => ({
      kind: 'skill' as const,
      name: 'skill',
      description: 'Skill.',
      instructions: 'Read.',
      uses: [' '],
    }),
    () => ({ ...tool(), name: ' ' }),
    () => ({ ...tool(), description: ' ' }),
    () => ({ ...tool(), uses: [' '] }),
  ];
  for (const root of invalid) {
    assert.throws(
      () => compileApplication(defineApplication({ name: 'invalid-skill-facts', roots: [root] })),
      ModelValidationError,
    );
  }
});

test('two Skills can refer to each other while an active Skill exposes only a routing card', () => {
  const first = {
    kind: 'skill' as const,
    name: 'first',
    description: 'First procedure.',
    instructions: 'Read the first procedure.',
    uses: ['workflow/second'],
  };
  const second = {
    kind: 'skill' as const,
    name: 'second',
    description: 'Second procedure.',
    instructions: 'Read the second procedure.',
    uses: ['workflow/first'],
  };
  const application = defineApplication({
    name: 'skill-cycle',
    roots: [
      () => ({
        kind: 'role' as const,
        name: 'workflow',
        description: 'Workflow.',
        instructions: 'Choose a procedure.',
        skills: [() => first, () => second],
      }),
    ],
  });
  const disclosure = new Disclosure(compileApplication(application));
  const opened = disclosure.open('workflow/first');
  assert.deepEqual(opened, {
    kind: 'skill',
    name: 'first',
    description: 'First procedure.',
    ref: 'workflow/first',
    instructions: 'Read the first procedure.',
    uses: [
      {
        kind: 'skill',
        name: 'second',
        description: 'Second procedure.',
        ref: 'workflow/second',
      },
    ],
  });
  const referenced = (opened.uses as readonly Record<string, unknown>[])[0];
  assert.ok(referenced !== undefined);
  assert.equal('instructions' in referenced, false);
  assert.equal('uses' in referenced, false);

  first.instructions = 'Mutated after compilation.';
  first.uses = [];
  assert.deepEqual(disclosure.open('workflow/first'), opened);
});

test('an active Role retains its own instructions but every contained member remains a routing card', () => {
  const disclosure = new Disclosure(
    compileApplication(
      defineApplication({
        name: 'role-cards',
        roots: [
          () => ({
            kind: 'role',
            name: 'operations',
            description: 'Operations.',
            instructions: 'Route by responsibility.',
            children: [
              () => ({
                kind: 'role',
                name: 'platform',
                description: 'Platform.',
                instructions: 'Inspect platform.',
              }),
            ],
            skills: [
              () => ({
                kind: 'skill',
                name: 'diagnose',
                description: 'Diagnose.',
                instructions: 'Inspect evidence.',
                uses: ['operations/status'],
              }),
            ],
            tools: [
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
        ],
      }),
    ),
  );
  const opened = disclosure.open('operations');
  assert.equal(opened.instructions, 'Route by responsibility.');
  for (const member of [
    ...(opened.roles as readonly Record<string, unknown>[]),
    ...(opened.skills as readonly Record<string, unknown>[]),
    ...(opened.tools as readonly Record<string, unknown>[]),
  ]) {
    assert.equal('instructions' in member, false);
    assert.equal('uses' in member, false);
  }
});
