import assert from 'node:assert/strict';
import test from 'node:test';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { currentPrincipal, defineApplication, Principal } from '../src/index.js';
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
