import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  Disclosure,
  RootSelection,
} from '../src/core/index.js';
import {
  buildServer,
  createContextureMcpServer,
  createMcpServer,
  Gateway,
  Publications,
  HeaderSurfaceSelector,
} from '../src/server/index.js';

test('the server seam uses the official MCP SDK', () => {
  const server = createMcpServer({ name: 'contexture-test', version: '0.0.0' });
  assert.ok(server instanceof McpServer);
});

test('a sealed Contexture server builds its default adapter exactly once', () => {
  const declaration = defineApplication({
    name: 'stable-server',
    roots: [
      () => ({
        kind: 'skill' as const,
        name: 'read',
        description: 'Read.',
        instructions: 'Read.',
      }),
    ],
  });
  const server = buildServer(declaration);
  assert.equal(server.name, 'stable-server');
  assert.equal(server.version, '0.16.0rc1');
  assert.equal(server.application.index.name, 'stable-server');
  assert.ok(server.application.runtime instanceof ApplicationRuntime);
  assert.ok(server.application.publications instanceof Publications);
  assert.ok(Object.isFrozen(server));
  assert.equal('registerTool' in server, false);
  assert.strictEqual(server.build(), server.build());
});

test('server accepts canonical surfaceSelector and rejects a legacy conflict', () => {
  const declaration = defineApplication({
    name: 'surface-selector-server',
    roots: [
      () => ({ kind: 'skill' as const, name: 'read', description: 'Read.', instructions: 'Read.' }),
    ],
  });
  const selector = new HeaderSurfaceSelector();
  assert.strictEqual(
    buildServer(declaration, { surfaceSelector: selector }).surfaceSelector,
    selector,
  );
  assert.throws(
    () => buildServer(declaration, { surfaceSelector: selector, rootSelector: selector }),
    /not both/,
  );
});

test('the official initialization response carries generated or explicit Contexture instructions', async () => {
  const declaration = defineApplication({
    name: 'instruction-server',
    roots: [
      () => ({
        kind: 'skill' as const,
        name: 'operations',
        description: 'Operate services.',
        instructions: 'Inspect first.',
      }),
    ],
  });
  const generated = await initializeInstructions(buildServer(declaration).build().server);
  assert.match(generated, /Everything this server offers is behind contexture_open\./);
  assert.match(generated, /- operations: Operate services\./);

  const explicit = await initializeInstructions(
    buildServer(declaration, { instructions: 'Use the owner-provided introduction.' }).build()
      .server,
  );
  assert.equal(explicit, 'Use the owner-provided introduction.');
});

test('the SDK receives exactly the five Contexture gateway tools, never a business Tool', () => {
  const index = compileApplication(
    defineApplication({
      name: 'server-test',
      roots: [
        () => ({
          kind: 'tool',
          name: 'business_status',
          description: 'Business Tool.',
          readOnly: true,
          input: z.object({}),
          invoke: () => 'ok',
        }),
      ],
    }),
  );
  const gateway = new Gateway(new Disclosure(index), new ApplicationRuntime(index));
  const adapter = createContextureMcpServer({ name: 'contexture-test', version: '0.0.0' }, gateway);
  assert.deepEqual(adapter.gatewayNames, [
    'contexture_discover',
    'contexture_inspect',
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
        input: z.object({}),
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

test('a fixed server root selection registers only publications inside its surface', () => {
  const declaration = defineApplication({
    name: 'selected-publications',
    roots: [
      () => ({
        kind: 'tool',
        name: 'included',
        description: 'Included.',
        readOnly: true,
        input: z.object({}),
        invoke: () => 'included',
      }),
      () => ({
        kind: 'tool',
        name: 'excluded',
        description: 'Excluded.',
        readOnly: true,
        input: z.object({}),
        invoke: () => 'excluded',
      }),
    ],
    resources: [
      { opens: 'included', uri: 'contexture://included', description: 'Included.' },
      { opens: 'excluded', uri: 'contexture://excluded', description: 'Excluded.' },
    ],
  });
  const index = compileApplication(declaration);
  const adapter = createContextureMcpServer(
    { name: 'contexture-test', version: '0.0.0' },
    new Gateway(new Disclosure(index), new ApplicationRuntime(index)),
    new Publications(new Disclosure(index), new ApplicationRuntime(index), declaration),
    { selection: RootSelection.only('included') },
  );
  assert.deepEqual(Object.keys(Reflect.get(adapter.server, '_registeredResources')), [
    'contexture://included',
  ]);
});

async function initializeInstructions(server: McpServer): Promise<string> {
  const [client, host] = InMemoryTransport.createLinkedPair();
  const replies = new Map<number, unknown>();
  client.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') replies.set(message.id, message);
  };
  await client.start();
  await server.connect(host);
  try {
    await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'instruction-client', version: '0.0.0' },
      },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const reply = replies.get(1) as
        { readonly result?: { readonly instructions?: unknown } } | undefined;
      if (reply?.result?.instructions !== undefined) {
        if (typeof reply.result.instructions !== 'string')
          throw new Error('Instructions were not text.');
        return reply.result.instructions;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('Timed out waiting for MCP initialization instructions.');
  } finally {
    await client.close();
    await server.close();
  }
}
