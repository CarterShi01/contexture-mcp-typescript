import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  compileApplication,
  defineApplication,
  InputValidationError,
  ModelValidationError,
} from '../src/index.js';

test('one Tool Binding discloses the schema it validates before calling its handler', async () => {
  let calls = 0;
  const index = compileApplication(
    defineApplication({
      name: 'binding',
      roots: [
        () => ({
          kind: 'tool',
          name: 'inspect',
          description: 'Inspect one service.',
          readOnly: true,
          input: z.strictObject({
            service: z.string(),
            retries: z.number().int().optional(),
            labels: z.record(z.string(), z.string()).optional(),
          }),
          invoke: async (input) => {
            calls += 1;
            return input;
          },
        }),
      ],
    }),
  );
  const tool = index.find('inspect');
  assert.equal(tool.kind, 'tool');
  if (tool.kind !== 'tool') throw new Error('Expected a Tool.');
  const binding = tool.binding;
  if (binding === undefined) throw new Error('Expected a bound Tool.');

  assert.deepEqual(binding.schema, {
    type: 'object',
    properties: {
      service: { type: 'string' },
      retries: { type: 'integer' },
      labels: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'string' },
      },
    },
    required: ['service'],
  });
  await assert.rejects(binding.call({ service: 'api', extra: true }, {}), InputValidationError);
  assert.equal(calls, 0);
  assert.deepEqual(await binding.call({ service: 'api', retries: 2 }, {}), {
    service: 'api',
    retries: 2,
  });
  assert.equal(calls, 1);
});

test('Tool input schemas cover nullable values, arrays, enums, nested objects, and unions', async () => {
  const index = compileApplication(
    defineApplication({
      name: 'schema-corpus',
      roots: [
        () => ({
          kind: 'tool',
          name: 'corpus',
          description: 'Exercise schema parity.',
          readOnly: true,
          input: z.strictObject({
            nullable: z.string().nullable(),
            items: z.array(z.strictObject({ id: z.number() })),
            status: z.enum(['ready', 'failed']),
            choice: z.union([z.string(), z.number().int()]),
          }),
          invoke: (input) => input,
        }),
      ],
    }),
  );
  const tool = index.find('corpus');
  if (tool.kind !== 'tool') throw new Error('Expected a Tool.');
  const binding = tool.binding;
  if (binding === undefined) throw new Error('Expected a bound Tool.');
  assert.deepEqual(
    await binding.call({ nullable: null, items: [{ id: 1 }], status: 'ready', choice: 2 }, {}),
    { nullable: null, items: [{ id: 1 }], status: 'ready', choice: 2 },
  );
  await assert.rejects(
    binding.call({ nullable: null, items: [{ id: 'wrong' }], status: 'other', choice: 2 }, {}),
    InputValidationError,
  );
});

test('a Tool rejects a permissive object schema before it can disclose a misleading contract', () => {
  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'permissive',
          roots: [
            () => ({
              kind: 'tool',
              name: 'bad',
              description: 'Bad schema.',
              readOnly: true,
              input: z.object({ value: z.string() }),
              invoke: () => undefined,
            }),
          ],
        }),
      ),
    ModelValidationError,
  );
});
