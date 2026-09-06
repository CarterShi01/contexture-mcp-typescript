import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  currentTelemetry,
  defineApplication,
  InMemoryTelemetry,
  reportTelemetry,
} from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  Disclosure,
  type Telemetry,
} from '../src/core/index.js';
import { compileRuntimeApplication } from '../src/server/index.js';

test('telemetry aggregates actual Role/Skill opens and Tool outcomes, never discover or Tool open', async () => {
  const collector = new InMemoryTelemetry();
  const declaration = defineApplication({
    name: 'telemetry',
    telemetry: collector,
    roots: [
      () => ({
        kind: 'role',
        name: 'operations',
        description: 'Operate.',
        instructions: 'Inspect.',
        skills: [
          () => ({
            kind: 'skill',
            name: 'diagnose',
            description: 'Diagnose.',
            instructions: 'Read.',
          }),
        ],
        tools: [
          () => ({
            kind: 'tool',
            name: 'status',
            description: 'Status.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => (currentTelemetry() === collector ? 'ok' : 'wrong'),
          }),
          () => ({
            kind: 'tool',
            name: 'fail',
            description: 'Fail.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => {
              throw new Error('business failure');
            },
          }),
        ],
      }),
    ],
  });
  const application = compileRuntimeApplication(declaration);
  assert.strictEqual(application.telemetry, collector);
  assert.strictEqual(application.runtime.telemetry, collector);
  assert.strictEqual(application.disclosure.telemetry, collector);
  application.disclosure.discover();
  application.disclosure.open('operations/status');
  application.disclosure.open('operations');
  application.disclosure.open('operations/diagnose');
  assert.equal(await application.runtime.invokeReadOnly('operations/status'), 'ok');
  await assert.rejects(application.runtime.invokeReadOnly('operations/fail'), /business failure/);
  assert.deepEqual(collector.usage('operations'), {
    ref: 'operations',
    callCount: 1,
    errorCount: 0,
    lastUsedAt: collector.usage('operations').lastUsedAt,
  });
  assert.equal(collector.usage('operations/diagnose').callCount, 1);
  assert.equal(collector.usage('operations/status').callCount, 1);
  assert.deepEqual(collector.usage('operations/fail'), {
    ref: 'operations/fail',
    callCount: 1,
    errorCount: 1,
    lastUsedAt: collector.usage('operations/fail').lastUsedAt,
  });
  assert.deepEqual(collector.usage('missing'), {
    ref: 'missing',
    callCount: 0,
    errorCount: 0,
    lastUsedAt: undefined,
  });
});

test('telemetry is concurrent and exporter failures or throws cannot replace outcomes', async () => {
  const collector = new InMemoryTelemetry();
  const index = compileApplication(
    defineApplication({
      name: 'concurrent',
      roots: [
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
  );
  const runtime = new ApplicationRuntime(index, { telemetry: collector });
  await Promise.all(Array.from({ length: 40 }, () => runtime.invokeReadOnly('status')));
  assert.equal(collector.usage('status').callCount, 40);
  const broken: Telemetry = {
    record: () => {
      throw new Error('exporter failed');
    },
    usage: (ref) => ({ ref, callCount: 0, errorCount: 0, lastUsedAt: undefined }),
  };
  const disclosure = new Disclosure(index, { telemetry: broken });
  assert.equal(disclosure.open('status').ref, 'status');
  assert.equal(
    await new ApplicationRuntime(index, { telemetry: broken }).invokeReadOnly('status'),
    'ok',
  );
  await reportTelemetry(broken, 'ignored', true);
});
