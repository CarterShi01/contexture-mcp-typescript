import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  ApplicationRuntime,
  compileApplication,
  defineApplication,
  Disclosure,
  Gateway,
} from '../src/index.js';
import { createContextureMcpServer, createMcpServer } from '../src/server/index.js';

test('the server seam uses the official MCP SDK', () => {
  const server = createMcpServer({ name: 'contexture-test', version: '0.0.0' });
  assert.ok(server instanceof McpServer);
});

test('the SDK receives exactly the four Contexture gateway tools, never a business Tool', () => {
  const index = compileApplication(
    defineApplication({
      name: 'server-test',
      roots: [
        () => ({
          kind: 'tool',
          name: 'business_status',
          description: 'Business Tool.',
          readOnly: true,
          input: z.strictObject({}),
          invoke: () => 'ok',
        }),
      ],
    }),
  );
  const gateway = new Gateway(new Disclosure(index), new ApplicationRuntime(index));
  const adapter = createContextureMcpServer({ name: 'contexture-test', version: '0.0.0' }, gateway);
  assert.deepEqual(adapter.gatewayNames, [
    'contexture_discover',
    'contexture_open',
    'contexture_invoke_read_only',
    'contexture_invoke',
  ]);
  const registered = Reflect.get(adapter.server, '_registeredTools');
  assert.ok(typeof registered === 'object' && registered !== null && !Array.isArray(registered));
  const names = Object.keys(registered);
  assert.deepEqual(names, adapter.gatewayNames);
  assert.equal(Object.hasOwn(registered, 'business_status'), false);
});
