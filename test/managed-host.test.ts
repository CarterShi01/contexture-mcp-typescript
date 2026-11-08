import assert from 'node:assert/strict';
import { request as nodeRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { GraphError, RunLeaseService, formatReference } from '../src/managed.js';
import {
  ManagedHostAdapter,
  MANAGED_HOST_PROFILE,
  MANAGED_PROFILE_META,
  MANAGED_REFERENCE_META,
} from '../src/server/managed.js';
import type {
  ManagedHostInput,
  ManagedHostScope,
  ManagedTransportHost,
} from '../src/server/managed.js';
import type { RunLeaseContext } from '../src/managed.js';
import { barrier, hostFixture } from './managed-host-fixture.js';

function obj(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function list(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(obj);
}
const profile = { [MANAGED_PROFILE_META]: MANAGED_HOST_PROFILE };
const headers = {
  authorization: 'Bearer test-a',
  'contexture-managed-profile': MANAGED_HOST_PROFILE,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};
async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: profile, ...params } }),
  });
  const text = await response.text();
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const frames = text.split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(frames.length, 1, 'One legacy SDK SSE response is required');
    return obj(JSON.parse(frames[0]!.slice(6)));
  }
  return obj(JSON.parse(text));
}
function result(value: unknown) {
  const envelope = obj(value);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope));
  return obj(envelope.result);
}
function refused(value: unknown, code?: string) {
  const error = obj(obj(value).error);
  assert.equal(error.code, -32602, JSON.stringify(value));
  if (code !== undefined) assert.equal(obj(error.data).code, code);
}
function qualified(
  f: Awaited<ReturnType<typeof hostFixture>>,
  id: string,
  generation = f.firstGeneration,
) {
  return formatReference('graph', generation, id);
}
function invoke(ref: string, args: unknown = {}) {
  return { name: 'contexture_invoke', arguments: { ref, arguments: args } };
}

