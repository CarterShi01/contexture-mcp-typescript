import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import { compileRuntimeApplication } from '../src/server/index.js';

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
