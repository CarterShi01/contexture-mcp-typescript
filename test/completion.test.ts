import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { defineApplication } from '../src/index.js';
import { ApplicationRuntime, compileApplication, Disclosure } from '../src/core/index.js';
import { Gateway, createContextureMcpServer, Publications } from '../src/server/index.js';

test('the official SDK returns selected goto completions with the real total and truncation flag', async () => {
  const declaration = defineApplication({
    name: 'completion-wire',
    roots: Array.from({ length: 101 }, (_, number) => () => ({
      kind: 'skill' as const,
      name: `capability-${String(number).padStart(3, '0')}`,
      description: `Capability ${number}.`,
      instructions: 'Use it.',
    })),
  });
  const index = compileApplication(declaration);
  const publications = new Publications(
    new Disclosure(index),
    new ApplicationRuntime(index),
    declaration,
  );
  const adapter = createContextureMcpServer(
    { name: 'completion-test', version: '0.0.0' },
    new Gateway(new Disclosure(index), new ApplicationRuntime(index)),
    publications,
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
    clientInfo: { name: 'completion-test-client', version: '0.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const completion = await sendAndWait(client, replies, 2, 'completion/complete', {
    ref: { type: 'ref/prompt', name: 'goto' },
    argument: { name: 'ref', value: 'capability' },
  });
  assert.deepEqual(completion, {
    jsonrpc: '2.0',
    id: 2,
    result: {
      completion: {
        values: Array.from(
          { length: 100 },
          (_, number) => `capability-${String(number).padStart(3, '0')}`,
        ),
        total: 101,
        hasMore: true,
      },
    },
  });

  const unsupported = await sendAndWait(client, replies, 3, 'completion/complete', {
    ref: { type: 'ref/prompt', name: 'other-command' },
    argument: { name: 'ref', value: 'capability' },
  });
  assert.deepEqual(unsupported, {
    jsonrpc: '2.0',
    id: 3,
    result: { completion: { values: [], total: 0, hasMore: false } },
  });
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
