import assert from 'node:assert/strict';
import { format, inspect } from 'node:util';
import test from 'node:test';
import { z } from 'zod';

import {
  Channels,
  defineApplication,
  defineTool,
  InputValidationError,
  Principal,
} from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  compileDisclosureApplication,
  currentGraph,
  currentPrincipal,
  currentRootSelection,
  currentTelemetry,
  InMemoryTelemetry,
  ModelValidationError,
  RootOutsideSelectionError,
  RootSelection,
  WrongDoorError,
  type ToolCallContext,
  type Telemetry,
} from '../src/core/index.js';
import { compileRuntimeApplication, Gateway } from '../src/server/index.js';

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
                  invoke: async (input) => {
                    // AsyncLocalStorage must retain each request identity
                    // across an await while another Tool call is active.
                    await Promise.resolve();
                    return {
                      value: input.value,
                      principal: currentPrincipal(),
                      roots: currentGraph().roots.map((node) => node.name),
                      selection: currentRootSelection().names,
                      telemetry: currentTelemetry(),
                    };
                  },
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
      error instanceof WrongDoorError && error.ref === 'operations/status' && error.readOnly,
  );
  await assert.rejects(
    service.invokeReadOnly('operations/restart', { value: 'api' }),
    (error: unknown) =>
      error instanceof WrongDoorError && error.ref === 'operations/restart' && !error.readOnly,
  );
  assert.equal(telemetry.events.length, 1);
  assert.deepEqual(
    telemetry.events.map((event) => event.failed),
    [true],
  );
});

test('ApplicationRuntime refuses a disclosure-only Index before it can execute', () => {
  const structural = compileDisclosureApplication(
    defineApplication({
      name: 'structural-runtime',
      roots: [
        () => ({
          kind: 'tool',
          name: 'status',
          description: 'Describe status.',
          readOnly: true,
          invoke: () => 'never bound',
        }),
      ],
    }),
  );
  assert.throws(() => new ApplicationRuntime(structural), ModelValidationError);
});

test('currentGraph and currentTelemetry reject access without an active Tool invocation', () => {
  assert.throws(() => currentGraph(), /No compiled Contexture graph is active/);
  assert.throws(() => currentTelemetry(), /No Contexture telemetry is active/);
});

test('runtime rebuilds framework ToolCallContext facts and preserves Host facts', async () => {
  const channels = new (class extends Channels {
    open() {}
    close() {}
  })();
  const telemetry = new InMemoryTelemetry();
  const trusted = new Principal({ subject: 'trusted' });
  const spoofed = new Principal({ subject: 'spoofed' });
  const host = Object.freeze({ requestId: 'host-request' });
  const signal = new AbortController().signal;
  let principalReads = 0;
  const context = {
    channels: Object.freeze({ spoofed: 'channels' }),
    telemetry: Object.freeze({ spoofed: 'telemetry' }),
    graph: Object.freeze({ spoofed: 'graph' }),
    selection: Object.freeze({ spoofed: 'selection' }),
    host,
    signal,
    get principal(): Principal {
      // The request fact is captured once. A later spread of caller state
      // must not replace the framework-owned context given to the Tool.
      principalReads += 1;
      return principalReads === 1 ? trusted : spoofed;
    },
  } as ToolCallContext;
  const runtime = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'context-injection',
        channels,
        roots: [
          () =>
            defineTool({
              kind: 'tool',
              name: 'status',
              description: 'Inspect injected request facts.',
              readOnly: true,
              input: z.strictObject({}),
              invoke: (_input, received) => {
                assert.equal(received.principal, trusted);
                assert.equal(currentPrincipal(), trusted);
                assert.equal(received.channels, channels);
                assert.equal(received.telemetry, telemetry);
                assert.equal(received.graph, currentGraph());
                assert.equal(received.selection, currentRootSelection());
                assert.equal(received.host, host);
                assert.equal(received.signal, signal);
                return 'injected';
              },
            }),
        ],
      }),
    ),
    { telemetry },
  );

  assert.equal(await runtime.invokeReadOnly('status', {}, context), 'injected');
  assert.equal(principalReads, 2);
});

test('runtime scopes principal, graph, selection and telemetry to concurrent calls', async () => {
  assert.equal(currentPrincipal(), undefined);
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
  assert.equal(currentPrincipal(), undefined);
});

