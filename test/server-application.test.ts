import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ControllerManager, defineApplication, type ApplicationDeclaration } from '../src/index.js';
import { compileApplication, compileDisclosureApplication } from '../src/core/index.js';
import {
  buildServer,
  compileRuntimeApplication,
  compileStructuralApplication,
} from '../src/server/index.js';

test('runtime compilation builds one bound Index shared by disclosure, invocation, and publications', async () => {
  const declaration = defineApplication({
    name: 'runtime-application',
    roots: [
      () => ({
        kind: 'role' as const,
        name: 'assistant',
        description: 'Answer requests.',
        instructions: 'Read first.',
        tools: [
          () => ({
            kind: 'tool' as const,
            name: 'read',
            description: 'Read one value.',
            readOnly: true,
            input: z.strictObject({}),
            invoke: () => 'read:ok',
          }),
        ],
      }),
    ],
    resources: [
      {
        opens: 'assistant/read',
        uri: 'contexture://assistant/read',
        description: 'Read one value.',
      },
    ],
  });
  const compiled = compileRuntimeApplication(declaration);

  assert.strictEqual(compiled.disclosure.index, compiled.index);
  assert.strictEqual(compiled.runtime.index, compiled.index);
  assert.strictEqual(compiled.publications.disclosure, compiled.disclosure);
  assert.strictEqual(compiled.publications.runtime, compiled.runtime);
  assert.equal(await compiled.runtime.invokeReadOnly('assistant/read'), 'read:ok');
  assert.equal(await compiled.publications.read('contexture://assistant/read'), 'read:ok');
  assert.equal(compiled.disclosure.open('assistant/read').ref, 'assistant/read');
});

test('structural compilation builds one unbound navigation-only MCP container', () => {
  const declaration = defineApplication({
    name: 'structural-application',
    roots: [
      () => ({
        kind: 'role' as const,
        name: 'architecture',
        description: 'Architecture.',
        instructions: 'Inspect.',
        tools: [
          () => ({
            kind: 'tool' as const,
            name: 'provider',
            description: 'Provider.',
            readOnly: true,
            invoke: () => 'never bound',
          }),
        ],
      }),
    ],
    prompts: [{ opens: 'architecture', description: 'Review architecture.' }],
  });
  const structural = compileStructuralApplication(declaration);
  assert.equal(structural.index.isBound, false);
  assert.strictEqual(structural.disclosure.index, structural.index);
  assert.strictEqual(structural.publications.disclosure, structural.disclosure);
  const card = (
    structural.disclosure.open('architecture').tools as readonly Record<string, unknown>[]
  )[0];
  assert.ok(card !== undefined);
  assert.equal('read_only' in card, false);
  assert.equal('input_schema' in card, false);
  assert.deepEqual(structural.server().gatewayNames, ['contexture_discover', 'contexture_open']);
  assert.equal(structural.publications.resourceCards().length, 0);
});

test('every public compilation route normalizes raw declarations through defineApplication', () => {
  const raw = (): ApplicationDeclaration =>
    ({
      name: ' raw compilation ',
      roots: [
        () => ({
          kind: 'skill',
          name: 'approval',
          description: 'Require approval.',
          instructions: 'Wait for a person.',
        }),
      ],
      prompts: [
        {
          opens: 'approval',
          description: 'Open approval.',
          modelMayOpen: false,
        },
      ],
    }) as ApplicationDeclaration;
  const compilers = [
    (declaration: ApplicationDeclaration) => compileApplication(declaration),
    (declaration: ApplicationDeclaration) => compileDisclosureApplication(declaration),
    (declaration: ApplicationDeclaration) => compileRuntimeApplication(declaration).index,
    (declaration: ApplicationDeclaration) => compileStructuralApplication(declaration).index,
  ];
  for (const compile of compilers) {
    assert.equal(compile(raw()).name, 'raw compilation');
  }
  assert.throws(
    () => compileRuntimeApplication(raw()).disclosure.open('approval'),
    /opened by a person/,
  );
});

test('public compilation routes reject raw Prompt and Resource declaration bypasses', () => {
  const raw = (extra: Record<string, unknown>): ApplicationDeclaration =>
    ({
      name: 'raw-bypass',
      roots: [
        () => ({
          kind: 'skill',
          name: 'approval',
          description: 'Require approval.',
          instructions: 'Wait for a person.',
        }),
      ],
      ...extra,
    }) as ApplicationDeclaration;
  const compilers = [
    (declaration: ApplicationDeclaration) => compileApplication(declaration),
    (declaration: ApplicationDeclaration) => compileDisclosureApplication(declaration),
    (declaration: ApplicationDeclaration) => compileRuntimeApplication(declaration),
    (declaration: ApplicationDeclaration) => compileStructuralApplication(declaration),
  ];
  for (const declaration of [
    raw({ prompts: [{ opens: 'approval', description: 'Open approval.', modelMayOpen: 'false' }] }),
    raw({ prompts: [{ name: ' ', opens: 'approval', description: 'Open approval.' }] }),
    raw({
      resources: [
        {
          opens: 'approval',
          uri: 'contexture://approval',
          description: 'Read approval.',
          mimeType: 1,
        },
      ],
    }),
  ]) {
    for (const compile of compilers) {
      assert.throws(() => compile(declaration), TypeError);
    }
  }
});

test('a real official MCP server preserves a raw Manager handle without invoking its lookalike lifecycle', async () => {
  const lifecycleCalls: string[] = [];
  const handle = Object.freeze({
    name: 'raw-server-handle',
    open: () => lifecycleCalls.push('open'),
    close: () => lifecycleCalls.push('close'),
  });
  const manager = new ControllerManager({ channels: handle });
  manager.registerTool(() => ({
    kind: 'tool' as const,
    name: 'status',
    description: 'Read status.',
    readOnly: true,
    input: z.strictObject({}),
    invoke: (_input, context) => {
      assert.equal(context.channels, handle);
      return 'raw-handle';
    },
  }));
  const server = buildServer(manager.application('raw-manager-server'));
  assert.equal(server.application.index.channels, handle);
  assert.throws(
    () => compileStructuralApplication(manager.application('raw-manager-structural')),
    /cannot declare Channels/,
  );
  const adapter = server.build();
  const [client, host] = InMemoryTransport.createLinkedPair();
  const replies = new Map<number, unknown>();
  client.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') replies.set(message.id, message);
  };
  await server.application.runtime.serve(async () => {
    await client.start();
    await adapter.server.connect(host);
    await sendAndWait(client, replies, 1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'raw-manager-client', version: '0.0.0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepEqual(
      response(
        await sendAndWait(client, replies, 2, 'tools/call', {
          name: 'contexture_invoke_read_only',
          arguments: { ref: 'status', arguments: {} },
        }),
      ).structuredContent,
      { result: 'raw-handle' },
    );
    await client.close();
    await adapter.server.close();
  });
  assert.deepEqual(lifecycleCalls, []);
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
