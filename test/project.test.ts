import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findProject, loadApplication, UsageError } from '../src/cli/index.js';

test('project discovery walks to the nearest native configuration and loads its app', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'contexture-project-'));
  const nested = path.join(root, 'deep', 'inside');
  try {
    await mkdir(path.join(root, 'assistant'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ type: 'module', contexture: { app: './assistant/app.mjs' } }),
    );
    await writeFile(
      path.join(root, 'assistant', 'app.mjs'),
      "export const app = { name: 'example', roots: [] };\n",
    );

    assert.deepEqual(await findProject(nested), { root, app: './assistant/app.mjs' });
    const loaded = await loadApplication({ start: nested });
    assert.equal(loaded.project?.root, root);
    assert.equal(loaded.application.name, 'example');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project configuration and targets fail with actionable usage errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'contexture-project-invalid-'));
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ contexture: { app: './assistant/app.mjs', roots: ['./legacy.mjs'] } }),
    );
    await assert.rejects(() => findProject(root), UsageError);

    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await assert.rejects(() => loadApplication({ start: root }), UsageError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
