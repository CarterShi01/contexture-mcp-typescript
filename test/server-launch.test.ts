import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { Channels, currentPrincipal, defineApplication, Principal } from '../src/index.js';
import { app } from '../src/demo/server.js';
import {
  Auth,
  buildServer,
  ContextureOptions,
  HeaderRootSelector,
  ServeError,
} from '../src/server/index.js';

test('the native streamable HTTP launcher binds the official MCP transport and closes cleanly', async () => {
  const server = buildServer(app);
  const handle = await server.start(
    new ContextureOptions({ transport: 'streamable-http', port: 0 }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');
  try {
    const missing = await fetch(`${handle.url}/not-found`);
    assert.equal(missing.status, 404);
    const mcp = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(mcp.status, 500);
  } finally {
    await handle.close();
  }
});

test('the HTTP launcher rejects an unauthenticated request before MCP dispatch', async () => {
  const auth = new Auth(
    {
      verify: async (token) =>
        token === 'valid'
          ? new Principal({ subject: 'person', scopes: ['mcp'], claims: { exp: 2_000_000_000 } })
          : undefined,
    },
    {
      issuer: 'https://issuer.example',
      resource: 'https://mcp.example/mcp',
      requiredScopes: ['mcp'],
    },
  );
  const server = buildServer(app, { auth });
  const handle = await server.start(
    new ContextureOptions({ transport: 'streamable-http', port: 0 }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');
  try {
    const denied = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /Bearer/);
    const accepted = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer valid' },
      body: '{}',
    });
    assert.notEqual(accepted.status, 401);
  } finally {
    await handle.close();
  }
});

test('ContextureOptions owns HTTP auth and rejects legacy conflicts and stdio HTTP policy', async () => {
  const identity = new Auth(
    {
      verify: async () => new Principal({ subject: 'operator', claims: { exp: 2_000_000_000 } }),
    },
    { issuer: 'https://issuer.example', resource: 'https://mcp.example/mcp' },
  );
  await assert.rejects(
    buildServer(app, { auth: identity }).start(
      new ContextureOptions({ transport: 'streamable-http', auth: identity, port: 0 }),
    ),
    (error) => error instanceof ServeError && /not both/.test(error.message),
  );
  await assert.rejects(
    buildServer(app, { auth: identity }).start(),
    (error) => error instanceof ServeError && /stdio cannot use HTTP identity/.test(error.message),
  );
  await assert.rejects(
    buildServer(app, { rootSelector: new HeaderRootSelector() }).start(),
    (error) => error instanceof ServeError && /root selection/.test(error.message),
  );
  const publicOptions = new ContextureOptions({
    transport: 'streamable-http',
    host: '0.0.0.0',
    port: 0,
    allowedHosts: ['localhost:*'],
  });
  await assert.rejects(
    buildServer(app).start(publicOptions),
    (error) => error instanceof ServeError && /Pass auth/.test(error.message),
  );
  const legacyHandle = await buildServer(app, { auth: identity }).start(publicOptions);
  if (legacyHandle === undefined)
    throw new Error('HTTP startup unexpectedly returned no listener.');
  await legacyHandle.close();

  await assert.rejects(
    buildServer(app).start(
      new ContextureOptions({
        transport: 'streamable-http',
        host: 'contexture-does-not-exist.invalid',
        auth: identity,
        allowedHosts: ['contexture-does-not-exist.invalid:*'],
      }),
    ),
    (error) =>
      error instanceof ServeError &&
      /Could not resolve ContextureOptions host/.test(error.message) &&
      error.cause instanceof Error,
  );
});

test('the HTTP launcher returns 413 for declared and chunked overflow before authentication', async () => {
  let authentications = 0;
  const identity = new Auth(
    {
      verify: async () => {
        authentications += 1;
        return new Principal({ subject: 'operator', claims: { exp: 2_000_000_000 } });
      },
    },
    { issuer: 'https://issuer.example', resource: 'https://mcp.example/mcp' },
  );
  const handle = await buildServer(app).start(
    new ContextureOptions({
      transport: 'streamable-http',
      port: 0,
      auth: identity,
      maxRequestBodyBytes: 32,
    }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');
  try {
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    assert.equal(await postStatus(handle.url, body, true), 413);
    assert.equal(await postStatus(handle.url, body, false), 413);
    assert.equal(await postStatus(handle.url, body, true, 'GET'), 413);
    assert.equal(await postStatus(handle.url, body, true, 'HEAD'), 413);
    assert.equal(authentications, 0);
  } finally {
    await handle.close();
  }
});

test('localhost startup validates its concrete loopback listener and releases it on close', async () => {
  const handle = await buildServer(app).start(
    new ContextureOptions({ transport: 'streamable-http', host: 'localhost', port: 0 }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');
  const endpoint = new URL(handle.url);
  await handle.close();
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(Number(endpoint.port), endpoint.hostname, () => {
      probe.off('error', reject);
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

test('HTTP close waits for channel cleanup and propagates its failure', async () => {
  const cleanupFailure = new Error('channel cleanup failed');
  let releaseCleanup: (() => void) | undefined;
  const cleanupReleased = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let cleanupStarted = false;
  const channels = new (class extends Channels {
    open() {}

    async close() {
      cleanupStarted = true;
      await cleanupReleased;
      throw cleanupFailure;
    }
  })();
  const lifecycleApp = defineApplication({
    name: 'http-close-lifecycle',
    channels,
    roots: [
      () => ({
        kind: 'tool',
        name: 'status',
        description: 'Read status.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => 'ok',
      }),
    ],
  });
  const handle = await buildServer(lifecycleApp).start(
    new ContextureOptions({ transport: 'streamable-http', port: 0 }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');

  let closeSettled = false;
  const closeResult = handle.close().then(
    () => undefined,
    (error: unknown) => error,
  );
  void closeResult.then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupStarted, true);
  assert.equal(closeSettled, false);
  releaseCleanup?.();
  assert.strictEqual(await closeResult, cleanupFailure);
  assert.equal(closeSettled, true);
});

test('HTTP close terminates an incomplete request instead of blocking shutdown', async () => {
  const handle = await buildServer(app).start(
    new ContextureOptions({
      transport: 'streamable-http',
      port: 0,
      maxRequestBodyBytes: 1024,
    }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');

  const pending = httpRequest(handle.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
    },
  });
  pending.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    pending.once('socket', (socket) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    pending.write('{"jsonrpc":');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handle.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('HTTP close remained blocked')), 1000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    pending.destroy();
  }
});

test(
  'HTTP close waits for active Tool work before releasing Channels',
  { timeout: 3000 },
  async () => {
    let markInvocationStarted!: () => void;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    let releaseInvocation!: () => void;
    const invocationReleased = new Promise<void>((resolve) => {
      releaseInvocation = resolve;
    });
    let invocationSignal: AbortSignal | undefined;
    let channelsClosed = false;
    const channels = new (class extends Channels {
      open() {}
      close() {
        channelsClosed = true;
      }
    })();
    const activeApp = defineApplication({
      name: 'active-http-invocation',
      channels,
      roots: [
        () => ({
          kind: 'tool',
          name: 'wait',
          description: 'Wait until the test releases this invocation.',
          readOnly: true,
          input: z.strictObject({}),
          invoke: async (_input, context) => {
            invocationSignal = context.signal;
            markInvocationStarted();
            await invocationReleased;
            return 'done';
          },
        }),
      ],
    });
    const handle = await buildServer(activeApp).start(
      new ContextureOptions({ transport: 'streamable-http', port: 0 }),
    );
    if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'contexture_invoke_read_only',
          arguments: { ref: 'wait', arguments: {} },
        },
      });
      const call = httpRequest(handle.url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      });
      call.on('error', () => {});
      call.end(body);
      await invocationStarted;
      call.destroy();
      await waitUntil(() => invocationSignal?.aborted === true);

      let closeSettled = false;
      const closing = handle.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(channelsClosed, false);
      assert.equal(closeSettled, false);

      releaseInvocation();
      await closing;
      assert.equal(channelsClosed, true);
    } finally {
      releaseInvocation();
      await handle.close();
    }
  },
);

test('the authenticated streamable MCP boundary carries complete request identity without inventing a subject', async () => {
  const auth = new Auth(
    {
      verify: async (token) => {
        if (token === 'person') {
          return new Principal({
            subject: 'ada',
            clientId: 'desktop',
            issuer: 'https://explicit-issuer.example',
            scopes: ['tools.read', 'mcp'],
            claims: {
              exp: 2_000_000_000,
              iss: 'https://claim-issuer.example',
              tenant: 'acme',
            },
          });
        }
        if (token === 'machine') {
          return new Principal({
            clientId: 'automation',
            issuer: 'https://machine-issuer.example',
            scopes: ['mcp'],
            claims: { exp: 2_000_000_000, tenant: 'automation' },
          });
        }
        return undefined;
      },
    },
    {
      issuer: 'https://issuer.example',
      resource: 'https://mcp.example/mcp',
      requiredScopes: ['mcp'],
    },
  );
  const server = buildServer(
    defineApplication({
      name: 'authenticated-identity',
      roots: [
        () => ({
          kind: 'tool' as const,
          name: 'whoami',
          description: 'Read the authenticated request identity.',
          readOnly: true,
          input: z.strictObject({}),
          invoke: () => {
            const principal = currentPrincipal();
            return {
              subject: principal?.subject ?? null,
              clientId: principal?.clientId ?? null,
              issuer: principal?.issuer ?? null,
              scopes: principal === undefined ? [] : [...principal.scopes].sort(),
              claims: principal?.claims ?? null,
            };
          },
        }),
      ],
    }),
    { auth },
  );
  const handle = await server.start(
    new ContextureOptions({ transport: 'streamable-http', port: 0 }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');
  try {
    const call = (token: string, id: number) =>
      fetch(handle.url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'contexture_invoke_read_only',
            arguments: { ref: 'whoami', arguments: {} },
          },
        }),
      });

    const rejected = await call('rejected', 1);
    assert.equal(rejected.status, 401);

    const person = await call('person', 2);
    assert.equal(person.status, 200);
    assert.deepEqual(await mcpStructuredResult(person), {
      subject: 'ada',
      clientId: 'desktop',
      issuer: 'https://claim-issuer.example',
      scopes: ['mcp', 'tools.read'],
      claims: {
        exp: 2_000_000_000,
        iss: 'https://claim-issuer.example',
        tenant: 'acme',
      },
    });

    const machine = await call('machine', 3);
    assert.equal(machine.status, 200);
    assert.deepEqual(await mcpStructuredResult(machine), {
      subject: null,
      clientId: 'automation',
      issuer: 'https://machine-issuer.example',
      scopes: ['mcp'],
      claims: { exp: 2_000_000_000, tenant: 'automation' },
    });
  } finally {
    await handle.close();
  }
});

test('the HTTP root selector constructs independent root surfaces per request', async () => {
  const selected = defineApplication({
    name: 'per-request-roots',
    roots: [
      () => ({
        kind: 'tool',
        name: 'alpha',
        description: 'Alpha root.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => 'alpha',
      }),
      () => ({
        kind: 'tool',
        name: 'beta',
        description: 'Beta root.',
        readOnly: true,
        input: z.strictObject({}),
        invoke: () => 'beta',
      }),
    ],
  });
  const server = buildServer(selected, { rootSelector: new HeaderRootSelector() });
  const handle = await server.start(
    new ContextureOptions({ transport: 'streamable-http', port: 0 }),
  );
  if (handle === undefined) throw new Error('HTTP startup unexpectedly returned no listener.');
  try {
    const callDiscover = (root: string) =>
      fetch(handle.url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'contexture-roots': root,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: root,
          method: 'tools/call',
          params: { name: 'contexture_discover', arguments: {} },
        }),
      });
    const [alpha, beta] = await Promise.all([callDiscover('alpha'), callDiscover('beta')]);
    assert.equal(alpha.status, 200);
    assert.equal(beta.status, 200);
    const [alphaBody, betaBody] = await Promise.all([alpha.text(), beta.text()]);
    assert.match(alphaBody, /alpha/);
    assert.doesNotMatch(alphaBody, /beta/);
    assert.match(betaBody, /beta/);
    assert.doesNotMatch(betaBody, /alpha/);

    const initialize = (root: string) =>
      fetch(handle.url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'contexture-roots': root,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: root === 'alpha' ? 101 : 102,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: `instruction-${root}`, version: '0.0.0' },
          },
        }),
      });
    const [alphaInstructions, betaInstructions] = await Promise.all([
      initialize('alpha'),
      initialize('beta'),
    ]);
    assert.equal(alphaInstructions.status, 200);
    assert.equal(betaInstructions.status, 200);
    const [alphaDiscover, betaDiscover] = await Promise.all([
      sseResponse(alphaInstructions),
      sseResponse(betaInstructions),
    ]);
    assert.ok(alphaDiscover.result?.instructions, JSON.stringify(alphaDiscover));
    assert.match(alphaDiscover.result.instructions, /alpha/);
    assert.doesNotMatch(alphaDiscover.result?.instructions ?? '', /beta/);
    assert.match(betaDiscover.result?.instructions ?? '', /beta/);
    assert.doesNotMatch(betaDiscover.result?.instructions ?? '', /alpha/);
  } finally {
    await handle.close();
  }
});

async function sseResponse(
  response: Response,
): Promise<{ readonly result?: { readonly instructions?: string } }> {
  const text = await response.text();
  const data = text.match(/^data: (.+)$/m)?.[1];
  if (data === undefined) throw new Error(`MCP streamable response carried no JSON event: ${text}`);
  return JSON.parse(data) as { readonly result?: { readonly instructions?: string } };
}

async function mcpStructuredResult(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text.match(/^data: (.+)$/m)?.[1] ?? text;
  const body = JSON.parse(data) as { readonly result?: { readonly structuredContent?: unknown } };
  return body.result?.structuredContent;
}

function postStatus(
  url: string,
  body: string,
  declaredLength: boolean,
  method = 'POST',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer accepted',
        'content-type': 'application/json',
        ...(declaredLength ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    });
    request.once('error', reject);
    request.once('response', (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    if (declaredLength) {
      request.end(body);
    } else {
      request.write(body.slice(0, 20));
      request.end(body.slice(20));
    }
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached before timeout.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
