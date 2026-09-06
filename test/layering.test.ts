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
  }
});
