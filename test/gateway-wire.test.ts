import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineApplication, InMemoryTelemetry } from '../src/index.js';
import { ApplicationRuntime, compileApplication, Disclosure } from '../src/core/index.js';
import {
  compileRuntimeApplication,
  Gateway,
  createContextureMcpServer,
} from '../src/server/index.js';

test('the official SDK exposes only the fixed gateway and preserves its two invocation doors', async () => {
  const declaration = defineApplication({
    name: 'gateway-wire',
    roots: [
      () => ({
        kind: 'tool' as const,
        name: 'read-status',
        description: 'Read status.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => 'healthy',
      }),
      () => ({
        kind: 'tool' as const,
        name: 'restart',
        description: 'Restart a service.',
        readOnly: false,
        input: z.strictObject({ service: z.string() }),
        invoke: ({ service }) => `restarted ${service}`,
      }),
    ],
  });
  const index = compileApplication(declaration);
  const adapter = createContextureMcpServer(
    { name: 'gateway-test', version: '0.0.0' },
    new Gateway(new Disclosure(index), new ApplicationRuntime(index)),
  );
  const [client, host] = InMemoryTransport.createLinkedPair();
  const replies = new Map<number, unknown>();
  client.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') replies.set(message.id, message);
  };
  await client.start();
  await adapter.server.connect(host);

  await sendAndWait(client, replies, 1, 'initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'gateway-test-client', version: '0.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listed = response(await sendAndWait(client, replies, 2, 'tools/list', {}));
  const tools = listed.tools as Array<{ readonly name: string; readonly annotations: unknown }>;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['contexture_discover', 'contexture_open', 'contexture_invoke_read_only', 'contexture_invoke'],
  );
  assert.deepEqual(
    tools.map((tool) => tool.annotations),
    [
      { readOnlyHint: true },
      { readOnlyHint: true },
      { readOnlyHint: true },
      { readOnlyHint: false },
    ],
  );

  const discover = response(
    await sendAndWait(client, replies, 3, 'tools/call', {
      name: 'contexture_discover',
      arguments: {},
    }),
  );
  assert.deepEqual(discover.structuredContent, {
    roles: [],
    skills: [],
    tools: [
      {
        kind: 'tool',
        name: 'read-status',
        description: 'Read status.',
        ref: 'read-status',
        read_only: true,
        input_schema: { type: 'object', properties: {} },
      },
      {
        kind: 'tool',
        name: 'restart',
        description: 'Restart a service.',
        ref: 'restart',
        read_only: false,
        input_schema: {
          type: 'object',
          properties: { service: { type: 'string' } },
          required: ['service'],
        },
      },
    ],
  });

  assert.deepEqual(
    response(
      await sendAndWait(client, replies, 4, 'tools/call', {
        name: 'contexture_invoke_read_only',
        arguments: { ref: 'read-status', arguments: {} },
      }),
    ).structuredContent,
    { result: 'healthy' },
  );
  assert.deepEqual(
    response(
      await sendAndWait(client, replies, 5, 'tools/call', {
        name: 'contexture_invoke',
        arguments: { ref: 'restart', arguments: { service: 'api' } },
      }),
    ).structuredContent,
    { result: 'restarted api' },
  );
  const wrongDoor = response(
    await sendAndWait(client, replies, 6, 'tools/call', {
      name: 'contexture_invoke',
      arguments: { ref: 'read-status', arguments: {} },
    }),
  );
  assert.equal(wrongDoor.isError, true);
  assert.match(
    String((wrongDoor.content as Array<{ readonly text: string }>)[0]?.text),
    /read-only/,
  );
  await client.close();
  await adapter.server.close();
});

test('the official MCP gateway shares compiled telemetry across opens and invocation', async () => {
  const telemetry = new InMemoryTelemetry();
  const application = compileRuntimeApplication(
    defineApplication({
      name: 'telemetry-wire',
      telemetry,
      roots: [
        () => ({
          kind: 'role' as const,
          name: 'operations',
          description: 'Operate.',
          instructions: 'Inspect.',
          skills: [
            () => ({
              kind: 'skill' as const,
              name: 'diagnose',
              description: 'Diagnose.',
              instructions: 'Read.',
            }),
          ],
          tools: [
            () => ({
              kind: 'tool' as const,
              name: 'status',
              description: 'Status.',
              readOnly: true,
              input: z.strictObject({}),
              invoke: () => 'ok',
            }),
          ],
        }),
      ],
    }),
  );
  const adapter = createContextureMcpServer(
    { name: 'telemetry-gateway', version: '0.0.0' },
    new Gateway(application.disclosure, application.runtime),
  );
  const [client, host] = InMemoryTransport.createLinkedPair();
  const replies = new Map<number, unknown>();
  client.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') replies.set(message.id, message);
  };
  await client.start();
  await adapter.server.connect(host);
  try {
    await sendAndWait(client, replies, 1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'telemetry-client', version: '0.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sendAndWait(client, replies, 2, 'tools/call', {
      name: 'contexture_open',
      arguments: { ref: 'operations' },
    });
    await sendAndWait(client, replies, 3, 'tools/call', {
      name: 'contexture_open',
      arguments: { ref: 'operations/diagnose' },
    });
    await sendAndWait(client, replies, 4, 'tools/call', {
      name: 'contexture_invoke_read_only',
      arguments: { ref: 'operations/status', arguments: {} },
    });
    assert.equal(telemetry.usage('operations').callCount, 1);
    assert.equal(telemetry.usage('operations/diagnose').callCount, 1);
    assert.equal(telemetry.usage('operations/status').callCount, 1);
  } finally {
    await client.close();
    await adapter.server.close();
  }
});

function response(reply: unknown): Record<string, unknown> {
  assert.ok(typeof reply === 'object' && reply !== null && 'result' in reply);
  const result = reply.result;
  assert.ok(typeof result === 'object' && result !== null);
  return result as Record<string, unknown>;
}

async function sendAndWait(
  transport: InMemoryTransport,
  replies: Map<number, unknown>,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  await transport.send({ jsonrpc: '2.0', id, method, params });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const reply = replies.get(id);
    if (reply !== undefined) return reply;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${method}.`);
}