async function stdio(adapter: ManagedHostAdapter) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  let next = 0;
  const replies = new Map<number, Record<string, unknown>>();
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const message = obj(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      if (typeof message.id === 'number') replies.set(message.id, message);
    }
  });
  const connection = await adapter.connectStdio(new StdioServerTransport(input, output));
  assert.deepEqual(Object.keys(connection), ['close']);
  assert.ok(Object.isFrozen(connection));
  async function call(method: string, params: Record<string, unknown> = {}) {
    const id = ++next;
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 1000; i++) {
      const reply = replies.get(id);
      if (reply !== undefined) return reply;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Official stdio response timeout: ${method}`);
  }
  result(
    await call('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'trusted-managed-test-client', version: '0.0.0' },
      capabilities: { experimental: { [MANAGED_HOST_PROFILE]: {} } },
    }),
  );
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    call(method: string, params: Record<string, unknown> = {}) {
      return call(method, { _meta: profile, ...params });
    },
    async close() {
      await adapter.close();
      input.destroy();
      output.destroy();
    },
  };
}

test('official stdio exposes five managed gateways, pinned navigation and native invocation', async () => {
  const f = await hostFixture();
  const wire = await stdio(f.adapter());
  try {
    const tools = result(await wire.call('tools/list'));
    assert.deepEqual(
      list(tools.tools).map((t) => t.name),
      [
        'contexture_discover',
        'contexture_inspect',
        'contexture_open',
        'contexture_invoke_read_only',
        'contexture_invoke',
      ],
    );
    const routes = obj(
      result(await wire.call('tools/call', { name: 'contexture_discover', arguments: {} }))
        .structuredContent,
    );
    assert.equal(routes.generation_uuid, f.firstGeneration);
    assert.deepEqual(
      list(routes.routes).map((c) => c.ref),
      [qualified(f, 'root')],
    );
    const opened = obj(
      result(
        await wire.call('tools/call', {
          name: 'contexture_open',
          arguments: { ref: qualified(f, 'root') },
        }),
      ).structuredContent,
    );
    assert.match(String(obj(opened.owner_active).instructions), /PROGRAM one/);
    assert.equal(list(obj(opened.owner_active).process_cards).length, 1);
    assert.equal(list(opened.members).length, 4);
    assert.deepEqual(
      list(opened.uses).map((c) => c.ref),
      [qualified(f, 'reader')],
    );
    const inspected = obj(
      result(
        await wire.call('tools/call', {
          name: 'contexture_inspect',
          arguments: { refs: [qualified(f, 'reader')] },
        }),
      ).structuredContent,
    );
    assert.equal(obj(list(inspected.cards)[0]).effect, 'read_only');
    const read = obj(
      result(await wire.call('tools/call', invoke(qualified(f, 'reader')))).structuredContent,
    );
    assert.equal(read.value, 'EXACT one\n');
    assert.equal(read.generation_uuid, f.firstGeneration);
    const write = obj(
      result(await wire.call('tools/call', invoke(qualified(f, 'writer'), { value: 'written' })))
        .structuredContent,
    );
    assert.equal(obj(write.value).actor, 'actor');
    refused(
      await wire.call('tools/call', {
        name: 'contexture_invoke_read_only',
        arguments: { ref: qualified(f, 'writer'), arguments: { value: 'x' } },
      }),
      'permission_denied',
    );
    assert.deepEqual(f.calls, ['read:one', 'write:one']);
  } finally {
    await wire.close();
    await f.close();
  }
});

test('official HTTP preserves exact Prompt/Resource names, URI, MIME, text and publication references', async () => {
  const f = await hostFixture();
  const handle = await f.adapter().listen();
  try {
    const prompts = result(await rpc(handle.url, 'prompts/list'));
    assert.deepEqual(
      list(prompts.prompts).map((p) => p.name),
      ['Exact.Command', 'Prompt.Only'],
    );
    const prompt = list(prompts.prompts)[0]!;
    const ref = obj(prompt._meta)[MANAGED_REFERENCE_META];
    const got = result(
      await rpc(handle.url, 'prompts/get', {
        name: prompt.name,
        _meta: { ...profile, [MANAGED_REFERENCE_META]: ref },
      }),
    );
    const program = JSON.parse(String(obj(list(got.messages)[0]!.content).text)) as Record<
      string,
      unknown
    >;
    assert.equal(program.instructions, 'COMMAND one');
    assert.equal(obj(got._meta)[MANAGED_HOST_PROFILE] !== undefined, true);
    refused(
      await rpc(handle.url, 'tools/call', { name: 'contexture_open', arguments: { ref } }),
      'permission_denied',
    );
    refused(await rpc(handle.url, 'prompts/get', { name: prompt.name }), 'schema_invalid');
    const resources = list(result(await rpc(handle.url, 'resources/list')).resources);
    assert.deepEqual(resources, [
      {
        name: 'Exact.Document',
        uri: 'urn:document:test',
        mimeType: 'text/plain',
        _meta: { [MANAGED_REFERENCE_META]: qualified(f, 'reader') },
      },
    ]);
    const read = result(
      await rpc(handle.url, 'resources/read', {
        uri: 'urn:document:test',
        _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'reader') },
      }),
    );
    assert.deepEqual(read.contents, [{ uri: 'urn:document:test', text: 'EXACT one\n' }]);
    refused(
      await rpc(handle.url, 'resources/read', {
        uri: 'urn:document:test?alias',
        _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'reader') },
      }),
      'permission_denied',
    );
    assert.deepEqual(
      result(await rpc(handle.url, 'resources/templates/list')).resourceTemplates,
      [],
    );
    assert.deepEqual(
      result(
        await rpc(handle.url, 'completion/complete', {
          ref: { type: 'ref/prompt', name: 'Exact.Command' },
          argument: { name: 'x', value: '' },
        }),
      ).completion,
      { values: [], total: 0, hasMore: false },
    );
  } finally {
    await handle.close();
    await f.close();
  }
});

test('managed HTTP and stdio require explicit candidate negotiation, never static/source fallback', async () => {
  const f = await hostFixture();
  const handle = await f.adapter().listen();
  const wire = await stdio(f.adapter());
  try {
    refused(await wire.call('tools/list', { _meta: {} }), 'schema_invalid');
    refused(
      await rpc(handle.url, 'tools/list', { _meta: { [MANAGED_PROFILE_META]: 'accepted-v1' } }),
      'schema_invalid',
    );
    const denied = await fetch(handle.url, {
      method: 'POST',
      headers: { ...headers, 'contexture-managed-profile': 'wrong' },
      body: '{}',
    });
    assert.equal(denied.status, 400);
    refused(
      await rpc(handle.url, 'tools/list', {}, { authorization: 'Bearer wrong' }),
      'permission_denied',
    );
    refused(
      await rpc(handle.url, 'tools/call', { name: 'reader', arguments: {} }),
      'schema_invalid',
    );
    refused(
      await rpc(handle.url, 'tools/call', {
        ...invoke(qualified(f, 'reader')),
        arguments: { ref: qualified(f, 'reader'), source: 'head' },
      }),
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await wire.close();
    await handle.close();
    await f.close();
  }
});

test('all stale references fail after a swap and newly successful results report actual serving generation', async () => {
  const f = await hostFixture();
  const handle = await f.adapter().listen();
  try {
    const second = await f.swap('two');
    for (const params of [
      invoke(qualified(f, 'reader')),
      { name: 'contexture_inspect', arguments: { refs: [qualified(f, 'reader')] } },
      { name: 'contexture_open', arguments: { ref: qualified(f, 'root') } },
    ])
      refused(await rpc(handle.url, 'tools/call', params), 'permission_denied');
    refused(
      await rpc(handle.url, 'prompts/get', {
        name: 'Exact.Command',
        _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'command') },
      }),
      'permission_denied',
    );
    refused(
      await rpc(handle.url, 'resources/read', {
        uri: 'urn:document:test',
        _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'reader') },
      }),
      'permission_denied',
    );
    const fresh = obj(
      result(await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader', second))))
        .structuredContent,
    );
    assert.equal(fresh.generation_uuid, second);
    assert.equal(fresh.revision, '2');
    assert.equal(fresh.value, 'EXACT two\n');
  } finally {
    await handle.close();
    await f.close();
  }
});

test('wrong graph, hidden publication targets, missing process cards and template targets fail closed', async () => {
  const f = await hostFixture();
  const handle = await f.adapter().listen();
  try {
    refused(
      await rpc(
        handle.url,
        'tools/call',
        invoke(formatReference('otherGraph', f.firstGeneration, 'reader')),
      ),
      'permission_denied',
    );
    f.setAllowed(['root', 'reader', 'writer', 'skill']);
    refused(
      await rpc(handle.url, 'tools/call', {
        name: 'contexture_open',
        arguments: { ref: qualified(f, 'root') },
      }),
      'permission_denied',
    );
    assert.deepEqual(result(await rpc(handle.url, 'prompts/list')).prompts, []);
    f.setAllowed(['root', 'pre', 'skill']);
    refused(
      await rpc(handle.url, 'tools/call', {
        name: 'contexture_open',
        arguments: { ref: qualified(f, 'root') },
      }),
      'permission_denied',
    );
    assert.deepEqual(result(await rpc(handle.url, 'resources/list')).resources, []);
    assert.equal(f.calls.length, 0);
  } finally {
    await handle.close();
    await f.close();
  }
});

test('REST executes only exact published method/path and returns actual pinned generation', async () => {
  const f = await hostFixture();
  const handle = await f.adapter().listen();
  const origin = new URL(handle.url).origin;
  try {
    const read = await fetch(`${origin}/read`, {
      headers: { ...headers, 'contexture-reference': qualified(f, 'reader') },
    });
    assert.equal(read.status, 200);
    assert.equal(obj(await read.json()).value, 'EXACT one\n');
    assert.equal(read.headers.get('contexture-generation'), f.firstGeneration);
    const head = await fetch(`${origin}/read`, {
      method: 'HEAD',
      headers: { ...headers, 'contexture-reference': qualified(f, 'reader') },
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('contexture-generation'), f.firstGeneration);
    const write = await fetch(`${origin}/write`, {
      method: 'POST',
      headers: { ...headers, 'contexture-reference': qualified(f, 'writer') },
      body: '{"value":"written"}',
    });
    assert.equal(write.status, 200);
    assert.equal(obj(obj(await write.json()).value).actor, 'actor');
    for (const [path, method, ref] of [
      ['/read/', 'GET', qualified(f, 'reader')],
      ['/read?query=alias', 'GET', qualified(f, 'reader')],
      ['/write', 'GET', qualified(f, 'writer')],
      ['/read', 'GET', qualified(f, 'writer')],
      ['/read', 'GET', 'not-a-reference'],
    ]) {
      const denied = await fetch(`${origin}${path}`, {
        method: method!,
        headers: { ...headers, 'contexture-reference': ref! },
      });
      assert.equal(denied.status, 400);
    }
    const second = await f.swap('two');
    const stale = await fetch(`${origin}/read`, {
      headers: { ...headers, 'contexture-reference': qualified(f, 'reader') },
    });
    assert.equal(stale.status, 400);
    const fresh = await fetch(`${origin}/read`, {
      headers: { ...headers, 'contexture-reference': qualified(f, 'reader', second) },
    });
    assert.equal(obj(await fresh.json()).generation_uuid, second);
  } finally {
    await handle.close();
    await f.close();
  }
});

test('protected channel run pins survive swap, explicit upgrade moves future children, release refuses reuse', async () => {
  const f = await hostFixture();
  let run: RunLeaseContext | undefined = await f.inContext(() =>
    f.runs.create(30000, { selection: ['root'], publicationSelection: ['command', 'promptOnly'] }),
  );
  const handle = await f.adapter({ kind: 'channel', current: () => run }).listen();
  try {
    const original = run;
    const second = await f.swap('two');
    const pinned = obj(
      result(await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')))).structuredContent,
    );
    assert.equal(pinned.value, 'EXACT one\n');
    assert.equal(pinned.generation_uuid, f.firstGeneration);
    const resource = result(
      await rpc(handle.url, 'resources/read', {
        uri: 'urn:document:test',
        _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'reader') },
      }),
    );
    assert.equal(list(resource.contents)[0]!.text, 'EXACT one\n');
    const prompt = result(
      await rpc(handle.url, 'prompts/get', {
        name: 'Exact.Command',
        _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'command') },
      }),
    );
    assert.match(String(obj(list(prompt.messages)[0]!.content).text), /COMMAND one/);
    const origin = new URL(handle.url).origin;
    const rest = await fetch(`${origin}/read`, {
      headers: { ...headers, 'contexture-reference': qualified(f, 'reader') },
    });
    assert.equal(obj(await rest.json()).generation_uuid, f.firstGeneration);
    await f.inContext(() => f.runs.upgrade(original, 30000));
    refused(
      await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader'))),
      'permission_denied',
    );
    assert.equal(
      obj(
        result(await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader', second))))
          .structuredContent,
      ).generation_uuid,
      second,
    );
    await f.inContext(async () => f.runs.release(original));
    refused(await rpc(handle.url, 'tools/list'), 'permission_denied');
    run = undefined;
    assert.equal(
      obj(
        result(await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader', second))))
          .structuredContent,
      ).value,
      'EXACT two\n',
    );
  } finally {
    await handle.close();
    await f.close();
  }
});

test('approved header run carrier rechecks Host approval, actor, tenant and current selection each request', async () => {
  const f = await hostFixture();
  const run = await f.inContext(() => f.runs.create(30000, { selection: ['root'] }));
  const token = 'a'.repeat(43);
  let approvals = 0;
  let approve = true;
  const adapter = f.adapter({
    kind: 'header',
    async approve(value) {
      approvals++;
      if (!approve || value !== token) throw new GraphError('permission_denied', 'Not approved');
      return run;
    },
  });
  const handle = await adapter.listen();
  try {
    await f.swap('two');
    const carried = { 'contexture-run': token };
    assert.equal(
      obj(
        result(await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')), carried))
          .structuredContent,
      ).value,
      'EXACT one\n',
    );
    refused(
      await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')), {
        ...carried,
        authorization: 'Bearer test-b',
      }),
      'permission_denied',
    );
    refused(
      await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')), {
        ...carried,
        authorization: 'Bearer test-tenant',
      }),
      'permission_denied',
    );
    f.setScope({ selection: ['skill'] });
    refused(
      await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')), carried),
      'permission_denied',
    );
    f.setScope({ selection: ['root'] });
    approve = false;
    refused(await rpc(handle.url, 'tools/list', {}, carried), 'permission_denied');
    assert.equal(approvals, 5);
    refused(await rpc(handle.url, 'tools/list', {}, { 'contexture-run': 'bad' }), 'schema_invalid');
    await assert.rejects(adapter.connectStdio(), /HTTP-only/);
  } finally {
    await handle.close();
    await f.close();
  }
});

test('header and channel carriers are mutually exclusive and JSON cannot forge run contexts', async () => {
  const f = await hostFixture();
  const run = await f.inContext(() => f.runs.create(30000, { selection: ['root'] }));
  const handle = await f.adapter({ kind: 'channel', current: () => run }).listen();
  try {
    const guarded = f.adapter();
    try {
      await assert.rejects(
        guarded.connectStdio({ async start() {}, async close() {} }),
        /official SDK StdioServerTransport/,
      );
    } finally {
      await guarded.close();
    }
    refused(
      await rpc(handle.url, 'tools/list', {}, { 'contexture-run': 'a'.repeat(43) }),
      'schema_invalid',
    );
    refused(
      await rpc(handle.url, 'tools/list', {
        _meta: { ...profile, 'contexture-run': 'a'.repeat(43) },
      }),
      'schema_invalid',
    );
    const forged = f.adapter({
      kind: 'channel',
      current: () => JSON.parse('{}') as RunLeaseContext,
    });
    const forgedHandle = await forged.listen();
    try {
      refused(await rpc(forgedHandle.url, 'tools/list'), 'permission_denied');
    } finally {
      await forgedHandle.close();
    }
    assert.throws(
      () =>
        new ManagedHostAdapter({
          identity: { name: 'bad', version: '0' },
          runtime: f.runtime,
          host: f.host,
          runs: { service: new RunLeaseService(f.runtime), carrier: { kind: 'both' } as never },
        }),
      TypeError,
    );
  } finally {
    await handle.close();
    await f.close();
  }
});

test('an entered asynchronous request keeps exactly one native resource generation across a swap', async () => {
  const f = await hostFixture();
  const entered = barrier();
  const finish = barrier();
  f.setHandler(async (label, context) => {
    entered.resolve();
    await finish.promise;
    assert.equal(context.resource, 'reader:1');
    return `ASYNC ${label}`;
  });
  const handle = await f.adapter().listen();
  try {
    const pending = rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')));
    await entered.promise;
    await f.swap('two');
    assert.equal(f.disposed.includes('reader:1'), false);
    finish.resolve();
    const output = obj(result(await pending).structuredContent);
    assert.equal(output.value, 'ASYNC one');
    assert.equal(output.generation_uuid, f.firstGeneration);
  } finally {
    finish.resolve();
    await handle.close();
    await f.close();
  }
  assert.equal(f.disposed.includes('reader:1'), true);
});

test('revocation while business work awaits suppresses MCP, Resource and REST success', async () => {
  for (const route of ['tool', 'resource', 'rest']) {
    const f = await hostFixture();
    const entered = barrier();
    const finish = barrier();
    f.setHandler(async () => {
      entered.resolve();
      await finish.promise;
      return 'SECRET';
    });
    const handle = await f.adapter().listen();
    try {
      const pending =
        route === 'tool'
          ? rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')))
          : route === 'resource'
            ? rpc(handle.url, 'resources/read', {
                uri: 'urn:document:test',
                _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'reader') },
              })
            : fetch(`${new URL(handle.url).origin}/read`, {
                headers: { ...headers, 'contexture-reference': qualified(f, 'reader') },
              }).then(async (r) => obj(await r.json()));
      await entered.promise;
      f.revoke();
      finish.resolve();
      const output = await pending;
      assert.equal(JSON.stringify(output).includes('SECRET'), false);
      assert.ok(output.error);
    } finally {
      finish.resolve();
      await handle.close();
      await f.close();
    }
  }
});

test('authority revision or pointer movement across authorization awaits refuses before dispatch', async () => {
  for (const movement of ['policy', 'pointer']) {
    const f = await hostFixture();
    const entered = barrier();
    const finish = barrier();
    f.setVerify(async (request) => {
      if (request.operation === 'invoke') {
        entered.resolve();
        await finish.promise;
      }
    });
    const handle = await f.adapter().listen();
    try {
      const pending = rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')));
      await entered.promise;
      if (movement === 'pointer') await f.swap('two');
      else f.revoke();
      finish.resolve();
      refused(await pending, 'permission_denied');
      assert.equal(f.calls.length, 0);
    } finally {
      finish.resolve();
      await handle.close();
      await f.close();
    }
  }
});

test('unexpected Host and business errors are explicit failures without exception, credentials or success fallback', async () => {
  const f = await hostFixture();
  f.setHandler(async () => {
    throw new Error('SECRET internal stack credentials');
  });
  const handle = await f.adapter().listen();
  try {
    const error = obj((await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')))).error);
    assert.equal(error.code, -32603);
    assert.equal(JSON.stringify(error).includes('SECRET'), false);
    const read = await fetch(`${new URL(handle.url).origin}/read`, {
      headers: { ...headers, 'contexture-reference': qualified(f, 'reader') },
    });
    assert.equal(read.status, 500);
    assert.equal((await read.text()).includes('SECRET'), false);
  } finally {
    await handle.close();
    await f.close();
  }
});

test('Resource output is text-only, never String(object) coercion or schema inference', async () => {
  const f = await hostFixture();
  f.setHandler(async () => ({ not: 'a resource text contract' }));
  const handle = await f.adapter().listen();
  try {
    refused(
      await rpc(handle.url, 'resources/read', {
        uri: 'urn:document:test',
        _meta: { ...profile, [MANAGED_REFERENCE_META]: qualified(f, 'reader') },
      }),
      'contract_mismatch',
    );
  } finally {
    await handle.close();
    await f.close();
  }
});

test('native listener rejects DNS rebinding, unapproved Origin, duplicate protected headers and oversized bodies', async () => {
  const f = await hostFixture();
  const handle = await f.adapter().listen();
  try {
    const hostile = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = nodeRequest(
        handle.url,
        { method: 'POST', headers: { ...headers, host: 'evil.example' } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (part: string) => (body += part));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(hostile.status, 403);
    assert.match(hostile.body, /Invalid Host/);
    const origin = await fetch(handle.url, {
      method: 'POST',
      headers: { ...headers, origin: 'https://evil.example' },
      body: '{}',
    });
    assert.equal(origin.status, 403);
    const duplicate = await new Promise<number>((resolve, reject) => {
      const request = nodeRequest(
        handle.url,
        {
          method: 'POST',
          headers: { ...headers, 'contexture-run': ['a'.repeat(43), 'b'.repeat(43)] },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(duplicate, 400);
    const large = await fetch(handle.url, { method: 'POST', headers, body: 'x'.repeat(1_048_577) });
    assert.equal(large.status, 413);
    assert.equal(f.calls.length, 0);
  } finally {
    await handle.close();
    await f.close();
  }
});

test('cancellation and closing join entered handlers without early resource disposal or late success', async () => {
  const f = await hostFixture();
  const entered = barrier();
  const finish = barrier();
  let signal: AbortSignal | undefined;
  f.setHandler(async (_label, context) => {
    signal = context.signal;
    entered.resolve();
    await finish.promise;
    return 'LATE';
  });
  const adapter = f.adapter();
  const handle = await adapter.listen();
  try {
    const pending = rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader'))).catch(
      (e: unknown) => e,
    );
    await entered.promise;
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signal?.aborted, true);
    assert.equal(closed, false);
    assert.equal(f.disposed.includes('reader:1'), false);
    finish.resolve();
    await pending;
    await closing;
    const late = await adapter.fetch(new Request('http://localhost/read', { headers }));
    assert.equal(late.status, 400);
  } finally {
    finish.resolve();
    await adapter.close();
    await f.close();
  }
});

test('managed response budgets refuse atomic results instead of truncation or empty success', async () => {
  const f = await hostFixture();
  f.setHandler(async () => 'x'.repeat(5000));
  const handle = await f.adapter(undefined, 2000).listen();
  try {
    refused(await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader'))), 'too_large');
  } finally {
    await handle.close();
    await f.close();
  }
});

test('explicit REST navigation mounts reuse pinned native owners and cannot shadow publications', async () => {
  const f = await hostFixture();
  const adapter = new ManagedHostAdapter({
    identity: { name: 'navigation-test', version: '0' },
    runtime: f.runtime,
    host: f.host,
    navigation: [
      { path: '/nav/routes', operation: 'routes' },
      { path: '/nav/open', operation: 'open' },
      { path: '/nav/members', operation: 'members' },
      { path: '/nav/uses', operation: 'uses' },
      { path: '/nav/invoke', operation: 'invoke' },
      { path: '/nav/prompts', operation: 'prompts' },
      { path: '/nav/resources', operation: 'resources' },
      { path: '/nav/prompt', operation: 'prompt.get' },
      { path: '/nav/resource', operation: 'resource.read' },
      { path: '/read', operation: 'routes' },
    ],
  });
  const handle = await adapter.listen();
  const origin = new URL(handle.url).origin;
  async function nav(path: string, input?: Record<string, unknown>) {
    const response = await fetch(`${origin}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers,
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: obj(await response.json()) };
  }
  try {
    const routes = await nav('/nav/routes');
    assert.equal(routes.status, 200);
    assert.equal(routes.body.generation_uuid, f.firstGeneration);
    assert.deepEqual(
      list(obj(routes.body.value).routes).map((r) => r.ref),
      [qualified(f, 'root')],
    );
    const open = await nav('/nav/open', { ref: qualified(f, 'root') });
    assert.equal(list(obj(open.body.value).members).length, 4);
    assert.equal(
      list(obj((await nav('/nav/members', { ref: qualified(f, 'root') })).body.value).members)
        .length,
      4,
    );
    assert.equal(
      list(obj((await nav('/nav/uses', { ref: qualified(f, 'root') })).body.value).uses).length,
      1,
    );
    const invoked = await nav('/nav/invoke', { ref: qualified(f, 'reader'), arguments: {} });
    assert.equal(obj(invoked.body.value).value, 'EXACT one\n');
    assert.equal(list(obj((await nav('/nav/prompts')).body.value).prompts).length, 2);
    assert.equal(
      list(obj((await nav('/nav/resources')).body.value).resources)[0]!.uri,
      'urn:document:test',
    );
    const prompt = await nav('/nav/prompt', {
      name: 'Exact.Command',
      ref: qualified(f, 'command'),
    });
    assert.equal(obj(prompt.body.value).instructions, 'COMMAND one');
    const resource = await nav('/nav/resource', {
      uri: 'urn:document:test',
      ref: qualified(f, 'reader'),
    });
    assert.equal(obj(resource.body.value).text, 'EXACT one\n');
    assert.equal((await nav('/read')).status, 400);
    assert.equal((await nav('/nav/routes', {})).status, 400);
    await f.swap('two');
    assert.equal((await nav('/nav/open', { ref: qualified(f, 'root') })).status, 400);
    f.revoke();
    assert.deepEqual(obj((await nav('/nav/routes')).body.value).routes, []);
  } finally {
    await handle.close();
    await f.close();
  }
});

