import assert from 'node:assert/strict';
import test from 'node:test';

import { Principal } from '../src/index.js';
import { app } from '../src/demo/server.js';
import { Auth, buildServer, ContextureOptions } from '../src/server/index.js';

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
