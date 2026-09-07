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
    "import { z } from 'zod';",
    "import { Channels, Contexture, ControllerManager, InMemoryTelemetry, LookupFailure, NodeNotFoundError, Principal, RootSelection, currentPrincipal, defineApplication, reportTelemetry } from '@contexture/mcp';",
    "import { trace } from '@contexture/mcp/inspection';",
    "import { newProject } from '@contexture/mcp/cli';",
    "import { Auth, claudeCodeConfig, compileRuntimeApplication, DISCLOSURE_GATEWAY, EXECUTION_GATEWAY, Gateway, GATEWAY, HeaderRootSelector, Launch, unresolvedMessage } from '@contexture/mcp/server';",
    "import { RestRouter } from '@contexture/mcp/web';",
    "if (typeof defineApplication !== 'function') throw new Error('missing declaration facade');",
    "if (typeof Contexture !== 'function') throw new Error('missing Contexture facade');",
    "if (typeof Channels !== 'function') throw new Error('missing nominal Channels facade');",
    "if (typeof ControllerManager !== 'function') throw new Error('missing manager facade');",
    "if (typeof LookupFailure !== 'object' || LookupFailure.NO_SUCH_MEMBER !== 'no_such_member') throw new Error('missing lookup classification');",
    "if (!(new NodeNotFoundError({ reason: LookupFailure.EMPTY_REF }) instanceof Error)) throw new Error('missing lookup error');",
    "if (typeof Principal !== 'function' || typeof currentPrincipal !== 'function') throw new Error('missing root request facts');",
    "if (typeof trace !== 'function') throw new Error('missing inspection API');",
    "if (typeof newProject !== 'function') throw new Error('missing CLI scaffold API');",
    "if (typeof compileRuntimeApplication !== 'function') throw new Error('missing server facade');",
    "if (typeof HeaderRootSelector !== 'function') throw new Error('missing root selection facade');",
    "if (typeof Auth !== 'function') throw new Error('missing identity facade');",
    "if (typeof Launch !== 'function' || typeof claudeCodeConfig !== 'function') throw new Error('missing host launch facade');",
    "if (typeof RestRouter !== 'function') throw new Error('missing web facade');",
    "if (DISCLOSURE_GATEWAY.length !== 2 || EXECUTION_GATEWAY.length !== 2) throw new Error('missing fixed gateway halves');",
    "if (typeof Gateway !== 'function' || GATEWAY.length !== 4 || typeof unresolvedMessage !== 'function') throw new Error('missing Gateway recovery facade');",
    "if (!RootSelection.only(['consumer']).containsRef('/consumer/tool')) throw new Error('missing root selection projection');",
    "const manager = new ControllerManager(); manager.registerSkill(() => ({ kind: 'skill', name: 'managed', description: 'Managed.', instructions: 'Read.' })); if (manager.compile('consumer-manager').find('managed').kind !== 'skill') throw new Error('missing manager registration');",
    "class ConsumerChannels extends Channels { open() {} close() {} } const lifecycle = new ConsumerChannels(); if (defineApplication({ name: 'consumer-channels', channels: lifecycle, roots: [() => ({ kind: 'skill', name: 'live', description: 'Live.', instructions: 'Read.' })] }).channels !== lifecycle) throw new Error('missing nominal Channels declaration'); const rawHandle = { raw: true, open() { throw new Error('raw handle must not open'); }, close() { throw new Error('raw handle must not close'); } }; const rawManager = new ControllerManager({ channels: rawHandle }); rawManager.registerSkill(() => ({ kind: 'skill', name: 'raw', description: 'Raw.', instructions: 'Read.' })); const rawManagerApplication = rawManager.application('consumer-raw'); if (rawManager.compile('consumer-raw-index').channels !== rawHandle || compileRuntimeApplication(rawManagerApplication).index.channels !== rawHandle) throw new Error('missing raw manager handle');",
    "const telemetry = new InMemoryTelemetry(); reportTelemetry(telemetry, 'consumer/check'); if (telemetry.usage('consumer/check').callCount !== 1) throw new Error('missing telemetry aggregate');",
    "const rawApplication = { name: ' packed declaration ', roots: [() => ({ kind: 'skill', name: 'approval', description: 'Require approval.', instructions: 'Wait for a person.' })], prompts: [{ opens: 'approval', description: 'Open approval.', modelMayOpen: false }] };",
    'const rawRuntime = compileRuntimeApplication(rawApplication);',
    "if (rawRuntime.index.name !== 'packed declaration') throw new Error('server compilation did not normalize a raw declaration');",
    "if (!rawRuntime.index.has('approval') || rawRuntime.index.isBound !== true || [...rawRuntime.index.nodesWithRefs()][0]?.[0] !== 'approval' || rawRuntime.index.matchingRefs('approval', 1).total !== 1) throw new Error('missing public Index facade');",
    "const skillCycle = defineApplication({ name: 'consumer-skill-cycle', roots: [() => ({ kind: 'role', name: 'workflow', description: 'Workflow.', instructions: 'Route.', skills: [() => ({ kind: 'skill', name: 'first', description: 'First.', instructions: 'First instructions.', uses: ['workflow/second'] }), () => ({ kind: 'skill', name: 'second', description: 'Second.', instructions: 'Second instructions.', uses: ['workflow/first'] })] })] }); const activeSkill = compileRuntimeApplication(skillCycle).disclosure.open('workflow/first'); const referencedSkill = activeSkill.uses?.[0]; if (activeSkill.instructions !== 'First instructions.' || referencedSkill?.ref !== 'workflow/second' || 'instructions' in referencedSkill || 'uses' in referencedSkill) throw new Error('missing Skill routing-card disclosure');",
    "const toolUses = defineApplication({ name: 'consumer-tool-uses', roots: [() => ({ kind: 'role', name: 'operations', description: 'Operations.', instructions: 'Route.', tools: [() => ({ kind: 'tool', name: 'first', description: 'First.', readOnly: true, input: z.strictObject({}), invoke: () => 'first', uses: ['operations/second'] }), () => ({ kind: 'tool', name: 'second', description: 'Second.', readOnly: true, input: z.strictObject({}), invoke: () => 'second', uses: ['operations/first'] })] })] }); const activeTool = compileRuntimeApplication(toolUses).disclosure.open('operations/first'); const referencedTool = activeTool.uses?.[0]; if (referencedTool?.ref !== 'operations/second' || 'uses' in referencedTool) throw new Error('missing bounded Tool uses disclosure');",
    "let reserved = false; try { rawRuntime.disclosure.open('approval'); } catch (error) { reserved = error instanceof Error && /opened by a person/.test(error.message); } if (!reserved) throw new Error('server compilation did not preserve a raw Prompt reservation');",
    "for (const invalid of [{ ...rawApplication, prompts: [{ opens: 'approval', description: 'Open approval.', modelMayOpen: 'false' }] }, { ...rawApplication, prompts: [{ name: ' ', opens: 'approval', description: 'Open approval.' }] }, { ...rawApplication, resources: [{ opens: 'approval', uri: 'contexture://approval', description: 'Read approval.', mimeType: 1 }] }]) { let rejected = false; try { compileRuntimeApplication(invalid); } catch (error) { rejected = error instanceof TypeError; } if (!rejected) throw new Error('server compilation accepted an invalid raw declaration'); }",
  ].join('\n');
  await writeFile(path.join(temporaryRoot, 'consumer.mjs'), consumer, 'utf8');
  run(process.execPath, ['consumer.mjs'], temporaryRoot);
  const typeConsumer = [
    "import { Contexture, LookupFailure, type Prompt, type Resource } from '@contexture/mcp';",
    "const prompt: Prompt = { opens: 'approval', description: 'Open approval.', modelMayOpen: false };",
    "const resource: Resource = { opens: 'runbook', uri: 'contexture://runbook', description: 'Read runbook.' };",
    'const reason: LookupFailure = LookupFailure.NO_SUCH_MEMBER;',
    "Contexture({ name: 'typed-consumer', roots: [() => ({}) as never], prompts: [prompt], resources: [resource] });",
    'void reason;',
  ].join('\n');
  await writeFile(path.join(temporaryRoot, 'consumer.ts'), typeConsumer, 'utf8');
  run(
    path.join(repositoryRoot, 'node_modules', '.bin', 'tsc'),
    [
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict',
      '--noEmit',
      'consumer.ts',
    ],
    temporaryRoot,
  );
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
