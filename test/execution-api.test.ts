import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, Principal } from '../src/index.js';
import {
  ApplicationRuntime,
  currentGraph,
  currentPrincipal,
  currentRootSelection,
  currentTelemetry,
  EXECUTION_GATEWAY,
  ExecutionAPI,
  Gateway,
  InMemoryTelemetry,
  NodeNotFoundError,
  RefusedError,
  RootOutsideSelectionError,
  RootSelection,
  WrongDoorError,
  compileApplication,
  Disclosure,
} from '../src/core/index.js';

function executionApi(ceiling: RootSelection = RootSelection.all()) {
  let promptCalls = 0;
  const telemetry = new InMemoryTelemetry();
  const index = compileApplication(
    defineApplication({
      name: 'execution-api',
      roots: [
        () => ({
          kind: 'role',
          name: 'operations',
          description: 'Operate.',
          instructions: 'Inspect.',
          tools: [
            () => ({
              kind: 'tool',
              name: 'status',
              description: 'Read status.',
              readOnly: true,
              input: z.strictObject({ value: z.string() }),
              invoke: ({ value }) => {
                assert.equal(currentPrincipal()?.subject, 'ada');
                assert.equal(currentGraph().selection.containsRef('operations/status'), true);
                assert.equal(currentGraph().selection.containsRef('prompt'), false);
                assert.equal(currentRootSelection().containsRef('operations/status'), true);
                assert.equal(currentTelemetry(), telemetry);
                return value;
              },
            }),
            () => ({
              kind: 'tool',
              name: 'change',
              description: 'Change status.',
              readOnly: false,
              input: z.strictObject({}),
              invoke: () => 'changed',
            }),
          ],
        }),
      ],
      promptRoots: [
        () => ({
          kind: 'tool',
          name: 'prompt',
          description: 'Person command.',
          readOnly: true,
          input: z.strictObject({}),
          invoke: () => {
            promptCalls += 1;
            return 'approved';
          },
        }),
      ],
    }),
  );
  const runtime = new ApplicationRuntime(index, { identityCeiling: ceiling, telemetry });
  return {
    execution: new ExecutionAPI(runtime),
    gateway: new Gateway(new Disclosure(index), runtime),
    promptCalls: () => promptCalls,
    telemetry,
  };
}

test('ExecutionAPI owns only immutable invocation doors and carries request facts', async () => {
  const { execution, telemetry } = executionApi(RootSelection.only('operations'));

  assert.equal(Object.isFrozen(execution), true);
  assert.equal(Object.isFrozen(execution.tools), true);
  assert.deepEqual(
    execution.tools.map((tool) => tool.name),
    ['contexture_invoke_read_only', 'contexture_invoke'],
  );
  assert.equal(execution.tools, EXECUTION_GATEWAY);
  assert.equal(
    await execution.invokeReadOnly(
      'operations/status',
      { value: 'healthy' },
      { principal: new Principal({ subject: 'ada' }) },
    ),
    'healthy',
  );
  assert.equal(telemetry.usage('operations/status').callCount, 1);
});

test('ExecutionAPI refuses model Prompt roots but permits the separate host read door', async () => {
  const { execution, gateway, promptCalls } = executionApi();

  await assert.rejects(
    execution.invokeReadOnly('/prompt'),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.message.includes('opened by a person') &&
      promptCalls() === 0,
  );
  assert.equal(await execution.readForHost('prompt'), 'approved');
  assert.equal(await execution.readForAHost('/prompt'), 'approved');
  assert.equal(promptCalls(), 2);
  await assert.rejects(
    gateway.invokeReadOnly('prompt'),
    (error: unknown) => error instanceof RefusedError && promptCalls() === 2,
  );
});

test('ExecutionAPI applies the root ceiling before Prompt ownership', async () => {
  const { execution, promptCalls } = executionApi(RootSelection.only('operations'));

  await assert.rejects(
    execution.invokeReadOnly('prompt'),
    (error: unknown) =>
      error instanceof RootOutsideSelectionError &&
      !(error instanceof RefusedError) &&
      !error.message.includes('person'),
  );
  await assert.rejects(
    execution.readForHost('prompt'),
    (error: unknown) => error instanceof RootOutsideSelectionError,
  );
  assert.equal(promptCalls(), 0);
});

test('ExecutionAPI recovers model mistakes while host reads preserve unexpected wrong doors', async () => {
  const { execution } = executionApi();

  await assert.rejects(
    execution.invoke('operations/status', { value: 'healthy' }),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.cause instanceof WrongDoorError &&
      error.cause.ref === 'operations/status' &&
      error.message.includes('contexture_invoke_read_only'),
  );
  await assert.rejects(
    execution.invokeReadOnly('operations/missing'),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.cause instanceof NodeNotFoundError &&
      error.message.includes('contexture_open'),
  );
  await assert.rejects(
    execution.readForHost('operations/missing'),
    (error: unknown) =>
      error instanceof RefusedError &&
      error.cause instanceof NodeNotFoundError &&
      error.message.includes('contexture_open'),
  );
  await assert.rejects(
    execution.readForHost('operations/change'),
    (error: unknown) => error instanceof WrongDoorError && !(error instanceof RefusedError),
  );
});

test('ExecutionAPI rejects an invalid runtime value at its public boundary', () => {
  assert.throws(
    () => new ExecutionAPI(undefined as unknown as ApplicationRuntime),
    /bound ApplicationRuntime/,
  );
});
