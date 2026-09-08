import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  defineApplication,
  defineTool,
  ModelValidationError,
  WrongDoorError,
} from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  compileDisclosureApplication,
  Disclosure,
} from '../src/core/index.js';

test('defineTool validates and snapshots its native declaration facts', () => {
  const uses = ['target'];
  const tool = defineTool({
    kind: 'tool',
    name: 'entry',
    description: 'Read the entry.',
    input: z.object({ value: z.string() }),
    invoke: (input) => input.value,
    uses,
  });
  uses[0] = 'forged';

  assert.equal(tool.readOnly, false);
  assert.deepEqual(tool.uses, ['target']);
  assert.equal(Object.isFrozen(tool), true);
  assert.throws(() => {
    (tool.uses as unknown as { push(value: string): void }).push('forged');
  }, TypeError);

  const validInput = z.object({});
  for (const invalid of [
    () =>
      defineTool({
        kind: 'tool',
        name: ' ',
        description: 'Describe.',
        input: validInput,
        invoke: () => undefined,
      }),
    () =>
      defineTool({
        kind: 'tool',
        name: 'bad/name',
        description: 'Describe.',
        input: validInput,
        invoke: () => undefined,
      }),
    () =>
      defineTool({
        kind: 'tool',
        name: 'valid',
        description: ' ',
        input: validInput,
        invoke: () => undefined,
      }),
    () =>
      defineTool({
        kind: 'tool',
        name: 'valid',
        description: 'Describe.',
        readOnly: 'yes' as never,
        input: validInput,
        invoke: () => undefined,
      }),
    () =>
      defineTool({
        kind: 'tool',
        name: 'valid',
        description: 'Describe.',
        input: {} as never,
        invoke: () => undefined,
      }),
    () =>
      defineTool({
        kind: 'tool',
        name: 'valid',
        description: 'Describe.',
        input: validInput,
        invoke: () => undefined,
        uses: ['target', 'target'],
      }),
  ]) {
    assert.throws(invalid, ModelValidationError);
  }
});

test('a compiled Tool snapshots callable facts, uses, and its disclosed schema', async () => {
  const source = {
    kind: 'tool' as const,
    name: 'entry',
    description: 'Read the entry.',
    readOnly: true,
    input: z.object({ value: z.string() }),
    invoke: (input: { readonly value: string }) => `original:${input.value}`,
    uses: ['target'],
  };
  const index = compileApplication(
    defineApplication({
      name: 'tool-snapshot',
      roots: [
        () => source,
        () =>
          defineTool({
            kind: 'tool',
            name: 'target',
            description: 'Read the target.',
            readOnly: true,
            input: z.object({}),
            invoke: () => 'target',
          }),
      ],
    }),
  );
  const compiled = index.tool('entry');
  const binding = index.bindingOf('entry');

  source.name = 'forged';
  source.description = 'Forged.';
  source.readOnly = false;
  source.uses[0] = 'forged';
  (source as { input: unknown }).input = z.object({ forged: z.boolean() });
  (source as { invoke: unknown }).invoke = () => 'forged';

  assert.equal(compiled.name, 'entry');
  assert.equal(compiled.description, 'Read the entry.');
  assert.equal(compiled.readOnly, true);
  assert.deepEqual(compiled.uses, ['target']);
  assert.equal(await binding.call({ value: 'ok' }, {}), 'original:ok');
  assert.deepEqual(binding.schema, {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  });
  assert.throws(() => {
    (binding.schema.properties as Record<string, { type: string }>).value!.type = 'number';
  }, TypeError);

  assert.deepEqual(new Disclosure(index).open('entry'), {
    kind: 'tool',
    name: 'entry',
    description: 'Read the entry.',
    ref: 'entry',
    read_only: true,
    input_schema: binding.schema,
    uses: [
      {
        kind: 'tool',
        name: 'target',
        description: 'Read the target.',
        ref: 'target',
        read_only: true,
        input_schema: { type: 'object', properties: {} },
      },
    ],
  });
});

test('a structural Tool is unbound, while the runtime enforces the writing door and self uses', async () => {
  const structural = compileDisclosureApplication(
    defineApplication({
      name: 'structural-tool',
      roots: [
        () => ({
          kind: 'tool' as const,
          name: 'describe',
          description: 'Describe the system.',
          readOnly: false,
          invoke: () => 'never bound',
        }),
      ],
    }),
  );
  const node = structural.tool('describe');
  assert.equal(node.binding, undefined);
  assert.throws(() => structural.bindingOf('describe'), ModelValidationError);
  assert.deepEqual(new Disclosure(structural).open('describe'), {
    kind: 'tool',
    name: 'describe',
    description: 'Describe the system.',
    ref: 'describe',
  });

  const runtime = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'writing-tool',
        roots: [
          () =>
            defineTool({
              kind: 'tool',
              name: 'change',
              description: 'Change one value.',
              input: z.object({ value: z.string() }),
              invoke: (input) => input.value,
            }),
        ],
      }),
    ),
  );
  await assert.rejects(
    runtime.invokeReadOnly('change', { value: 'ok' }),
    (error: unknown) => error instanceof WrongDoorError && error.readOnly === false,
  );
  assert.equal(await runtime.invoke('change', { value: 'ok' }), 'ok');

  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'tool-self-use',
          roots: [
            () =>
              defineTool({
                kind: 'tool',
                name: 'self',
                description: 'Try to use itself.',
                readOnly: true,
                input: z.object({}),
                invoke: () => 'never',
                uses: ['self'],
              }),
          ],
        }),
      ),
    ModelValidationError,
  );
});
