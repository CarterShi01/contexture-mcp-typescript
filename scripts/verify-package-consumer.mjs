import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'contexture-npm-consumer-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        command + ' ' + args.join(' ') + ' failed with status ' + result.status + '.',
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

  const consumer = [
    "import { Principal, currentPrincipal, defineApplication } from '@contexture/mcp';",
    "import { trace } from '@contexture/mcp/inspection';",
    "import { newProject } from '@contexture/mcp/cli';",
    "import { Auth, claudeCodeConfig, compileRuntimeApplication, HeaderRootSelector, Launch } from '@contexture/mcp/server';",
    "import { RestRouter } from '@contexture/mcp/web';",
    "if (typeof defineApplication !== 'function') throw new Error('missing declaration facade');",
    "if (typeof Principal !== 'function' || typeof currentPrincipal !== 'function') throw new Error('missing root request facts');",
    "if (typeof trace !== 'function') throw new Error('missing inspection API');",
    "if (typeof newProject !== 'function') throw new Error('missing CLI scaffold API');",
    "if (typeof compileRuntimeApplication !== 'function') throw new Error('missing server facade');",
    "if (typeof HeaderRootSelector !== 'function') throw new Error('missing root selection facade');",
    "if (typeof Auth !== 'function') throw new Error('missing identity facade');",
    "if (typeof Launch !== 'function' || typeof claudeCodeConfig !== 'function') throw new Error('missing host launch facade');",
    "if (typeof RestRouter !== 'function') throw new Error('missing web facade');",
  ].join('\n');
  await writeFile(path.join(temporaryRoot, 'consumer.mjs'), consumer, 'utf8');
  run(process.execPath, ['consumer.mjs'], temporaryRoot);
  assert.equal(
    run(
      path.join(temporaryRoot, 'node_modules', '.bin', 'contexture'),
      ['--version'],
      temporaryRoot,
    ).trim(),
    '0.12.0rc1',
  );

  const installedPackage = JSON.parse(
    await readFile(
      path.join(temporaryRoot, 'node_modules', '@contexture', 'mcp', 'package.json'),
      'utf8',
    ),
  );
  assert.equal(installedPackage.name, '@contexture/mcp');
  process.stdout.write('packed external consumer imports every public Contexture entry point\n');
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
