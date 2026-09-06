import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, type ApplicationDeclaration } from '../src/index.js';
import { compileApplication, compileDisclosureApplication } from '../src/core/index.js';
import { compileRuntimeApplication, compileStructuralApplication } from '../src/server/index.js';

test('runtime compilation builds one bound Index shared by disclosure, invocation, and publications', async () => {
  const declaration = defineApplication({
    name: 'runtime-application',
    roots: [
      () => ({
        kind: 'role' as const,
        name: 'assistant',
        description: 'Answer requests.',
        instructions: 'Read first.',
        tools: [
          () => ({
            kind: 'tool' as const,
            name: 'read',
            description: 'Read one value.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => 'read:ok',
          }),
        ],
      }),
    ],
    resources: [
      {
        opens: 'assistant/read',
        uri: 'contexture://assistant/read',
        description: 'Read one value.',
      },
    ],
  });
  const compiled = compileRuntimeApplication(declaration);

  assert.strictEqual(compiled.disclosure.index, compiled.index);
  assert.strictEqual(compiled.runtime.index, compiled.index);
  assert.strictEqual(compiled.publications.disclosure, compiled.disclosure);
  assert.strictEqual(compiled.publications.runtime, compiled.runtime);
  assert.equal(await compiled.runtime.invokeReadOnly('assistant/read'), 'read:ok');
  assert.equal(await compiled.publications.read('contexture://assistant/read'), 'read:ok');
  assert.equal(compiled.disclosure.open('assistant/read').ref, 'assistant/read');
});

test('every public compilation route normalizes raw declarations through defineApplication', () => {
  const raw = (): ApplicationDeclaration =>
    ({
      name: ' raw compilation ',
      roots: [
        () => ({
          kind: 'skill',
          name: 'approval',
          description: 'Require approval.',
          instructions: 'Wait for a person.',
        }),
      ],
      prompts: [
        {
          opens: 'approval',
          description: 'Open approval.',
          modelMayOpen: false,
        },
      ],
    }) as ApplicationDeclaration;
  const compilers = [
    (declaration: ApplicationDeclaration) => compileApplication(declaration),
    (declaration: ApplicationDeclaration) => compileDisclosureApplication(declaration),
    (declaration: ApplicationDeclaration) => compileRuntimeApplication(declaration).index,
    (declaration: ApplicationDeclaration) => compileStructuralApplication(declaration).index,
  ];
  for (const compile of compilers) {
    assert.equal(compile(raw()).name, 'raw compilation');
  }
  assert.throws(
    () => compileRuntimeApplication(raw()).disclosure.open('approval'),
    /opened by a person/,
  );
});

test('public compilation routes reject raw Prompt and Resource declaration bypasses', () => {
  const raw = (extra: Record<string, unknown>): ApplicationDeclaration =>
    ({
      name: 'raw-bypass',
      roots: [
        () => ({
          kind: 'skill',
          name: 'approval',
          description: 'Require approval.',
          instructions: 'Wait for a person.',
        }),
      ],
      ...extra,
    }) as ApplicationDeclaration;
  const compilers = [
    (declaration: ApplicationDeclaration) => compileApplication(declaration),
    (declaration: ApplicationDeclaration) => compileDisclosureApplication(declaration),
    (declaration: ApplicationDeclaration) => compileRuntimeApplication(declaration),
    (declaration: ApplicationDeclaration) => compileStructuralApplication(declaration),
  ];
  for (const declaration of [
    raw({ prompts: [{ opens: 'approval', description: 'Open approval.', modelMayOpen: 'false' }] }),
    raw({ prompts: [{ name: ' ', opens: 'approval', description: 'Open approval.' }] }),
    raw({
      resources: [
        {
          opens: 'approval',
          uri: 'contexture://approval',
          description: 'Read approval.',
          mimeType: 1,
        },
      ],
    }),
  ]) {
    for (const compile of compilers) {
      assert.throws(() => compile(declaration), TypeError);
    }
  }
});