test('Host ports dispatch once, never fabricate a returned success or conceal native failure', async () => {
  const f = await hostFixture();
  const hosts: ManagedTransportHost[] = [
    {
      async enter<T>() {
        return undefined as T;
      },
    },
    {
      async enter<T>(_input: ManagedHostInput, dispatch: (scope: ManagedHostScope) => Promise<T>) {
        await f.host.enter(_input, dispatch);
        return undefined as T;
      },
    },
    {
      async enter(_input, dispatch) {
        await f.host.enter(_input, dispatch);
        return f.host.enter(_input, dispatch);
      },
    },
    {
      async enter() {
        throw new Error('SECRET Host admission failure');
      },
    },
  ];
  try {
    for (const host of hosts) {
      const adapter = new ManagedHostAdapter({
        identity: { name: 'broken-host', version: '0' },
        runtime: f.runtime,
        host,
      });
      const handle = await adapter.listen();
      try {
        const response = await rpc(handle.url, 'tools/call', invoke(qualified(f, 'reader')));
        assert.ok(response.error);
        assert.equal(response.result, undefined);
        assert.equal(JSON.stringify(response).includes('SECRET'), false);
      } finally {
        await handle.close();
      }
    }
    assert.equal(f.calls.length, 2, 'Only single dispatched operations may execute');
  } finally {
    await f.close();
  }
});

