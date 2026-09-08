import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, InputValidationError, ModelValidationError } from '../src/index.js';
import { compileApplication } from '../src/core/index.js';

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
          input: z.object({
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
      retries: {
        type: 'integer',
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      labels: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'string' },
      },
    },
    required: ['service'],
  });
  assert.throws(() => {
    const properties = binding.schema.properties as Record<string, { type: string }>;
    const service = properties.service;
    if (service === undefined) throw new Error('Expected service schema.');
    service.type = 'number';
  }, TypeError);
  assert.deepEqual(binding.schema.properties, {
    service: { type: 'string' },
    retries: {
      type: 'integer',
      minimum: -Number.MAX_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    labels: {
      type: 'object',
      propertyNames: { type: 'string' },
      additionalProperties: { type: 'string' },
    },
  });
  assert.deepEqual(await binding.call({ service: 'api', retries: 2, extra: true }, {}), {
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
  const schema = binding.schema.properties as Record<string, JsonObjectForTest>;
  const items = schema.items?.items as JsonObjectForTest;
  assert.equal(items.properties?.id?.minimum, -Number.MAX_VALUE);
  assert.equal(items.properties?.id?.maximum, Number.MAX_VALUE);
  const choice = schema.choice?.anyOf as readonly JsonObjectForTest[];
  assert.deepEqual(choice[0], {
    type: 'string',
  });
  assert.deepEqual(choice[1], {
    type: 'integer',
    minimum: -Number.MAX_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  });
});

interface JsonObjectForTest {
  readonly type?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonObjectForTest;
  readonly properties?: Readonly<Record<string, JsonObjectForTest>>;
  readonly anyOf?: readonly JsonObjectForTest[];
}

test('a Tool preserves each Zod object unknown-key policy in disclosure and invocation', async () => {
  const compile = (name: string, input: z.ZodType) => {
    const index = compileApplication(
      defineApplication({
        name,
        roots: [
          () => ({
            kind: 'tool',
            name,
            description: 'Exercise unknown keys.',
            readOnly: true,
            input,
            invoke: (value) => value,
          }),
        ],
      }),
    );
    const tool = index.find(name);
    if (tool.kind !== 'tool' || tool.binding === undefined) throw new Error('Expected a binding.');
    return tool.binding;
  };

  const strict = compile('strict', z.strictObject({ value: z.string() }));
  assert.equal(strict.schema.additionalProperties, false);
  await assert.rejects(strict.call({ value: 'ok', extra: true }, {}), InputValidationError);

  const loose = compile('loose', z.looseObject({ value: z.string() }));
  assert.deepEqual(loose.schema.additionalProperties, {});
  assert.deepEqual(await loose.call({ value: 'ok', extra: true }, {}), {
    value: 'ok',
    extra: true,
  });
});

test('a Tool rejects a non-object schema before compilation', () => {
  assert.throws(
    () =>
      compileApplication(
        defineApplication({
          name: 'scalar',
          roots: [
            () => ({
              kind: 'tool',
              name: 'scalar',
              description: 'Bad schema.',
              readOnly: true,
              input: z.string(),
              invoke: () => undefined,
            }),
          ],
        }),
      ),
    ModelValidationError,
  );
});

test('a Tool rejects Zod input behavior that JSON Schema cannot disclose faithfully', () => {
  for (const [name, value] of [
    ['coerce', z.coerce.number()],
    ['catch', z.number().catch(0)],
    ['transform', z.string().transform((item) => item.length)],
  ] as const) {
    assert.throws(
      () =>
        compileApplication(
          defineApplication({
            name,
            roots: [
              () => ({
                kind: 'tool',
                name,
                description: 'Unprojectable input behavior.',
                readOnly: true,
                input: z.object({ value }),
                invoke: () => undefined,
              }),
            ],
          }),
        ),
      ModelValidationError,
    );
  }
});
