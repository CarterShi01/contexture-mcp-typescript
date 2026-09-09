import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { request as requestFromNode } from 'node:http';
import test from 'node:test';
import { z } from 'zod';

import {
  defineApplication,
  defineTool,
  Channels,
  ModelValidationError,
  PermissionError,
  Principal,
  RejectedError,
} from '../src/index.js';
import { ApplicationRuntime, compileApplication, currentPrincipal } from '../src/core/index.js';
import {
  RestRouter,
  RestSurface,
  type Authenticator,
  type RestRoute,
  type WebRequest,
} from '../src/web/index.js';

function runtime(): ApplicationRuntime {
  return new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'rest',
        roots: [
          () => ({
            kind: 'role',
            name: 'operations',
            description: 'Operations.',
            instructions: 'Use evidence.',
            tools: [
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'status',
                  description: 'Status.',
                  readOnly: true,
                  input: z.strictObject({
                    service: z.string(),
                    tag: z.union([z.string(), z.array(z.string())]).optional(),
                  }),
                  invoke: (input) => ({
                    status: input.service,
                    principal: currentPrincipal()?.subject ?? null,
                    ...(input.tag === undefined ? {} : { tag: input.tag }),
                  }),
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'reset',
                  description: 'Reset with no arguments.',
                  readOnly: false,
                  input: z.strictObject({}),
                  invoke: () => ({ reset: true }),
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'forbidden',
                  description: 'Reject an unauthorized caller.',
                  readOnly: true,
                  input: z.strictObject({}),
                  invoke: () => {
                    throw new PermissionError('A verified identity lacks the required scope.');
                  },
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'rejected',
                  description: 'Reject valid business input.',
                  readOnly: true,
                  input: z.strictObject({}),
                  invoke: () => {
                    throw new RejectedError('The requested change is not currently allowed.');
                  },
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'explode',
                  description: 'Fail unexpectedly.',
                  readOnly: true,
                  input: z.strictObject({}),
                  invoke: () => {
                    throw new Error('Unexpected implementation failure.');
                  },
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'probe',
                  description: 'Observe request-local context.',
                  readOnly: true,
                  input: z.strictObject({ request: z.string() }),
                  invoke: async ({ request }, context) => {
                    await delay(request === 'alpha' ? 20 : 1);
                    const host = context.host as WebRequest;
                    return {
                      contextPrincipal: context.principal?.subject ?? null,
                      currentPrincipal: currentPrincipal()?.subject ?? null,
                      header: host.headers['x-request'] ?? null,
                      query: host.query.request ?? [],
                      request,
                    };
                  },
                }),
              () =>
                defineTool({
                  kind: 'tool',
                  name: 'restart',
                  description: 'Restart.',
                  readOnly: false,
                  input: z.strictObject({ service: z.string() }),
                  invoke: (input) => ({
                    restart: input.service,
                    principal: currentPrincipal()?.subject ?? null,
                  }),
                }),
            ],
          }),
        ],
      }),
    ),
  );
}

test('REST uses an explicit allowlist over the same Binding and no arbitrary ref endpoint', async () => {
  const router = new RestRouter(runtime(), [
    { method: 'GET', path: '/v1/status', ref: 'operations/status' },
    { method: 'POST', path: '/v1/restart', ref: 'operations/restart' },
  ]);
  assert.deepEqual(await router.handle('GET', '/v1/status', { service: 'api' }), {
    status: 'api',
    principal: null,
  });
  assert.deepEqual(await router.handle('POST', '/v1/restart', { service: 'api' }), {
    restart: 'api',
    principal: null,
  });
  await assert.rejects(
    router.handle('GET', '/v1/restart', { service: 'api' }),
    ModelValidationError,
  );
  await assert.rejects(
    router.handle('GET', '/v1/arbitrary', { ref: 'operations/restart' }),
    ModelValidationError,
  );
});

test('REST route values normalize fixed grammar and remain immutable snapshots', () => {
  const routes: RestRoute[] = [
    { method: 'GET', path: ' / ', ref: ' operations/status ', status: 200 },
  ];
  const router = new RestRouter(runtime(), routes);
  routes[0] = { method: 'POST', path: '/forged', ref: 'operations/restart' };
  assert.deepEqual(router.routes, [
    { method: 'GET', path: '/', ref: 'operations/status', status: 200 },
  ]);
  assert.equal(Object.isFrozen(router.routes), true);
  assert.equal(Object.isFrozen(router.routes[0]), true);
  assert.notEqual(router.routes, router.routes);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const ref = method === 'GET' || method === 'HEAD' ? 'operations/status' : 'operations/reset';
    assert.doesNotThrow(
      () => new RestRouter(runtime(), [{ method, path: `/${method.toLowerCase()}`, ref }]),
    );
  }
  for (const status of [99, 600]) {
    assert.throws(
      () =>
        new RestRouter(runtime(), [
          { method: 'GET', path: '/status', ref: 'operations/status', status },
        ]),
      /status/,
    );
  }
  assert.throws(
    () =>
      new RestRouter(runtime(), [
        { method: 'GET', path: ' /duplicate ', ref: ' operations/status ' },
        { method: 'GET', path: '/duplicate', ref: 'operations/status' },
      ]),
    /more than once/,
  );
});