test('expired carried runs and current publication revocation refuse on every native transport', async () => {
  const f = await hostFixture();
  let now = 0;
  const service = new RunLeaseService(f.runtime, { clock: () => now, maxTTL: 100 });
  const run = await f.inContext(() =>
    service.create(10, { selection: ['root'], publicationSelection: ['command'] }),
  );
  const adapter = new ManagedHostAdapter({
    identity: { name: 'expired-run-test', version: '0' },
    runtime: f.runtime,
    host: f.host,
    runs: { service, carrier: { kind: 'channel', current: () => run } },
  });
  const handle = await adapter.listen();
  try {
    const fresh = result(await rpc(handle.url, 'resources/list'));
    assert.equal(list(fresh.resources).length, 1);
    now = 10;
    refused(await rpc(handle.url, 'tools/list'), 'permission_denied');
    refused(await rpc(handle.url, 'prompts/list'), 'permission_denied');
    refused(await rpc(handle.url, 'resources/list'), 'permission_denied');
    assert.equal(service.counts.runs, 0);
  } finally {
    await handle.close();
    await service.shutdown();
    await f.close();
  }
});

test('Fetch body budgets, abort and missing Host run policy refuse without dispatch', async () => {
  const f = await hostFixture();
  const adapter = f.adapter();
  try {
    const large = await adapter.fetch(
      new Request('http://127.0.0.1/mcp', { method: 'POST', headers, body: 'x'.repeat(1_048_577) }),
    );
    assert.equal(large.status, 400);
    assert.equal(obj(obj(await large.json()).error).code, -32602);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await adapter.fetch(
      new Request('http://127.0.0.1/read', {
        headers: { ...headers, 'contexture-reference': qualified(f, 'reader') },
        signal: controller.signal,
      }),
    );
    assert.equal(cancelled.status, 400);
    const carried = await adapter.fetch(
      new Request('http://127.0.0.1/read', {
        headers: {
          ...headers,
          'contexture-reference': qualified(f, 'reader'),
          'contexture-run': 'a'.repeat(43),
        },
      }),
    );
    assert.equal(carried.status, 400);
    assert.equal(f.calls.length, 0);
  } finally {
    await adapter.close();
    await f.close();
  }
});

