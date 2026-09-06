import assert from 'node:assert/strict';
import test from 'node:test';

import { Principal } from '../src/index.js';
import { Auth, principalOf } from '../src/server/index.js';

test('Auth converts a verified Principal into the SDK request identity without loss', async () => {
  const principal = new Principal({
    subject: 'person',
    clientId: 'client',
    issuer: 'https://issuer.example',
    scopes: ['mcp'],
    claims: { exp: 2_000_000_000, tenant: 'example' },
  });
  const auth = new Auth(
    { verify: async () => principal },
    {
      issuer: 'https://issuer.example',
      resource: 'https://mcp.example/mcp',
      requiredScopes: ['mcp'],
    },
  );
  const info = await auth.verify('token');
  assert.equal(info.clientId, 'client');
  assert.deepEqual(info.scopes, ['mcp']);
  assert.equal(principalOf(info), principal);
});

test('Auth rejects malformed configuration and an unverifiable or unbounded token', async () => {
  assert.throws(
    () =>
      new Auth(
        { verify: async () => undefined },
        { issuer: 'issuer', resource: 'https://mcp.example/mcp' },
      ),
    /absolute http/,
  );
  const absent = new Auth(
    { verify: async () => undefined },
    { issuer: 'https://issuer.example', resource: 'https://mcp.example/mcp' },
  );
  await assert.rejects(absent.verify('token'));
  const noExpiry = new Auth(
    { verify: async () => new Principal({ subject: 'person' }) },
    { issuer: 'https://issuer.example', resource: 'https://mcp.example/mcp' },
  );
  await assert.rejects(noExpiry.verify('token'));
});
