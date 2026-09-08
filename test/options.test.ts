import assert from 'node:assert/strict';
import test from 'node:test';

import { Principal } from '../src/index.js';
import { Auth, ContextureOptions, ServeError } from '../src/server/index.js';
import { sameBindHost, validateBoundHost } from '../src/server/options.js';

function auth(): Auth {
  return new Auth(
    { verify: async () => new Principal({ subject: 'operator', claims: { exp: 2_000_000_000 } }) },
    { issuer: 'https://issuer.example', resource: 'https://mcp.example/mcp' },
  );
}

test('serve options preserve safe local defaults and reject contradictory or public startup', () => {
  const local = new ContextureOptions({ transport: 'streamable-http' });
  assert.equal(local.url, 'http://127.0.0.1:8000/mcp');
  assert.equal(local.logLevel, 'info');
  assert.throws(() => new ContextureOptions({ logLevel: 'verbose' as never }), ServeError);
  assert.throws(() => new ContextureOptions({ host: '127.0.0.1' }), ServeError);
  assert.throws(
    () => new ContextureOptions({ transport: 'streamable-http', host: '0.0.0.0' }),
    /allowedHosts and\/or allowedOrigins/,
  );
  const deferredAccessPolicy = new ContextureOptions({
    transport: 'streamable-http',
    host: '0.0.0.0',
    allowedHosts: ['localhost'],
  });
  assert.equal(deferredAccessPolicy.auth, undefined);
  assert.equal(deferredAccessPolicy.allowAnonymous, false);
  assert.doesNotThrow(
    () =>
      new ContextureOptions({
        transport: 'streamable-http',
        host: '0.0.0.0',
        allowedHosts: ['localhost'],
        allowAnonymous: true,
      }),
  );
});

test('serve options snapshot HTTP policy and validate auth, body limits, and paths', () => {
  const hosts = ['mcp.example:*'];
  const identity = auth();
  const options = new ContextureOptions({
    transport: 'streamable-http',
    host: '0.0.0.0',
    auth: identity,
    allowedHosts: hosts,
    maxRequestBodyBytes: 1024,
  });
  hosts.push('changed.example');
  assert.deepEqual(options.allowedHosts, ['mcp.example:*']);
  assert.ok(Object.isFrozen(options.allowedHosts));
  assert.strictEqual(options.auth, identity);
  assert.equal(options.maxRequestBodyBytes, 1024);
  assert.throws(
    () =>
      new ContextureOptions({
        transport: 'streamable-http',
        host: 'fe80::1%12',
        auth: identity,
        allowedHosts: hosts,
      }),
    (error) => error instanceof ServeError && /zone identifier/.test(error.message),
  );
  assert.throws(
    () =>
      new ContextureOptions({
        transport: 'streamable-http',
        auth: {} as Auth,
      }),
    /Auth instance/,
  );
  for (const maxRequestBodyBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new ContextureOptions({ transport: 'streamable-http', maxRequestBodyBytes }),
      /positive integer/,
    );
  }
  assert.throws(
    () => new ContextureOptions({ transport: 'streamable-http', path: 'mcp' }),
    /begin with \//,
  );
  for (const path of [
    '/mcp?mode=unsafe',
    '/mcp#fragment',
    '/mcp space',
    '/mcp/é',
    '/mcp\\nested',
    '/%',
    '/%zz',
    '//',
  ]) {
    assert.throws(
      () => new ContextureOptions({ transport: 'streamable-http', path }),
      (error) => error instanceof ServeError && /path must/.test(error.message),
    );
  }
});

test('stdio reports every HTTP-only option instead of discarding it', () => {
  assert.throws(
    () =>
      new ContextureOptions({
        auth: auth(),
        maxRequestBodyBytes: 32,
        allowedOrigins: ['https://example.test'],
      }),
    (error) => {
      assert.ok(error instanceof ServeError);
      assert.match(error.message, /auth/);
      assert.match(error.message, /maxRequestBodyBytes/);
      assert.match(error.message, /allowedOrigins/);
      return true;
    },
  );
});

test('bound host validation accepts canonical loopback and resolved hostname equivalence', async () => {
  const spellings = [
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.0.0.2',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
  ];
  for (const declared of spellings) {
    for (const actual of spellings) assert.equal(sameBindHost(declared, actual), true);
  }
  for (const [declared, actual] of [
    ['localhost', '0.0.0.0'],
    ['localhost', '192.0.2.1'],
    ['mcp.example', '192.0.2.1'],
  ]) {
    assert.equal(sameBindHost(declared!, actual!), false);
  }

  const local = new ContextureOptions({ transport: 'streamable-http', host: 'localhost' });
  await assert.doesNotReject(validateBoundHost(local, '127.0.0.1'));
  await assert.doesNotReject(validateBoundHost(local, '::1'));
  await assert.rejects(validateBoundHost(local, '0.0.0.0'), /DNS rebinding protection/);

  const publicOptions = new ContextureOptions({
    transport: 'streamable-http',
    host: '0.0.0.0',
    auth: auth(),
    allowedHosts: ['mcp.example:*'],
  });
  await assert.rejects(
    validateBoundHost(publicOptions, '192.0.2.1'),
    /does not match listener bind host/,
  );

  const hostnameOptions = new ContextureOptions({
    transport: 'streamable-http',
    host: 'mcp.example',
    auth: auth(),
    allowedHosts: ['mcp.example:*'],
  });
  await assert.doesNotReject(
    validateBoundHost(hostnameOptions, '192.0.2.1', async () => ['192.0.2.1']),
  );
  await assert.rejects(
    validateBoundHost(hostnameOptions, '192.0.2.2', async () => ['192.0.2.1']),
    /does not match listener bind host/,
  );
  const resolutionFailure = new Error('name not found');
  await assert.rejects(
    validateBoundHost(hostnameOptions, '192.0.2.1', async () => {
      throw resolutionFailure;
    }),
    (error) => error instanceof ServeError && error.cause === resolutionFailure,
  );
});
