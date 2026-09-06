import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  ApplicationRuntime,
  compileApplication,
  defineApplication,
  defineTool,
  ModelValidationError,
} from '../src/index.js';
import { RestRouter } from '../src/server/index.js';

function runtime(): ApplicationRuntime {
  return new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'rest',
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
                  description: 'Status.',
                  readOnly: true,
                  input: z.strictObject({ service: z.string() }),
                  invoke: (input) => `status:${input.service}`,
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'restart',
                  description: 'Restart.',
                  readOnly: false,
                  input: z.strictObject({ service: z.string() }),
                  invoke: (input) => `restart:${input.service}`,
                }),
            ],
          }),
        ],
      }),
    ),
  );
}

test('REST uses an explicit allowlist over the same Binding and no arbitrary ref endpoint', async () => {
  const router = new RestRouter(runtime(), [
    { method: 'GET', path: '/v1/status', ref: 'operations/status' },
    { method: 'POST', path: '/v1/restart', ref: 'operations/restart' },
  ]);
  assert.equal(await router.handle('GET', '/v1/status', { service: 'api' }), 'status:api');
  assert.equal(await router.handle('POST', '/v1/restart', { service: 'api' }), 'restart:api');
  await assert.rejects(
    router.handle('GET', '/v1/restart', { service: 'api' }),
    ModelValidationError,
  );
  await assert.rejects(
    router.handle('GET', '/v1/arbitrary', { ref: 'operations/restart' }),
    ModelValidationError,
  );
});

test('REST rejects method/read-only mismatches and non-Tool refs at publication time', () => {
  const service = runtime();
  assert.throws(
    () => new RestRouter(service, [{ method: 'GET', path: '/restart', ref: 'operations/restart' }]),
    ModelValidationError,
  );
  assert.throws(
    () => new RestRouter(service, [{ method: 'POST', path: '/status', ref: 'operations/status' }]),
    ModelValidationError,
  );
  assert.throws(
    () => new RestRouter(service, [{ method: 'GET', path: '/role', ref: 'operations' }]),
    ModelValidationError,
  );
});
