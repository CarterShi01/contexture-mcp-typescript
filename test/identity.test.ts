import assert from 'node:assert/strict';
import test from 'node:test';

import { Principal } from '../src/index.js';
import { Auth, principalOf } from '../src/server/index.js';

test('Auth carries a verified Principal through the SDK with claims.iss taking issuer precedence', async () => {
  const principal = new Principal({
    subject: 'person',
    clientId: 'client',
    issuer: 'https://explicit-issuer.example',
    scopes: ['zeta', 'mcp'],
    claims: { exp: 2_000_000_000, iss: 'https://claim-issuer.example', tenant: 'example' },
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
  assert.deepEqual(info.scopes, ['mcp', 'zeta']);
  const recovered = principalOf(info);
  assert.ok(recovered instanceof Principal);
  assert.notEqual(recovered, principal);
  assert.equal(recovered.issuer, 'https://claim-issuer.example');
  assert.equal(recovered.subject, 'person');
  assert.equal(recovered.clientId, 'client');
  assert.deepEqual(recovered.claims, principal.claims);
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
