import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'contexture-npm-scaffold-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && command !== process.execPath,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with status ${result.status}.`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout;
}

try {
  run('npm', ['run', 'build'], repositoryRoot);
  const packed = run(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryRoot],
    repositoryRoot,
  );
  const [packageInfo] = JSON.parse(packed);
  assert.equal(
    typeof packageInfo?.filename,
    'string',
    'npm pack did not report a tarball filename',
  );

  const tarball = path.join(temporaryRoot, packageInfo.filename);
  await writeFile(
    path.join(temporaryRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
    'utf8',
  );
  run('npm', ['install', '--ignore-scripts', '--no-package-lock', tarball], temporaryRoot);

  await writeFile(
    path.join(temporaryRoot, 'create-project.mjs'),
    [
      "import { newProject } from '@contexture/mcp/cli';",
      "const root = await newProject('Generated Context', { destination: process.cwd() });",
      'process.stdout.write(root);',
    ].join('\n'),
    'utf8',
  );
  const projectRoot = run(process.execPath, ['create-project.mjs'], temporaryRoot).trim();
  assert.equal(path.basename(projectRoot), 'generated-context');

  const command = path.join(
    temporaryRoot,
    'node_modules',
    '@contexture',
    'mcp',
    'dist',
    'cli',
    'main.js',
  );
  const runContexture = (args, cwd) => run(process.execPath, [command, ...args], cwd);
  assert.match(
    runContexture(['check'], projectRoot),
    /OK generated-context: 1 role\(s\), 1 skill\(s\), 1 tool\(s\)/,
  );
  assert.match(runContexture(['list'], projectRoot), /generated-context-assistant/);
  const inspected = JSON.parse(runContexture(['inspect', '--all', '--json'], projectRoot));
  assert.equal(inspected.steps.length, 5);
  assert.deepEqual(
    JSON.parse(
      runContexture(
        ['call', 'generated-context-assistant/ping', '--input', '{"target":"local"}'],
        projectRoot,
      ),
    ),
    { target: 'local', healthy: true },
  );
  process.stdout.write('packed scaffold consumer completes check, list, inspect, and call\n');
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
