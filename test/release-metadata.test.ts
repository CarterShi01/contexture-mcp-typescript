import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';

import { PACKAGE_VERSION } from '../src/index.js';

const repositoryRoot = new URL('../', import.meta.url);

interface ReleaseMetadata {
  readonly version: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
  readonly packages?: Readonly<Record<string, { readonly version?: string }>>;
}

async function releaseMetadata(file: string): Promise<ReleaseMetadata> {
  return JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

test('public v1 release metadata, runtime vocabulary, and lockfile agree', async () => {
  const [manifest, lockfile] = await Promise.all([
    releaseMetadata('package.json'),
    releaseMetadata('package-lock.json'),
  ]);

  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.private, false);
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.equal(lockfile.version, manifest.version);
  assert.equal(lockfile.packages?.['']?.version, manifest.version);
  assert.equal(PACKAGE_VERSION, manifest.version);
});

test('release guard accepts only the matching public version tag', () => {
  const valid = spawnSync(process.execPath, ['scripts/verify-release.mjs', 'v1.0.0'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);

  const invalid = spawnSync(process.execPath, ['scripts/verify-release.mjs', 'v1.0.1'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not match version/);
});

test('release guard requires the fully conformant status', async () => {
  const guard = await readFile(new URL('../scripts/verify-release.mjs', import.meta.url), 'utf8');
  assert.match(guard, /conformance\.status !== 'conformant'/);
});
