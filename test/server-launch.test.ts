import assert from 'node:assert/strict';
import test from 'node:test';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineApplication, Principal } from '../src/index.js';
import { app } from '../src/demo/server.js';
import { Auth, buildServer, ContextureOptions, HeaderRootSelector } from '../src/server/index.js';

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
