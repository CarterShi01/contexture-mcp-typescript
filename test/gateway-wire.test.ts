import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { Channels, defineApplication, InMemoryTelemetry } from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  Disclosure,
  RootSelection,
} from '../src/core/index.js';
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
        input: z.object({}),
        invoke: () => 'healthy',
      }),
      () => ({
        kind: 'tool' as const,
        name: 'restart',
        description: 'Restart a service.',
        readOnly: false,
        input: z.object({ service: z.string() }),
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

test('the official MCP path injects the live nominal Channels identity into Tools', async () => {
  const marks: string[] = [];
  const channels = new (class extends Channels {
    live = false;

    open() {
      this.live = true;
      marks.push('open');
    }

    close() {
      this.live = false;
      marks.push('close');
    }
  })();
  const application = compileRuntimeApplication(
    defineApplication({
      name: 'channels-gateway',
      channels,
      roots: [
        () => ({
          kind: 'tool' as const,
          name: 'status',
          description: 'Read status.',
          readOnly: true,
          input: z.object({}),
          invoke: (_input, context) => {
            assert.equal(context.channels, channels);
            assert.equal(channels.live, true);
            return 'live';
          },
        }),
      ],
    }),
  );
  const adapter = createContextureMcpServer(
    { name: 'channels-gateway', version: '0.0.0' },
    new Gateway(application.disclosure, application.runtime),
  );
  const [client, host] = InMemoryTransport.createLinkedPair();
  const replies = new Map<number, unknown>();
  client.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') replies.set(message.id, message);
  };
  await application.runtime.serve(async () => {
    await client.start();
    await adapter.server.connect(host);
    await sendAndWait(client, replies, 1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'channels-client', version: '0.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepEqual(
      response(
        await sendAndWait(client, replies, 2, 'tools/call', {
          name: 'contexture_invoke_read_only',
          arguments: { ref: 'status', arguments: {} },
        }),
      ).structuredContent,
      { result: 'live' },
    );
    await client.close();
    await adapter.server.close();
  });
  assert.deepEqual(marks, ['open', 'close']);
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
              input: z.object({}),
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

test('the official MCP path keeps Gateway recovery when Publications guard a reserved Prompt', async () => {
  const application = compileRuntimeApplication(
    defineApplication({
      name: 'gateway-publications',
      roots: [
        () => ({
          kind: 'role' as const,
          name: 'operations',
          description: 'Operate.',
          instructions: 'Inspect.',
          skills: [
            () => ({
              kind: 'skill' as const,
              name: 'change',
              description: 'Change.',
              instructions: 'Ask.',
            }),
          ],
          tools: [
            () => ({
              kind: 'tool' as const,
              name: 'apply',
              description: 'Apply.',
              readOnly: false,
              input: z.strictObject({}),
              invoke: () => 'applied',
            }),
          ],
        }),
        () => ({
          kind: 'role' as const,
          name: 'hidden',
          description: 'Hidden.',
          instructions: 'Do not disclose.',
          skills: [
            () => ({
              kind: 'skill' as const,
              name: 'change',
              description: 'Change.',
              instructions: 'Ask.',
            }),
          ],
        }),
      ],
      prompts: [
        {
          name: 'operations-change',
          opens: 'operations/change',
          description: 'Change.',
          modelMayOpen: false,
        },
        {
          name: 'operations-apply',
          opens: 'operations/apply',
          description: 'Apply.',
          modelMayOpen: false,
        },
        {
          name: 'hidden-change',
          opens: 'hidden/change',
          description: 'Hidden change.',
          modelMayOpen: false,
        },
      ],
    }),
  );
  const adapter = createContextureMcpServer(
    { name: 'gateway-publications', version: '0.0.0' },
    new Gateway(application.disclosure, application.runtime),
    application.publications,
    { selection: RootSelection.only('operations') },
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
      clientInfo: { name: 'gateway-publications-client', version: '0.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const missing = response(
      await sendAndWait(client, replies, 2, 'tools/call', {
        name: 'contexture_open',
        arguments: { ref: 'missing' },
      }),
    );
    assert.equal(missing.isError, true);
    assert.match(
      String((missing.content as Array<{ readonly text: string }>)[0]?.text),
      /contexture_discover/,
    );

    const reserved = response(
      await sendAndWait(client, replies, 3, 'tools/call', {
        name: 'contexture_open',
        arguments: { ref: 'operations/change' },
      }),
    );
    assert.equal(reserved.isError, true);
    assert.match(
      String((reserved.content as Array<{ readonly text: string }>)[0]?.text),
      /opened by a person/,
    );

    const excluded = response(
      await sendAndWait(client, replies, 4, 'tools/call', {
        name: 'contexture_open',
        arguments: { ref: 'hidden/change' },
      }),
    );
    assert.equal(excluded.isError, true);
    const excludedText = String((excluded.content as Array<{ readonly text: string }>)[0]?.text);
    assert.doesNotMatch(excludedText, /opened by a person|operations/);

    const invoked = response(
      await sendAndWait(client, replies, 5, 'tools/call', {
        name: 'contexture_invoke',
        arguments: { ref: 'operations/apply', arguments: {} },
      }),
    );
    assert.equal(invoked.isError, true);
    assert.match(
      String((invoked.content as Array<{ readonly text: string }>)[0]?.text),
      /opened by a person/,
    );
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