function surface(authenticate?: Authenticator) {
  return new RestSurface(
    runtime(),
    [
      { method: 'GET', path: '/v1/status', ref: 'operations/status' },
      { method: 'POST', path: '/v1/restart', ref: 'operations/restart', status: 201 },
    ],
    authenticate,
  );
}

test('REST surface turns explicit paths into real JSON HTTP behavior and authenticated runtime identity', async () => {
  let authenticated: WebRequest | undefined;
  const rest = surface(async (request) =>
    request.headers.authorization === 'Bearer alice'
      ? ((authenticated = request), new Principal({ subject: 'alice' }))
      : undefined,
  );
  const read = await rest.fetch(
    new Request('http://contexture.test/v1/status?service=api&tag=&tag=blue', {
      headers: { authorization: 'Bearer alice' },
    }),
  );
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await read.json(), { status: 'api', principal: 'alice', tag: ['', 'blue'] });
  assert.equal(authenticated?.method, 'GET');
  assert.equal(authenticated?.path, '/v1/status');
  assert.equal(authenticated?.headers.authorization, 'Bearer alice');
  assert.deepEqual(authenticated?.query, { service: ['api'], tag: ['', 'blue'] });
  assert.equal(Object.isFrozen(authenticated), true);
  assert.equal(Object.isFrozen(authenticated?.headers), true);
  assert.equal(Object.isFrozen(authenticated?.query), true);
  assert.equal(Object.isFrozen(authenticated?.query.tag), true);

  const write = await rest.fetch(
    new Request('http://contexture.test/v1/restart', {
      method: 'POST',
      headers: { authorization: 'Bearer alice', 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ service: 'api' }),
    }),
  );
  assert.equal(write.status, 201);
  assert.deepEqual(await write.json(), { restart: 'api', principal: 'alice' });

  const forged = await surface().fetch(
    new Request('http://contexture.test/v1/status?service=api', {
      headers: { 'x-oc-principal': 'founder' },
    }),
  );
  assert.deepEqual(await forged.json(), { status: 'api', principal: null });
});