test(
  'real process stdio pipes execute official MCP and drain the trusted Host on EOF',
  { timeout: 60000 },
  async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./managed-host-stdio.ts', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const replies = new Map<number, Record<string, unknown>>();
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const end = stdout.indexOf('\n');
        if (end < 0) break;
        const response = obj(JSON.parse(stdout.slice(0, end)));
        assert.equal(response.jsonrpc, '2.0');
        stdout = stdout.slice(end + 1);
        if (typeof response.id === 'number') replies.set(response.id, response);
      }
    });
    let id = 0;
    async function call(method: string, params: Record<string, unknown>) {
      const current = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
      for (let i = 0; i < 10000; i++) {
        const reply = replies.get(current);
        if (reply !== undefined) return result(reply);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Native stdio child timeout: ${stderr}`);
    }
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    try {
      await call('initialize', {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'real-native-client', version: '0' },
        capabilities: {},
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      const discovered = obj(
        (await call('tools/call', { name: 'contexture_discover', arguments: {}, _meta: profile }))
          .structuredContent,
      );
      const rootRef = String(list(discovered.routes)[0]!.ref);
      const opened = obj(
        (
          await call('tools/call', {
            name: 'contexture_open',
            arguments: { ref: rootRef },
            _meta: profile,
          })
        ).structuredContent,
      );
      const reader = list(opened.members).find((card) => card.name === 'Read');
      assert.ok(reader);
      const invoked = obj(
        (await call('tools/call', { ...invoke(String(reader.ref)), _meta: profile }))
          .structuredContent,
      );
      assert.equal(invoked.value, 'EXACT one\n');
      assert.equal(invoked.generation_uuid, discovered.generation_uuid);
      assert.equal(list((await call('resources/list', { _meta: profile })).resources).length, 1);
      child.stdin.end();
      assert.equal(await exit, 0, stderr);
      assert.equal(stdout, '');
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  },
);