test('a compiled Gateway keeps overlapping request contexts isolated across awaits', async () => {
  let arrived = 0;
  let releaseBoth!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const application = compileRuntimeApplication(
    defineApplication({
      name: 'gateway-runtime-context',
      roots: [
        () =>
          defineTool({
            kind: 'tool',
            name: 'who',
            description: 'Return the serving caller.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: async (_input, context) => {
              const principal = currentPrincipal();
              const graph = currentGraph();
              const selection = currentRootSelection();
              arrived += 1;
              if (arrived === 2) releaseBoth();
              await bothArrived;
              await Promise.resolve();
              assert.equal(currentPrincipal(), principal);
              assert.equal(currentGraph(), graph);
              assert.equal(currentRootSelection(), selection);
              assert.equal(context.principal, principal);
              assert.equal(context.graph, graph);
              assert.equal(context.selection, selection);
              return principal?.subject;
            },
          }),
      ],
    }),
  );
  const gateway = new Gateway(application.disclosure, application.runtime);
  const [alice, bob] = await Promise.all([
    gateway.invokeReadOnly('who', {}, { principal: new Principal({ subject: 'alice' }) }),
    gateway.invokeReadOnly('who', {}, { principal: new Principal({ subject: 'bob' }) }),
  ]);
  assert.equal(alice, 'alice');
  assert.equal(bob, 'bob');
});

test('runtime scopes the final attenuated selection independently for concurrent calls', async () => {
  let arrived = 0;
  let releaseBoth!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const graphs: ReturnType<typeof currentGraph>[] = [];
  const selections: RootSelection[] = [];
  const compiled = compileApplication(
    defineApplication({
      name: 'selection-scopes',
      roots: [
        () =>
          defineTool({
            kind: 'tool',
            name: 'alpha',
            description: 'Alpha.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: async () => {
              const graph = currentGraph();
              const selection = currentRootSelection();
              graphs.push(graph);
              selections.push(selection);
              arrived += 1;
              if (arrived === 2) releaseBoth();
              await bothArrived;
              await Promise.resolve();
              assert.equal(currentGraph(), graph);
              assert.equal(currentRootSelection(), selection);
              return { roots: graph.roots.map((node) => node.name), selection: selection.names };
            },
          }),
        () =>
          defineTool({
            kind: 'tool',
            name: 'beta',
            description: 'Beta.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: async () => {
              const graph = currentGraph();
              const selection = currentRootSelection();
              graphs.push(graph);
              selections.push(selection);
              arrived += 1;
              if (arrived === 2) releaseBoth();
              await bothArrived;
              await Promise.resolve();
              assert.equal(currentGraph(), graph);
              assert.equal(currentRootSelection(), selection);
              return { roots: graph.roots.map((node) => node.name), selection: selection.names };
            },
          }),
      ],
    }),
  );
  const service = new ApplicationRuntime(compiled);
  const [alpha, beta] = await Promise.all([
    service.invokeReadOnly('alpha', undefined, {}, RootSelection.only('alpha')),
    service.invokeReadOnly('beta', undefined, {}, RootSelection.only('beta')),
  ]);
  assert.deepEqual(alpha, { roots: ['alpha'], selection: ['alpha'] });
  assert.deepEqual(beta, { roots: ['beta'], selection: ['beta'] });
  assert.equal(graphs.length, 2);
  assert.equal(selections.length, 2);
  assert.notEqual(graphs[0], graphs[1]);
  assert.notEqual(selections[0], selections[1]);
});

test('currentRootSelection returns the compatibility all-roots selection outside an invocation', () => {
  assert.equal(currentRootSelection().names, undefined);
});

test('Principal snapshots claims and exposes identity without authorization policy', () => {
  const nested = { region: 'us-east' };
  const claims = { tenant: 'acme', bearer: 'do-not-log', nested };
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
  assert.deepEqual(principal.claims, { tenant: 'acme', bearer: 'do-not-log', nested });
  assert.equal(principal.claims.nested, nested);
  nested.region = 'eu-west';
  assert.deepEqual(principal.claims.nested, { region: 'eu-west' });
  assert.throws(() => {
    (principal.claims as { tenant: string }).tenant = 'forbidden';
  }, TypeError);
  assert.match(principal.toString(), /Principal\(subject="ada"/);
  assert.doesNotMatch(principal.toString(), /bearer|claims/);
  assert.deepEqual(principal.toJSON(), {
    subject: 'ada',
    clientId: 'codex',
    issuer: 'https://issuer.example',
    scopes: ['tools.read'],
  });
  assert.doesNotMatch(JSON.stringify(principal), /bearer|claims|do-not-log/);
  assert.doesNotMatch(inspect(principal), /bearer|claims|do-not-log/);
  assert.doesNotMatch(format('%O', principal), /bearer|claims|do-not-log/);
  assert.match(inspect(principal), /"subject":"ada"/);
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
    /effective surface selection is empty/,
  );
});

test('a telemetry exporter failure never replaces the observed business result or error', async () => {
  const brokenTelemetry: Telemetry = {
    record: () => Promise.reject(new Error('exporter offline')),
    usage: (ref) => ({ ref, callCount: 0, errorCount: 0, lastUsedAt: undefined }),
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
