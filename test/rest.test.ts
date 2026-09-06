import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineApplication, defineTool, ModelValidationError, Principal } from '../src/index.js';
import { ApplicationRuntime, compileApplication, currentPrincipal } from '../src/core/index.js';
import { RestRouter, RestSurface, type Authenticator, type WebRequest } from '../src/web/index.js';

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
                  }),
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
  assert.deepEqual(await read.json(), { status: 'api', principal: 'alice' });
  assert.deepEqual(authenticated?.query, { service: ['api'], tag: ['', 'blue'] });

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
  assert.throws(
    () =>
      new RestSurface(service, [
        { method: 'GET', path: '/status', ref: 'operations/status', status: 99 },
      ]),
    ModelValidationError,
  );

  const marks: string[] = [];
  const live = new ApplicationRuntime(
    compileApplication(
      defineApplication({
        name: 'rest-lifecycle',
        channels: {
          open: () => {
            marks.push('open');
          },
          close: () => {
            marks.push('close');
          },
        },
        roots: [
          () =>
            defineTool({
              kind: 'tool',
              name: 'value',
              description: 'Value.',
              readOnly: true,
              input: z.strictObject({ name: z.string() }),
              invoke: ({ name }) => ({ hello: name }),
            }),
        ],
      }),
    ),
  );
  const listener = new RestSurface(live, [{ method: 'GET', path: '/v1/value', ref: 'value' }]);
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
