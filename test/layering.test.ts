import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(target) : [target];
    }),
  );
  return files.flat().filter((file) => file.endsWith('.ts'));
}

test('the core layer does not import MCP or HTTP Host SDKs', async () => {
  const core = path.resolve('src/core');
  for (const file of await sourceFiles(core)) {
    const source = await readFile(file, 'utf8');
    assert.equal(source.includes('@modelcontextprotocol/'), false, file);
    assert.equal(/from ['"](?:node:)?https?['"]/.test(source), false, file);
    assert.equal(/from ['"].*\/(?:server|web|cli)\//.test(source), false, file);
  }
});

test('the shared foundation has no dependency on higher Contexture layers', async () => {
  const foundation = path.resolve('src/core/foundation');
  for (const file of await sourceFiles(foundation)) {
    const source = await readFile(file, 'utf8');
    assert.equal(/from ['"].*\/(?:model|server|web|cli)\//.test(source), false, file);
    assert.equal(source.includes('@modelcontextprotocol/'), false, file);
  }
});

test('the MCP interface does not reach into the model or Host layers', async () => {
  const mcpInterface = path.resolve('src/core/mcp-interface');
  for (const file of await sourceFiles(mcpInterface)) {
    const source = await readFile(file, 'utf8');
    assert.equal(/from ['"].*\/(?:model|server|web|cli)\//.test(source), false, file);
    assert.equal(source.includes('@modelcontextprotocol/'), false, file);
  }
});

test('the model does not climb into the sibling MCP primitive projection', async () => {
  const model = path.resolve('src/core/model');
  for (const file of await sourceFiles(model)) {
    const source = await readFile(file, 'utf8');
    assert.equal(/from ['"].*mcp-interface\//.test(source), false, file);
  }
});

test('the declaration facade does not load a Host adapter', async () => {
  const source = await readFile(path.resolve('src/index.ts'), 'utf8');
  assert.equal(/from ['"].*\/(?:server|web|cli)\//.test(source), false);
  assert.equal(source.includes('@modelcontextprotocol/'), false);
});
