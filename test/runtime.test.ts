import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, defineTool, InputValidationError, Principal } from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  currentGraph,
  currentPrincipal,
  currentRootSelection,
  currentTelemetry,
  InMemoryTelemetry,
  RefusedError,
  RootOutsideSelectionError,
  RootSelection,
  type Telemetry,
} from '../src/core/index.js';

function runtime(telemetry: Telemetry = new InMemoryTelemetry()): ApplicationRuntime {
  return new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'runtime',
        roots: [
          () => ({
            kind: 'role',
            name: 'operations',
            description: 'Operations.',
            instructions: 'Use evidence.',
            tools: [
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'status',
                  description: 'Read status.',
                  readOnly: true,
                  input: z.strictObject({ value: z.string() }),
                  invoke: async (input) => ({
                    value: input.value,
                    principal: currentPrincipal(),
                    roots: currentGraph().roots.map((node) => node.name),
                    selection: currentRootSelection().names,
                    telemetry: currentTelemetry(),
                  }),
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'restart',
                  description: 'Restart service.',
                  readOnly: false,
                  input: z.strictObject({ value: z.string() }),
                  invoke: (input) => input.value,
                }),
            ],
          }),
          () =>
            defineTool({
              kind: 'tool',
              name: 'other',
              description: 'Other root.',
              readOnly: true,
              input: z.strictObject({}),
              invoke: () => 'other',
            }),
        ],
      }),
    ),
    { telemetry },
  );
}

test('runtime validates via the disclosed Binding and enforces the fixed read/write doors', async () => {
  const telemetry = new InMemoryTelemetry();
  const service = runtime(telemetry);
  await assert.rejects(
    service.invokeReadOnly('operations/status', { value: 'api', extra: true }),
    InputValidationError,
  );
  await assert.rejects(
    service.invoke('operations/status', { value: 'api' }),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.message ===
        'operations/status is read-only, so it must be run through contexture_invoke_read_only.',
  );
  await assert.rejects(
    service.invokeReadOnly('operations/restart', { value: 'api' }),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.message ===
        'operations/restart is not read-only, so it must be run through contexture_invoke.',
  );
  assert.equal(telemetry.events.length, 1);
  assert.deepEqual(
    telemetry.events.map((event) => event.failed),
    [true],
  );
});

test('runtime scopes principal, graph, selection and telemetry to concurrent calls', async () => {
  const service = runtime();
  const alice = new Principal({ subject: 'alice', scopes: ['status.read'] });
  const bob = new Principal({ subject: 'bob', claims: { tenant: 'acme' } });
  const [first, second] = await Promise.all([
    service.invokeReadOnly('operations/status', { value: 'one' }, { principal: alice }),
    service.invokeReadOnly('operations/status', { value: 'two' }, { principal: bob }),
  ]);
  assert.deepEqual(first, {
    value: 'one',
    principal: alice,
    roots: ['operations', 'other'],
    selection: undefined,
    telemetry: currentTelemetryOutsideValue(first),
  });
  assert.deepEqual(second, {
    value: 'two',
    principal: bob,
    roots: ['operations', 'other'],
    selection: undefined,
    telemetry: currentTelemetryOutsideValue(second),
  });
  assert.throws(() => currentPrincipal(), /No Contexture Tool invocation is active/);
});

test('Principal snapshots claims and exposes identity without authorization policy', () => {
  const claims = { tenant: 'acme' };
  const principal = new Principal({
    subject: 'ada',
    clientId: 'codex',
    issuer: 'https://issuer.example',
    scopes: ['tools.read'],
    claims,
  });
  claims.tenant = 'mutated';

  assert.equal(principal.subject, 'ada');
  assert.equal(principal.scopes.has('tools.read'), true);
  assert.equal('add' in principal.scopes, false);
  assert.deepEqual(principal.claims, { tenant: 'acme' });
  assert.throws(() => {
    (principal.claims as { tenant: string }).tenant = 'forbidden';
  }, TypeError);
  assert.match(principal.toString(), /Principal\(subject="ada"/);
});

test('requested selection can only attenuate an identity ceiling and governs the handler graph', async () => {
  const compiled = compileApplication(
    defineApplication({
      name: 'selection-runtime',
      roots: [
        () =>
          defineTool({
            kind: 'tool',
            name: 'alpha',
            description: 'Alpha.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => currentGraph().roots.map((node) => node.name),
          }),
        () =>
          defineTool({
            kind: 'tool',
            name: 'beta',
            description: 'Beta.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => currentGraph().roots.map((node) => node.name),
          }),
      ],
    }),
  );
  const narrowed = new ApplicationRuntime(compiled, {
    identityCeiling: RootSelection.only('alpha'),
  });
  assert.deepEqual(await narrowed.invokeReadOnly('alpha'), ['alpha']);
  await assert.rejects(narrowed.invokeReadOnly('beta'), RootOutsideSelectionError);
  await assert.rejects(
    narrowed.invokeReadOnly('alpha', undefined, {}, RootSelection.only('beta')),
    /effective root selection is empty/,
  );
});

test('a telemetry exporter failure never replaces the observed business result or error', async () => {
  const brokenTelemetry: Telemetry = {
    record: () => Promise.reject(new Error('exporter offline')),
  };
  const service = runtime(brokenTelemetry);
  assert.deepEqual(await service.invokeReadOnly('operations/status', { value: 'api' }), {
    value: 'api',
    principal: undefined,
    roots: ['operations', 'other'],
    selection: undefined,
    telemetry: brokenTelemetry,
  });
  await assert.rejects(service.invokeReadOnly('operations/status', {}), InputValidationError);
});

function currentTelemetryOutsideValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('telemetry' in value)) {
    throw new Error('Expected a runtime Tool result.');
  }
  return (value as { readonly telemetry: unknown }).telemetry;
}