test('REST surface has a fixed allowlist, HEAD fallback, and structured request failures', async () => {
  const rest = surface();
  const unpublished = await rest.fetch(new Request('http://contexture.test/operations/status'));
  assert.equal(unpublished.status, 404);
  assert.equal(
    ((await unpublished.json()) as { type: string }).type,
    'urn:contexture:problem:route-not-found',
  );

  const head = await rest.fetch(
    new Request('http://contexture.test/v1/status?service=api', { method: 'HEAD' }),
  );
  assert.equal(head.status, 200);
  assert.equal(
    head.headers.get('content-length'),
    String(JSON.stringify({ status: 'api', principal: null }).length),
  );
  assert.equal(await head.text(), '');

  const wrongMedia = await rest.fetch(
    new Request('http://contexture.test/v1/restart', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'service=api',
    }),
  );
  assert.equal(wrongMedia.status, 415);
  const wrongMediaText = await wrongMedia.text();
  assert.equal(wrongMedia.headers.get('cache-control'), 'no-store');
  assert.equal(wrongMedia.headers.get('content-type'), 'application/problem+json; charset=utf-8');
  assert.equal(
    wrongMedia.headers.get('content-length'),
    String(new TextEncoder().encode(wrongMediaText).byteLength),
  );
  assert.equal(
    (JSON.parse(wrongMediaText) as { type: string }).type,
    'urn:contexture:problem:unsupported-media-type',
  );

  const invalidArguments = await rest.fetch(
    new Request('http://contexture.test/v1/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(invalidArguments.status, 422);
  assert.equal(
    ((await invalidArguments.json()) as { type: string }).type,
    'urn:contexture:problem:invalid-arguments',
  );

  const malformed = await rest.fetch(
    new Request('http://contexture.test/v1/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
  );
  assert.equal(malformed.status, 400);
  assert.equal(
    ((await malformed.json()) as { type: string }).type,
    'urn:contexture:problem:invalid-json',
  );

  for (const body of ['[]', JSON.stringify('scalar')]) {
    await assertProblem(
      await rest.fetch(
        new Request('http://contexture.test/v1/restart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      ),
      400,
      'invalid-body',
      'Request body must be a JSON object.',
    );
  }

  const denied = await surface(() => undefined).fetch(
    new Request('http://contexture.test/v1/status?service=api'),
  );
  assert.equal(denied.status, 401);
  assert.equal(
    ((await denied.json()) as { type: string }).type,
    'urn:contexture:problem:unauthenticated',
  );

  const limited = new RestSurface(
    runtime(),
    [{ method: 'POST', path: '/v1/restart', ref: 'operations/restart' }],
    undefined,
    { maxBodyBytes: 1 },
  );
  const oversized = await limited.fetch(
    new Request('http://contexture.test/v1/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(
    ((await oversized.json()) as { type: string }).type,
    'urn:contexture:problem:body-too-large',
  );
});

test('REST gives explicitly named business failures stable problem responses', async () => {
  const rest = new RestSurface(runtime(), [
    { method: 'GET', path: '/v1/forbidden', ref: 'operations/forbidden' },
    { method: 'GET', path: '/v1/rejected', ref: 'operations/rejected' },
    { method: 'GET', path: '/v1/explode', ref: 'operations/explode' },
  ]);
  await assertProblem(
    await rest.fetch(new Request('http://contexture.test/v1/forbidden')),
    403,
    'forbidden',
    'A verified identity lacks the required scope.',
  );
  await assertProblem(
    await rest.fetch(new Request('http://contexture.test/v1/rejected')),
    422,
    'rejected',
    'The requested change is not currently allowed.',
  );
  await assertProblem(
    await rest.fetch(new Request('http://contexture.test/v1/explode')),
    500,
    'controller-failed',
    'Error',
  );

  await assertProblem(
    await surface((() => Object.freeze({})) as unknown as Authenticator).fetch(
      new Request('http://contexture.test/v1/status?service=api'),
    ),
    500,
    'invalid-authenticator',
    'Authenticator returned an invalid identity.',
  );
  await assertProblem(
    await surface(() => {
      throw new Error('Verifier is unavailable.');
    }).fetch(new Request('http://contexture.test/v1/status?service=api')),
    500,
    'invalid-authenticator',
    'Authenticator failed to establish an identity.',
  );
});

test('REST preserves explicit HEAD routes, empty command bodies, and streamed body limits', async () => {
  const explicitHead = new RestSurface(runtime(), [
    { method: 'GET', path: '/v1/status', ref: 'operations/status' },
    { method: 'HEAD', path: '/v1/status', ref: 'operations/status', status: 202 },
    { method: 'POST', path: '/v1/reset', ref: 'operations/reset' },
  ]);
  const head = await explicitHead.fetch(
    new Request('http://contexture.test/v1/status?service=api', { method: 'HEAD' }),
  );
  assert.equal(head.status, 202);
  assert.equal(await head.text(), '');
  const reset = await explicitHead.fetch(
    new Request('http://contexture.test/v1/reset', { method: 'POST' }),
  );
  assert.deepEqual(await reset.json(), { reset: true });

  const encoder = new TextEncoder();
  const chunks = [encoder.encode('{'), encoder.encode('}')];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const limited = new RestSurface(
    runtime(),
    [{ method: 'POST', path: '/v1/restart', ref: 'operations/restart' }],
    undefined,
    { maxBodyBytes: 1 },
  );
  await assertProblem(
    await limited.fetch(
      new Request('http://contexture.test/v1/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    ),
    413,
    'body-too-large',
    'Request body exceeds the configured limit.',
  );
});

test('REST rejects invalid route grammar, missing targets, and Fetch-unsafe statuses at publication time', () => {
  const service = runtime();
  const reject = (route: RestRoute): void => {
    assert.throws(() => new RestSurface(service, [route]), ModelValidationError);
  };
  reject({ method: 'TRACE' as never, path: '/trace', ref: 'operations/status' });
  reject({ method: 'GET', path: 'missing-leading-slash', ref: 'operations/status' });
  reject({ method: 'GET', path: '/hash#fragment', ref: 'operations/status' });
  reject({ method: 'GET', path: '/parameter/{id}', ref: 'operations/status' });
  reject({ method: 'GET', path: '/missing-ref', ref: ' ' });
  reject({ method: 'GET', path: '/missing-target', ref: 'operations/nope' });
  for (const status of [199, 204, 205, 304, 600]) {
    reject({ method: 'GET', path: `/status-${status}`, ref: 'operations/status', status });
  }
  assert.throws(
    () =>
      new RestSurface(service, [
        { method: 'GET', path: '/duplicate', ref: 'operations/status' },
        { method: 'GET', path: '/duplicate', ref: 'operations/status' },
      ]),
    ModelValidationError,
  );
});

test('REST surface validates HTTP route grammar and holds Channels open for its real Node listener', async () => {
  const service = runtime();
  assert.throws(
    () => new RestSurface(service, [{ method: 'GET', path: '/status/', ref: 'operations/status' }]),
    ModelValidationError,
  );
  assert.throws(
    () =>
      new RestSurface(service, [{ method: 'GET', path: '/status?x=1', ref: 'operations/status' }]),
    ModelValidationError,
  );
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
  const live = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'rest-lifecycle',
        channels,
        roots: [
          () =>
            defineTool({
              kind: 'tool',
              name: 'value',
              description: 'Value.',
              readOnly: true,
              input: z.strictObject({ name: z.string() }),
              invoke: ({ name }, context) => {
                assert.equal(context.channels, channels);
                assert.equal(channels.live, true);
                return { hello: name };
              },
            }),
        ],
      }),
    ),
  );
  const listener = new RestSurface(live, [
    { method: 'GET', path: '/v1/value', ref: 'value' },
    { method: 'HEAD', path: '/v1/value', ref: 'value', status: 202 },
  ]);
  const handle = await listener.listen();
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    assert.deepEqual(marks, ['open']);
    const [first, second] = await Promise.all([
      fetch(`${handle.url}/v1/value?name=Ada`),
      fetch(`${handle.url}/v1/value?name=Lin`),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await first.json(), { hello: 'Ada' });
    assert.deepEqual(await second.json(), { hello: 'Lin' });
    const head = await fetch(`${handle.url}/v1/value?name=Head`, { method: 'HEAD' });
    assert.equal(head.status, 202);
    assert.equal(head.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(
      head.headers.get('content-length'),
      String(new TextEncoder().encode(JSON.stringify({ hello: 'Head' })).byteLength),
    );
    assert.equal(await head.text(), '');
    const raw = await getWithIgnoredBody(`${handle.url}/v1/value?name=Query`, '{"name":"Body"}');
    assert.equal(raw.status, 200);
    assert.deepEqual(JSON.parse(raw.body), { hello: 'Query' });
    assert.deepEqual(marks, ['open']);
  } finally {
    await handle.close();
  }
  assert.deepEqual(marks, ['open', 'close']);
});

test('REST rejects method/read-only mismatches and non-Tool refs at publication time', () => {
  const service = runtime();
  assert.throws(
    () => new RestRouter(service, [{ method: 'GET', path: '/restart', ref: 'operations/restart' }]),
    ModelValidationError,
  );
  assert.throws(
    () => new RestRouter(service, [{ method: 'POST', path: '/status', ref: 'operations/status' }]),
    ModelValidationError,
  );
  assert.throws(
    () => new RestRouter(service, [{ method: 'GET', path: '/role', ref: 'operations' }]),
    ModelValidationError,
  );
});

test('REST Node listener isolates concurrent authenticated Principals and WebRequest facts', async () => {
  const rest = new RestSurface(
    runtime(),
    [{ method: 'GET', path: '/v1/probe', ref: 'operations/probe' }],
    async (request) => {
      await delay(request.query.request?.[0] === 'alpha' ? 1 : 20);
      const bearer = request.headers.authorization;
      return bearer === undefined
        ? undefined
        : new Principal({ subject: bearer.replace('Bearer ', '') });
    },
  );
  const handle = await rest.listen();
  try {
    const [alpha, beta] = await Promise.all([
      fetch(`${handle.url}/v1/probe?request=alpha`, {
        headers: { authorization: 'Bearer alice', 'x-request': 'alpha' },
      }),
      fetch(`${handle.url}/v1/probe?request=beta`, {
        headers: { authorization: 'Bearer bob', 'x-request': 'beta' },
      }),
    ]);
    assert.deepEqual(await alpha.json(), {
      contextPrincipal: 'alice',
      currentPrincipal: 'alice',
      header: 'alpha',
      query: ['alpha'],
      request: 'alpha',
    });
    assert.deepEqual(await beta.json(), {
      contextPrincipal: 'bob',
      currentPrincipal: 'bob',
      header: 'beta',
      query: ['beta'],
      request: 'beta',
    });
  } finally {
    await handle.close();
  }
});

async function assertProblem(
  response: Response,
  status: number,
  kind: string,
  detail: string,
): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/problem+json; charset=utf-8');
  const text = await response.text();
  assert.equal(
    response.headers.get('content-length'),
    String(new TextEncoder().encode(text).byteLength),
  );
  assert.deepEqual(JSON.parse(text), {
    type: `urn:contexture:problem:${kind}`,
    status,
    title: kind.replaceAll('-', ' '),
    detail,
  });
}

function getWithIgnoredBody(
  url: string,
  body: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = requestFromNode(url, {
      method: 'GET',
      headers: {
        connection: 'close',
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'application/json',
      },
    });
    request.once('error', reject);
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.end(body);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
