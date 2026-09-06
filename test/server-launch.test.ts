import assert from 'node:assert/strict';
import test from 'node:test';

import { app } from '../src/demo/server.js';
import { buildServer, ContextureOptions } from '../src/server/index.js';

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
