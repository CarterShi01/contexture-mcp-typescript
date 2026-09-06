import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLI_VERSION, main } from '../src/cli/index.js';

function output() {
  const out: string[] = [];
  const error: string[] = [];
  return {
    out,
    error,
    writer: { out: (line: string) => out.push(line), error: (line: string) => error.push(line) },
  };
}

test('CLI reports its version and creates a project through the real scaffold', async () => {
  const version = output();
  assert.equal(await main(['--version'], version.writer), 0);
  assert.deepEqual(version.out, [CLI_VERSION]);

  const temporary = await mkdtemp(path.join(tmpdir(), 'contexture-cli-'));
  try {
    const created = output();
    assert.equal(await main(['new', 'My Context', '--into', temporary], created.writer), 0);
    await stat(path.join(temporary, 'my-context', 'assistant', 'app.js'));
    assert.match(created.out[0] ?? '', /^Wrote /);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI sends usage errors to stderr with status two', async () => {
  const invalid = output();
  assert.equal(await main(['new'], invalid.writer), 2);
  assert.match(invalid.error[0] ?? '', /^contexture: /);
});
