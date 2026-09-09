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
    shell: process.platform === 'win32' && command !== process.execPath,
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
    "import { inspect } from 'node:util';",
    "import { Channels, CompileLevel, Contexture, ContextureError, ControllerManager, DeclarationError, DISCOVER_GATEWAY_NAME, DuplicateNameError, GATEWAY_TOOL_NAMES, InMemoryTelemetry, INVOKE_GATEWAY_NAME, INVOKE_READ_ONLY_GATEWAY_NAME, LookupFailure, ModelValidationError, NodeNotFoundError, OPEN_GATEWAY_NAME, OutsideSelectionError, PACKAGE_NAME, PACKAGE_VERSION, Principal, REFERENCE_SEPARATOR, RootOutsideSelectionError, RootSelection, SelectedGraph, SurfaceSelection, WrongDoorError, branchesOf, compileNode, currentGraph, currentPrincipal, currentTelemetry, defineApplication, defineTool, groupCards, membersOf, reportTelemetry, withGraph, withTelemetry } from '@contexture/mcp';",
    "import { trace } from '@contexture/mcp/inspection';",
    "import { newProject } from '@contexture/mcp/cli';",
    "import { ApplicationRuntime, Auth, buildServer, claudeCodeConfig, compileRuntimeApplication, compileStructuralApplication, ContextureOptions, currentTelemetry as serverCurrentTelemetry, DisclosureAPI, DISCLOSURE_GATEWAY, EXECUTION_GATEWAY, ExecutionAPI, Gateway, GATEWAY, GATEWAY_TOOLS, HeaderRootSelector, HeaderSurfaceSelector, InMemoryTelemetry as ServerInMemoryTelemetry, Launch, Refused, reportTelemetry as serverReportTelemetry, ROOTS_HEADER, SELECT_HEADER, ServeError, SystemAPI, unresolvedMessage, withTelemetry as serverWithTelemetry } from '@contexture/mcp/server';",
    "import { RestRouter } from '@contexture/mcp/web';",
    "if (typeof defineApplication !== 'function') throw new Error('missing declaration facade');",
    "let defaultWriteCalls = 0; const defaultWrite = defineTool({ kind: 'tool', name: 'default-write', description: 'Write by default.', input: z.strictObject({ value: z.string() }), invoke: ({ value }) => { defaultWriteCalls += 1; return value; }, uses: ['target'] }); if (defaultWrite.readOnly !== false || defaultWrite.uses?.[0] !== 'target' || !Object.isFrozen(defaultWrite.uses)) throw new Error('missing native Tool default or snapshot'); const defaultToolRuntime = compileRuntimeApplication(defineApplication({ name: 'consumer-default-tool', roots: [() => defaultWrite, () => defineTool({ kind: 'tool', name: 'target', description: 'Target.', readOnly: true, input: z.strictObject({}), invoke: () => 'target' })] })); if (await defaultToolRuntime.runtime.invoke('default-write', { value: 'written' }) !== 'written') throw new Error('missing native Tool writing execution'); let invalidDefaultWrite = false; try { await defaultToolRuntime.runtime.invoke('default-write', { value: 42 }); } catch { invalidDefaultWrite = true; } if (!invalidDefaultWrite || defaultWriteCalls !== 1) throw new Error('packed Binding accepted invalid input or called the handler');",
    "const localLookup = new NodeNotFoundError({ reason: LookupFailure.NO_SUCH_MEMBER, segment: 'missing', known: ['known'] }); const attachedLookup = localLookup.within('consumer/missing'); if (!(attachedLookup instanceof ContextureError) || attachedLookup.ref !== 'consumer/missing' || !attachedLookup.message.startsWith('no_such_member:') || localLookup.ref !== undefined || attachedLookup.within('other') !== attachedLookup) throw new Error('missing immutable NodeNotFound developer facts'); const wrongDoor = new WrongDoorError('consumer/write', false); if (!(wrongDoor instanceof ContextureError) || wrongDoor.message !== '\"consumer/write\" is a writing Tool' || !(new DeclarationError('invalid') instanceof ContextureError)) throw new Error('missing Contexture error categories');",
    "if (PACKAGE_NAME !== 'contexture' || PACKAGE_VERSION !== '0.12.0rc1' || REFERENCE_SEPARATOR !== '/' || GATEWAY_TOOL_NAMES.join(',') !== [DISCOVER_GATEWAY_NAME, OPEN_GATEWAY_NAME, INVOKE_READ_ONLY_GATEWAY_NAME, INVOKE_GATEWAY_NAME].join(',')) throw new Error('missing shared foundation vocabulary');",
    "if (typeof Contexture !== 'function') throw new Error('missing Contexture facade');",
    "if (typeof Channels !== 'function') throw new Error('missing nominal Channels facade');",
    "if (typeof ControllerManager !== 'function') throw new Error('missing manager facade');",
    "if (typeof DuplicateNameError !== 'function' || typeof ModelValidationError !== 'function' || typeof ApplicationRuntime !== 'function') throw new Error('missing public parity facade concepts');",
    "const serverTelemetry = new ServerInMemoryTelemetry(); serverReportTelemetry(serverTelemetry, 'server/export'); await serverWithTelemetry(serverTelemetry, async () => { if (serverCurrentTelemetry() !== serverTelemetry) throw new Error('missing server telemetry facade'); });",
    "if (typeof LookupFailure !== 'object' || LookupFailure.NO_SUCH_MEMBER !== 'no_such_member') throw new Error('missing lookup classification');",
    "if (!(new NodeNotFoundError({ reason: LookupFailure.EMPTY_REF }) instanceof Error)) throw new Error('missing lookup error');",
    "if (typeof Principal !== 'function' || typeof currentPrincipal !== 'function' || currentPrincipal() !== undefined) throw new Error('missing optional root principal fact');",
    "const redactedPrincipal = new Principal({ subject: 'consumer', clientId: 'packed-client', issuer: 'https://issuer.example', scopes: ['zeta', 'alpha'], claims: { bearer: 'never-print', tenant: 'consumer' } }); const redactedJson = JSON.stringify(redactedPrincipal); const redactedInspect = inspect(redactedPrincipal); if (/bearer|never-print|claims/.test(redactedJson) || /bearer|never-print|claims/.test(redactedInspect) || !/alpha/.test(redactedJson) || !/zeta/.test(redactedInspect)) throw new Error('Principal representations leaked claims or lost identity facts');",
    "if (typeof trace !== 'function') throw new Error('missing inspection API');",
    "if (typeof newProject !== 'function') throw new Error('missing CLI scaffold API');",
    "if (typeof compileRuntimeApplication !== 'function') throw new Error('missing server facade');",
    "const structuralConsumer = compileStructuralApplication(defineApplication({ name: 'structural-consumer', roots: [() => ({ kind: 'skill', name: 'architecture', description: 'Architecture.', instructions: 'Inspect.' })] })); if (structuralConsumer.index.isBound || structuralConsumer.server().gatewayNames.join(',') !== 'contexture_discover,contexture_open') throw new Error('missing disclosure-only server container');",
    "if (typeof HeaderRootSelector !== 'function') throw new Error('missing root selection facade');",
    "if (typeof Auth !== 'function') throw new Error('missing identity facade');",
    "const packedAuth = new Auth({ verify: async () => undefined }, { issuer: 'https://issuer.example', resource: 'https://mcp.example/mcp' }); const packedHosts = ['mcp.example:*']; const packedOptions = new ContextureOptions({ transport: 'streamable-http', host: '0.0.0.0', auth: packedAuth, allowedHosts: packedHosts, path: '/contexture', maxRequestBodyBytes: 4096 }); packedHosts.push('changed.example'); if (packedOptions.auth !== packedAuth || packedOptions.maxRequestBodyBytes !== 4096 || packedOptions.resolvedPath !== '/contexture' || packedOptions.allowedHosts.join(',') !== 'mcp.example:*' || !Object.isFrozen(packedOptions.allowedHosts)) throw new Error('missing ContextureOptions HTTP policy facade'); for (const invalid of [{ path: '/mcp?query' }, { path: '/mcp#fragment' }, { path: '/mcp space' }, { path: '/%zz' }, { path: '//' }, { maxRequestBodyBytes: 0 }]) { let rejected = false; try { new ContextureOptions({ transport: 'streamable-http', ...invalid }); } catch (error) { rejected = error instanceof ServeError; } if (!rejected) throw new Error('ContextureOptions accepted invalid body/path policy'); } let stdioRejected = false; try { new ContextureOptions({ auth: packedAuth }); } catch (error) { stdioRejected = error instanceof ServeError && /auth/.test(error.message); } if (!stdioRejected) throw new Error('ContextureOptions discarded stdio auth');",
    "if (typeof Launch !== 'function' || typeof claudeCodeConfig !== 'function') throw new Error('missing host launch facade');",
    "if (typeof RestRouter !== 'function') throw new Error('missing web facade');",
    "if (DISCLOSURE_GATEWAY.length !== 2 || EXECUTION_GATEWAY.length !== 2) throw new Error('missing fixed gateway halves');",
    "if (typeof Gateway !== 'function' || GATEWAY.length !== 4 || typeof unresolvedMessage !== 'function') throw new Error('missing Gateway recovery facade');",
    "if (SystemAPI !== Gateway || GATEWAY_TOOLS.join(',') !== GATEWAY.map((tool) => tool.name).join(',') || typeof Refused !== 'function') throw new Error('missing SystemAPI compatibility surface');",
    "if (!RootSelection.only(['consumer']).containsRef('consumer/tool') || RootSelection.only(['consumer']).containsRef('/consumer/tool')) throw new Error('missing canonical root selection projection');",
    "if (RootSelection !== SurfaceSelection || RootOutsideSelectionError !== OutsideSelectionError) throw new Error('selection compatibility names are not aliases'); const surfaceDeclaration = defineApplication({ name: 'surface-consumer', roots: [() => ({ kind: 'role', name: 'team', description: 'Team.', instructions: 'Route.', children: [() => ({ kind: 'role', name: 'editor', description: 'Editor.', instructions: 'Edit.' })] })] }); const surfaceApplication = compileRuntimeApplication(surfaceDeclaration); const promoted = new SelectedGraph(surfaceApplication.index, SurfaceSelection.only('team/*')); if (promoted.roots.map((node) => promoted.refOf(node)).join(',') !== 'team/editor' || promoted.parentOf(promoted.find('team/editor')) !== undefined) throw new Error('missing promoted path-selected surface'); const promotedDisclosure = surfaceApplication.disclosure.select(SurfaceSelection.only('team/editor')); if (promotedDisclosure.discover().roles[0]?.ref !== 'team/editor' || promotedDisclosure.open('team/editor').ref !== 'team/editor') throw new Error('missing promoted disclosure surface'); const surfaceSelector = new HeaderSurfaceSelector(); if (buildServer(surfaceDeclaration, { surfaceSelector }).surfaceSelector !== surfaceSelector) throw new Error('missing canonical server surface selector option'); const selectedHeader = surfaceSelector.select(surfaceApplication.index, { [SELECT_HEADER]: 'team/editor' }); if (selectedHeader.names?.join(',') !== 'team/editor' || new HeaderRootSelector().select(surfaceApplication.index, { [ROOTS_HEADER]: 'team' }).names?.join(',') !== 'team') throw new Error('missing current and legacy selection headers');",
    "const manager = new ControllerManager(); manager.registerSkill(() => ({ kind: 'skill', name: 'managed', description: 'Managed.', instructions: 'Read.' })); if (manager.compile('consumer-manager').find('managed').kind !== 'skill') throw new Error('missing manager registration');",
    "class ConsumerChannels extends Channels { open() {} close() {} } const lifecycle = new ConsumerChannels(); if (defineApplication({ name: 'consumer-channels', channels: lifecycle, roots: [() => ({ kind: 'skill', name: 'live', description: 'Live.', instructions: 'Read.' })] }).channels !== lifecycle) throw new Error('missing nominal Channels declaration'); const rawHandle = { raw: true, open() { throw new Error('raw handle must not open'); }, close() { throw new Error('raw handle must not close'); } }; const rawManager = new ControllerManager({ channels: rawHandle }); rawManager.registerSkill(() => ({ kind: 'skill', name: 'raw', description: 'Raw.', instructions: 'Read.' })); const rawManagerApplication = rawManager.application('consumer-raw'); if (rawManager.compile('consumer-raw-index').channels !== rawHandle || compileRuntimeApplication(rawManagerApplication).index.channels !== rawHandle) throw new Error('missing raw manager handle');",
    "const telemetry = new InMemoryTelemetry(); reportTelemetry(telemetry, 'consumer/check'); if (telemetry.usage('consumer/check').callCount !== 1) throw new Error('missing telemetry aggregate');",
    "await withTelemetry(telemetry, async () => { await Promise.resolve(); if (currentTelemetry() !== telemetry) throw new Error('missing telemetry scope'); }); let missingTelemetryScope = false; try { currentTelemetry(); } catch { missingTelemetryScope = true; } if (!missingTelemetryScope) throw new Error('telemetry scope leaked');",
    "const rawApplication = { name: ' packed declaration ', roots: [() => ({ kind: 'skill', name: 'approval', description: 'Require approval.', instructions: 'Wait for a person.' }), () => ({ kind: 'role', name: 'hidden', description: 'Hidden.', instructions: 'Stay hidden.' })], prompts: [{ opens: 'approval', description: 'Open approval.', modelMayOpen: false }] };",
    'const rawRuntime = compileRuntimeApplication(rawApplication);',
    "if (typeof DisclosureAPI !== 'function') throw new Error('missing DisclosureAPI facade');",
    "const packedNavigation = new DisclosureAPI(rawRuntime.disclosure.select(RootSelection.only('approval')));",
    "if (packedNavigation.tools.length !== 2 || packedNavigation.index !== rawRuntime.index || (await packedNavigation.discover()).skills.length !== 1) throw new Error('missing packed DisclosureAPI navigation surface');",
    "if ([...packedNavigation.selectedGraph().walk()].map(([ref]) => ref).join(',') !== 'approval') throw new Error('packed DisclosureAPI did not retain selected graph attenuation');",
    "let packedOutside = false; try { await packedNavigation.openForAPerson('hidden'); } catch (error) { packedOutside = error instanceof RootOutsideSelectionError && !/person/.test(error.message); } if (!packedOutside) throw new Error('packed DisclosureAPI person alias widened the root ceiling');",
    "let packedRecovery = false; try { await packedNavigation.openForAPerson('approval/missing'); } catch (error) { packedRecovery = error instanceof Error && error.cause instanceof NodeNotFoundError && error.message.includes(OPEN_GATEWAY_NAME); } if (!packedRecovery) throw new Error('packed DisclosureAPI did not recover a selected lookup failure');",
    "let packedReserved = false; try { await packedNavigation.open('approval'); } catch (error) { packedReserved = error instanceof Error && /opened by a person/.test(error.message); } if (!packedReserved || (await packedNavigation.openForAPerson('approval')).instructions !== 'Wait for a person.') throw new Error('packed DisclosureAPI did not separate model and person doors');",
    "let packedPromptCalls = 0; const packedExecutionRuntime = compileRuntimeApplication(defineApplication({ name: 'packed-execution', roots: [() => ({ kind: 'role', name: 'operations', description: 'Operate.', instructions: 'Inspect.', tools: [() => ({ kind: 'tool', name: 'status', description: 'Status.', readOnly: true, input: z.strictObject({}), invoke: () => 'healthy' })] })], promptRoots: [() => ({ kind: 'tool', name: 'prompt', description: 'Person command.', readOnly: true, input: z.strictObject({}), invoke: () => { packedPromptCalls += 1; return 'approved'; } })] })); const packedExecution = new ExecutionAPI(packedExecutionRuntime.runtime); if (!(packedExecutionRuntime.execution instanceof ExecutionAPI) || packedExecution.tools !== EXECUTION_GATEWAY || packedExecution.index !== packedExecutionRuntime.index || await packedExecution.invokeReadOnly('operations/status') !== 'healthy') throw new Error('missing packed ExecutionAPI invocation surface'); let packedPromptRefused = false; try { await packedExecution.invokeReadOnly('/prompt'); } catch (error) { packedPromptRefused = error instanceof Error && /opened by a person/.test(error.message); } if (!packedPromptRefused || packedPromptCalls !== 0 || await packedExecution.readForAHost('prompt') !== 'approved') throw new Error('packed ExecutionAPI did not separate model and host doors'); let packedExecutionOutside = false; try { await packedExecution.invokeReadOnly('prompt', {}, {}, RootSelection.only('operations')); } catch (error) { packedExecutionOutside = error instanceof RootOutsideSelectionError && !/person/.test(error.message); } if (!packedExecutionOutside) throw new Error('packed ExecutionAPI widened the root ceiling'); let packedExecutionRecovery = false; try { await packedExecution.readForHost('operations/missing'); } catch (error) { packedExecutionRecovery = error instanceof Error && error.cause instanceof NodeNotFoundError && error.message.includes(OPEN_GATEWAY_NAME); } if (!packedExecutionRecovery) throw new Error('packed ExecutionAPI did not recover a host lookup failure');",
    "const packedAllGraph = new SelectedGraph(packedExecutionRuntime.index); const packedOperationsGraph = new SelectedGraph(packedExecutionRuntime.index, RootSelection.only('operations')); let packedGraphRestored = false; await withGraph(packedAllGraph, async () => { await withGraph(packedOperationsGraph, async () => { await Promise.resolve(); if (currentGraph() !== packedOperationsGraph) throw new Error('packed withGraph lost its nested scope'); }); packedGraphRestored = currentGraph() === packedAllGraph; }); let packedGraphUnbound = false; try { currentGraph(); } catch (error) { packedGraphUnbound = error instanceof Error && /No compiled Contexture graph/.test(error.message); } if (!packedGraphRestored || !packedGraphUnbound) throw new Error('missing packed graph context lifecycle');",
    "if (rawRuntime.index.name !== 'packed declaration') throw new Error('server compilation did not normalize a raw declaration');",
    "if (!rawRuntime.index.has('approval') || rawRuntime.index.isBound !== true || [...rawRuntime.index.nodesWithRefs()][0]?.[0] !== 'approval' || rawRuntime.index.matchingRefs('approval', 1).total !== 1 || rawRuntime.index.find(['approval'].join(REFERENCE_SEPARATOR)).name !== 'approval') throw new Error('missing public Index facade');",
    "const skillCycle = defineApplication({ name: 'consumer-skill-cycle', roots: [() => ({ kind: 'role', name: 'workflow', description: 'Workflow.', instructions: 'Route.', skills: [() => ({ kind: 'skill', name: 'first', description: 'First.', instructions: 'First instructions.', uses: ['workflow/second'] }), () => ({ kind: 'skill', name: 'second', description: 'Second.', instructions: 'Second instructions.', uses: ['workflow/first'] })] })] }); const skillRuntime = compileRuntimeApplication(skillCycle); const activeSkill = skillRuntime.disclosure.open('workflow/first'); const referencedSkill = activeSkill.uses?.[0]; const compiledWorkflow = skillRuntime.index.find('workflow'); if (compiledWorkflow.kind !== 'role' || compiledWorkflow.branches().length !== 0 || compiledWorkflow.members().map((node) => node.name).join(',') !== 'first,second' || compiledWorkflow.member('first').kind !== 'skill') throw new Error('missing public compiled Role membership facade'); if (activeSkill.instructions !== 'First instructions.' || referencedSkill?.ref !== 'workflow/second' || 'instructions' in referencedSkill || 'uses' in referencedSkill) throw new Error('missing Skill routing-card disclosure');",
    "const packedNodeView = skillRuntime.disclosure; const packedNodeGroups = groupCards(membersOf(compiledWorkflow), packedNodeView); if (CompileLevel.ROUTE !== 'route' || branchesOf(compiledWorkflow).length !== 0 || packedNodeGroups.skills.length !== 2 || !Object.isFrozen(packedNodeGroups.skills) || compileNode(compiledWorkflow, CompileLevel.ACTIVE, packedNodeView).skills.length !== 2) throw new Error('missing packed Node lifecycle facade');",
    "const toolUses = defineApplication({ name: 'consumer-tool-uses', roots: [() => ({ kind: 'role', name: 'operations', description: 'Operations.', instructions: 'Route.', tools: [() => ({ kind: 'tool', name: 'first', description: 'First.', readOnly: true, input: z.strictObject({}), invoke: () => 'first', uses: ['operations/second'] }), () => ({ kind: 'tool', name: 'second', description: 'Second.', readOnly: true, input: z.strictObject({}), invoke: () => 'second', uses: ['operations/first'] })] })] }); const activeTool = compileRuntimeApplication(toolUses).disclosure.open('operations/first'); const referencedTool = activeTool.uses?.[0]; if (referencedTool?.ref !== 'operations/second' || 'uses' in referencedTool) throw new Error('missing bounded Tool uses disclosure');",
    "let reserved = false; try { rawRuntime.disclosure.open('approval'); } catch (error) { reserved = error instanceof Error && /opened by a person/.test(error.message); } if (!reserved) throw new Error('server compilation did not preserve a raw Prompt reservation');",
    "for (const invalid of [{ ...rawApplication, prompts: [{ opens: 'approval', description: 'Open approval.', modelMayOpen: 'false' }] }, { ...rawApplication, prompts: [{ name: ' ', opens: 'approval', description: 'Open approval.' }] }, { ...rawApplication, resources: [{ opens: 'approval', uri: 'contexture://approval', description: 'Read approval.', mimeType: 1 }] }]) { let rejected = false; try { compileRuntimeApplication(invalid); } catch (error) { rejected = error instanceof TypeError; } if (!rejected) throw new Error('server compilation accepted an invalid raw declaration'); }",
  ].join('\n');
  await writeFile(path.join(temporaryRoot, 'consumer.mjs'), consumer, 'utf8');
  run(process.execPath, ['consumer.mjs'], temporaryRoot);
  const typeConsumer = [
    "import { Contexture, LookupFailure, type ContextNode, type Prompt, type Resource, type View } from '@contexture/mcp';",
    "const prompt: Prompt = { opens: 'approval', description: 'Open approval.', modelMayOpen: false };",
    "const resource: Resource = { opens: 'runbook', uri: 'contexture://runbook', description: 'Read runbook.' };",
    'const reason: LookupFailure = LookupFailure.NO_SUCH_MEMBER;',
    'declare const node: ContextNode; declare const view: View; void node; void view;',
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
