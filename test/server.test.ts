import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import { ApplicationRuntime, compileApplication, Disclosure } from '../src/core/index.js';
import {
  createContextureMcpServer,
  createMcpServer,
  Gateway,
  Publications,
} from '../src/server/index.js';

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

test('the SDK publishes Contexture Prompts and Resources as their native primitives', () => {
  const declaration = defineApplication({
    name: 'publications-server',
    roots: [
      () => ({
        kind: 'tool',
        name: 'readme',
        description: 'Read the document.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => 'document',
      }),
    ],
    prompts: [{ opens: 'readme', description: 'Open the document.' }],
    resources: [{ opens: 'readme', uri: 'contexture://readme', description: 'Read the document.' }],
  });
  const index = compileApplication(declaration);
  const runtime = new ApplicationRuntime(index);
  const adapter = createContextureMcpServer(
    { name: 'contexture-test', version: '0.0.0' },
    new Gateway(new Disclosure(index), runtime),
    new Publications(new Disclosure(index), runtime, declaration),
  );
  assert.deepEqual(Object.keys(Reflect.get(adapter.server, '_registeredPrompts')), [
    'readme',
    'goto',
  ]);
  const resources = Reflect.get(adapter.server, '_registeredResources') as Record<
    string,
    { readonly name: string }
  >;
  assert.deepEqual(Object.keys(resources), ['contexture://readme']);
  assert.equal(resources['contexture://readme']?.name, 'readme');
});
