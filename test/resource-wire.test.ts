import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineApplication } from '../src/index.js';
import {
  ApplicationRuntime,
  compileApplication,
  Disclosure,
  RootSelection,
} from '../src/core/index.js';
import { Gateway, createContextureMcpServer, Publications } from '../src/server/index.js';

test('the official SDK lists and reads only selected Contexture Resources', async () => {
  const declaration = defineApplication({
    name: 'resource-wire',
    roots: [
      () => ({
        kind: 'tool' as const,
        name: 'included',
        description: 'Included document.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => '# Included\n',
      }),
      () => ({
        kind: 'tool' as const,
        name: 'excluded',
        description: 'Excluded document.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => '# Excluded\n',
      }),
    ],
    resources: [
      {
        opens: 'included',
        uri: 'contexture://included',
        description: 'Included document.',
        mimeType: 'text/markdown',
      },
      {
        opens: 'excluded',
        uri: 'contexture://excluded',
        description: 'Excluded document.',
        mimeType: 'text/markdown',
      },
    ],
  });
  const index = compileApplication(declaration);
  const adapter = createContextureMcpServer(
    { name: 'resource-test', version: '0.0.0' },
    new Gateway(new Disclosure(index), new ApplicationRuntime(index)),
    new Publications(new Disclosure(index), new ApplicationRuntime(index), declaration),
    { selection: RootSelection.only('included') },
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
    clientInfo: { name: 'resource-test-client', version: '0.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  assert.deepEqual(await sendAndWait(client, replies, 2, 'resources/list', {}), {
    jsonrpc: '2.0',
    id: 2,
    result: {
      resources: [
        {
          uri: 'contexture://included',
          name: 'included',
          description: 'Included document.',
          mimeType: 'text/markdown',
        },
      ],
    },
  });
  assert.deepEqual(
    await sendAndWait(client, replies, 3, 'resources/read', { uri: 'contexture://included' }),
    {
      jsonrpc: '2.0',
      id: 3,
      result: {
        contents: [
          {
            uri: 'contexture://included',
            text: '# Included\n',
          },
        ],
      },
    },
  );
  await client.close();
  await adapter.server.close();
});

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
