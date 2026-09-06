import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServer } from '@modelcontextprotocol/server';

import { createMcpServer } from '../src/server/index.js';

test('the server seam uses the official MCP SDK', () => {
  const server = createMcpServer({ name: 'contexture-test', version: '0.0.0' });
  assert.ok(server instanceof McpServer);
});
