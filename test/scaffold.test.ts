import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveNames, newProject, projectTemplate, UsageError } from '../src/cli/index.js';

test('scaffold derives one stable native name set', () => {
  assert.deepEqual(deriveNames('My Context'), {
    projectName: 'my-context',
    packageName: 'my-context',
    roleName: 'my-context-assistant',
    roleDescription: 'Answer requests about my context.',
    resourceScheme: 'my-context',
  });
  assert.throws(() => deriveNames('9lives'), UsageError);
  assert.throws(() => deriveNames('...'), UsageError);
});

test('newProject writes the complete starter and refuses to overwrite it', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'contexture-scaffold-'));
  try {
    const root = await newProject('My Context', { destination: temporary });
    await stat(path.join(root, 'assistant', 'app.js'));
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(packageJson.contexture.app, './assistant/app.js');
    for (const content of Object.values(projectTemplate(deriveNames('My Context')))) {
      assert.equal(content.includes('$'), false);
    }
    await assert.rejects(newProject('My Context', { destination: temporary }), UsageError);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
