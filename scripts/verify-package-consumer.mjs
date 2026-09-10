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
    "import { Channels as CoreChannels, ControllerManager as CoreControllerManager, Principal as CorePrincipal, RootSelection as CoreRootSelection, bindTool as coreBindTool, currentGraph as coreCurrentGraph, definePublication as coreDefinePublication } from '@contexture/mcp/core';",
    "import { inspect } from 'node:util';",
    "import { Channels, CompileLevel, Contexture, ContextureError, ControllerManager, DeclarationError, DISCOVER_GATEWAY_NAME, DuplicateNameError, GATEWAY_TOOL_NAMES, INSPECT_GATEWAY_NAME, InMemoryTelemetry, INVOKE_GATEWAY_NAME, INVOKE_READ_ONLY_GATEWAY_NAME, LookupFailure, ModelValidationError, NodeNotFoundError, OPEN_GATEWAY_NAME, OutsideSelectionError, PACKAGE_NAME, PACKAGE_VERSION, Principal, REFERENCE_SEPARATOR, RootOutsideSelectionError, RootSelection, SelectedGraph, SurfaceSelection, WrongDoorError, branchesOf, compileNode, currentGraph, currentPrincipal, currentTelemetry, defineApplication, definePublication, defineTool, groupCards, membersOf, reportTelemetry, withGraph, withTelemetry } from '@contexture/mcp';",
    "import { asJson as inspectionJson, trace } from '@contexture/mcp/inspection';",
    "import { deploymentOps, getPodEvents, getPodLogs, getPodStatus, getRolloutStatus, incidentResponse, kubernetesPlatform, rollBackDeployment } from '@contexture/mcp/demo';",
    "import { app as demoApp, build as buildDemo, crashLoopRunbookDocument, main as demoMain, rollBackARelease, rollbackPolicyDocument } from '@contexture/mcp/demo/server';",
    "import { availableTemplates, CLI_VERSION, findProject, loadApplication, main as cliMain, newProject, UsageError } from '@contexture/mcp/cli';",
    "import { ApplicationRuntime, Auth, buildInstructions, buildServer, claudeCodeConfig, cliCommands, codexConfig, COMMAND_CLOSING, commandDescription, compileRuntimeApplication, compileStructuralApplication, ContextureOptions, currentTelemetry as serverCurrentTelemetry, cursorConfig, DisclosureAPI, DISCLOSURE_GATEWAY, EXECUTION_GATEWAY, ExecutionAPI, FixedRootSelector, Gateway, GATEWAY, GATEWAY_TOOLS, GOTO_DESCRIPTION, HeaderRootSelector, HeaderSurfaceSelector, InMemoryTelemetry as ServerInMemoryTelemetry, INSTRUCTIONS_LIMIT, Launch, neutralInstructions, PREAMBLE, Refused, REF_RULE, reportTelemetry as serverReportTelemetry, ROOTS_HEADER, ROSTER_BUDGET, SELECT_HEADER, SELF_CONTAINED_PREFIX, ServeError, signpost, SystemAPI, truncatedCompletion, unresolvedMessage, withTelemetry as serverWithTelemetry } from '@contexture/mcp/server';",
    "import { Publications as SurfacePublications, publishedName } from '@contexture/mcp/server/surface';",
    "import { RestRouter, RestSurface } from '@contexture/mcp/web';",
    "if (typeof defineApplication !== 'function') throw new Error('missing declaration facade');",
    "let defaultWriteCalls = 0; const defaultWrite = defineTool({ kind: 'tool', name: 'default-write', description: 'Write by default.', input: z.strictObject({ value: z.string() }), invoke: ({ value }) => { defaultWriteCalls += 1; return value; }, uses: ['target'] }); if (defaultWrite.readOnly !== false || defaultWrite.uses?.[0] !== 'target' || !Object.isFrozen(defaultWrite.uses)) throw new Error('missing native Tool default or snapshot'); const defaultToolRuntime = compileRuntimeApplication(defineApplication({ name: 'consumer-default-tool', roots: [() => defaultWrite, () => defineTool({ kind: 'tool', name: 'target', description: 'Target.', readOnly: true, input: z.strictObject({}), invoke: () => 'target' })] })); if (await defaultToolRuntime.runtime.invoke('default-write', { value: 'written' }) !== 'written') throw new Error('missing native Tool writing execution'); let invalidDefaultWrite = false; try { await defaultToolRuntime.runtime.invoke('default-write', { value: 42 }); } catch { invalidDefaultWrite = true; } if (!invalidDefaultWrite || defaultWriteCalls !== 1) throw new Error('packed Binding accepted invalid input or called the handler');",
    "const localLookup = new NodeNotFoundError({ reason: LookupFailure.NO_SUCH_MEMBER, segment: 'missing', known: ['known'] }); const attachedLookup = localLookup.within('consumer/missing'); if (!(attachedLookup instanceof ContextureError) || attachedLookup.ref !== 'consumer/missing' || !attachedLookup.message.startsWith('no_such_member:') || localLookup.ref !== undefined || attachedLookup.within('other') !== attachedLookup) throw new Error('missing immutable NodeNotFound developer facts'); const wrongDoor = new WrongDoorError('consumer/write', false); if (!(wrongDoor instanceof ContextureError) || wrongDoor.message !== '\"consumer/write\" is a writing Tool' || !(new DeclarationError('invalid') instanceof ContextureError)) throw new Error('missing Contexture error categories');",
    "if (PACKAGE_NAME !== 'contexture' || PACKAGE_VERSION !== '0.15.0rc1' || REFERENCE_SEPARATOR !== '/' || GATEWAY_TOOL_NAMES.join(',') !== [DISCOVER_GATEWAY_NAME, INSPECT_GATEWAY_NAME, OPEN_GATEWAY_NAME, INVOKE_READ_ONLY_GATEWAY_NAME, INVOKE_GATEWAY_NAME].join(',')) throw new Error('missing shared foundation vocabulary');",
    "if (typeof Contexture !== 'function') throw new Error('missing Contexture facade');",
    "if (CoreChannels !== Channels || CoreControllerManager !== ControllerManager || CorePrincipal !== Principal || CoreRootSelection !== RootSelection || typeof coreBindTool !== 'function' || coreCurrentGraph !== currentGraph || coreDefinePublication !== definePublication) throw new Error('missing SDK-neutral core facade');",
    "const packedPublication = compileRuntimeApplication(defineApplication({ name: 'packed-publication', roots: [() => ({ kind: 'role', name: 'owner', description: 'Owner.', instructions: 'Work.', publication: () => definePublication({ kind: 'role', name: 'publish', description: 'Preserve.', instructions: 'Save evidence.' }) })] })).disclosure.open('owner'); if (packedPublication.publication !== 'owner/publish' || !packedPublication.instructions.includes('Publication (framework contract)')) throw new Error('missing packed Role Publication');",
    "if (typeof Channels !== 'function') throw new Error('missing nominal Channels facade');",
    "if (typeof ControllerManager !== 'function') throw new Error('missing manager facade');",
    "if (typeof DuplicateNameError !== 'function' || typeof ModelValidationError !== 'function' || typeof ApplicationRuntime !== 'function') throw new Error('missing public parity facade concepts');",
    "const serverTelemetry = new ServerInMemoryTelemetry(); serverReportTelemetry(serverTelemetry, 'server/export'); await serverWithTelemetry(serverTelemetry, async () => { if (serverCurrentTelemetry() !== serverTelemetry) throw new Error('missing server telemetry facade'); });",
    "if (typeof LookupFailure !== 'object' || LookupFailure.NO_SUCH_MEMBER !== 'no_such_member') throw new Error('missing lookup classification');",
    "if (!(new NodeNotFoundError({ reason: LookupFailure.EMPTY_REF }) instanceof Error)) throw new Error('missing lookup error');",
    "if (typeof Principal !== 'function' || typeof currentPrincipal !== 'function' || currentPrincipal() !== undefined) throw new Error('missing optional root principal fact');",
    "const redactedPrincipal = new Principal({ subject: 'consumer', clientId: 'packed-client', issuer: 'https://issuer.example', scopes: ['zeta', 'alpha'], claims: { bearer: 'never-print', tenant: 'consumer' } }); const redactedJson = JSON.stringify(redactedPrincipal); const redactedInspect = inspect(redactedPrincipal); if (/bearer|never-print|claims/.test(redactedJson) || /bearer|never-print|claims/.test(redactedInspect) || !/alpha/.test(redactedJson) || !/zeta/.test(redactedInspect)) throw new Error('Principal representations leaked claims or lost identity facts');",
    "if (typeof trace !== 'function') throw new Error('missing inspection API');",
    "if (kubernetesPlatform().name !== 'kubernetes-platform' || incidentResponse().name !== 'incident-response' || deploymentOps().name !== 'deployment-ops' || demoApp.name !== 'contexture-demo' || rollBackARelease.name !== 'roll-back-a-release' || crashLoopRunbookDocument.mimeType !== 'text/markdown' || rollbackPolicyDocument.uri !== 'contexture://runbooks/rollback-policy' || buildDemo().name !== 'contexture-demo' || typeof demoMain !== 'function') throw new Error('missing packed demo facade');",
    "if ((await getPodStatus().invoke({ namespace: 'prod', pod: 'payments-api-7d9c' })).restart_count !== 14 || !(await getPodLogs().invoke({ namespace: 'prod', pod: 'payments-api-7d9c', previous: false })).includes('DB_URL is missing') || (await getPodEvents().invoke({ namespace: 'prod', pod: 'payments-api-7d9c' })).length !== 4 || (await getRolloutStatus().invoke({ namespace: 'prod', deployment: 'payments-api' })).previous_revision !== 8 || rollBackDeployment().readOnly !== false) throw new Error('missing packed demo Tool facade');",
    "if (typeof newProject !== 'function') throw new Error('missing CLI scaffold API');",
    "if (!(new UsageError('usage') instanceof ContextureError) || CLI_VERSION !== PACKAGE_VERSION || typeof cliMain !== 'function') throw new Error('missing public CLI facade');",
    "const packedProject = await newProject('Packed Discovery', { destination: process.cwd() }); const foundPackedProject = await findProject(packedProject); const loadedPackedProject = await loadApplication({ start: packedProject }); if (foundPackedProject?.root !== packedProject || loadedPackedProject.application.name !== 'packed-discovery') throw new Error('packed project discovery or loading failed');",
    "if (availableTemplates().join(',') !== 'project') throw new Error('missing scaffold template inventory');",
    "if (typeof compileRuntimeApplication !== 'function') throw new Error('missing server facade');",
    "if (typeof SurfacePublications !== 'function' || publishedName({ opens: 'team/editor', description: 'Edit.' }) !== 'editor') throw new Error('missing surface facade');",
    "const structuralConsumer = compileStructuralApplication(defineApplication({ name: 'structural-consumer', roots: [() => ({ kind: 'skill', name: 'architecture', description: 'Architecture.', instructions: 'Inspect.' })] })); if (structuralConsumer.index.isBound || structuralConsumer.server().gatewayNames.join(',') !== 'contexture_discover,contexture_inspect,contexture_open') throw new Error('missing disclosure-only server container');",
    "if (typeof HeaderRootSelector !== 'function') throw new Error('missing root selection facade');",
    "if (typeof Auth !== 'function') throw new Error('missing identity facade');",
    "const packedAuth = new Auth({ verify: async () => undefined }, { issuer: 'https://issuer.example', resource: 'https://mcp.example/mcp' }); const packedHosts = ['mcp.example:*']; const packedOptions = new ContextureOptions({ transport: 'streamable-http', host: '0.0.0.0', auth: packedAuth, allowedHosts: packedHosts, path: '/contexture', maxRequestBodyBytes: 4096 }); packedHosts.push('changed.example'); if (packedOptions.auth !== packedAuth || packedOptions.maxRequestBodyBytes !== 4096 || packedOptions.resolvedPath !== '/contexture' || packedOptions.allowedHosts.join(',') !== 'mcp.example:*' || !Object.isFrozen(packedOptions.allowedHosts)) throw new Error('missing ContextureOptions HTTP policy facade'); for (const invalid of [{ path: '/mcp?query' }, { path: '/mcp#fragment' }, { path: '/mcp space' }, { path: '/%zz' }, { path: '//' }, { maxRequestBodyBytes: 0 }]) { let rejected = false; try { new ContextureOptions({ transport: 'streamable-http', ...invalid }); } catch (error) { rejected = error instanceof ServeError; } if (!rejected) throw new Error('ContextureOptions accepted invalid body/path policy'); } let stdioRejected = false; try { new ContextureOptions({ auth: packedAuth }); } catch (error) { stdioRejected = error instanceof ServeError && /auth/.test(error.message); } if (!stdioRejected) throw new Error('ContextureOptions discarded stdio auth');",
    "if (typeof Launch !== 'function' || typeof claudeCodeConfig !== 'function') throw new Error('missing host launch facade'); const packedLaunch = new Launch({ name: 'consumer', command: 'node', args: ['server.js'] }); if (!cursorConfig(packedLaunch).includes('mcpServers') || !codexConfig(packedLaunch).includes('[mcp_servers.consumer]') || !cliCommands(packedLaunch)['claude-code'].includes('--scope project')) throw new Error('missing packed host launch renderers');",
    "if (typeof RestRouter !== 'function') throw new Error('missing web facade');",
    "const packedRest = new RestRouter(defaultToolRuntime.runtime, [{ method: 'POST', path: ' /write ', ref: ' default-write ' }]); if (packedRest.routes[0]?.path !== '/write' || packedRest.routes[0]?.ref !== 'default-write' || !Object.isFrozen(packedRest.routes[0])) throw new Error('missing public RestRoute normalization');",
    "const packedSurface = new RestSurface(defaultToolRuntime.runtime, [{ method: 'POST', path: '/write', ref: 'default-write', status: 202 }]); const packedResponse = await packedSurface.fetch(new Request('http://consumer.invalid/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'surface' }) })); if (packedResponse.status !== 202 || await packedResponse.json() !== 'surface') throw new Error('missing packed RestSurface fetch behavior');",
    "if (DISCLOSURE_GATEWAY.length !== 3 || EXECUTION_GATEWAY.length !== 2) throw new Error('missing fixed gateway halves');",
    "if (typeof Gateway !== 'function' || GATEWAY.length !== 5 || typeof unresolvedMessage !== 'function') throw new Error('missing Gateway recovery facade');",
    "if (SystemAPI !== Gateway || GATEWAY_TOOLS.join(',') !== GATEWAY.map((tool) => tool.name).join(',') || typeof Refused !== 'function') throw new Error('missing SystemAPI compatibility surface');",
    "if (!PREAMBLE.includes('contexture_open') || !REF_RULE.includes('never assemble') || !GOTO_DESCRIPTION.includes('completes') || !COMMAND_CLOSING.includes('contexture_invoke') || commandDescription('a/b', 'Read.') !== 'Read. (a/b)' || signpost([]) !== '' || truncatedCompletion(100, 103) !== '... 3 more match; keep typing to narrow.') throw new Error('missing public server message contract');",
    "if (INSTRUCTIONS_LIMIT !== 2048 || ROSTER_BUDGET !== 1200 || SELF_CONTAINED_PREFIX !== 512 || !neutralInstructions().includes('request-specific')) throw new Error('missing public instruction builder contract');",
    "if (!RootSelection.only(['consumer']).containsRef('consumer/tool') || RootSelection.only(['consumer']).containsRef('/consumer/tool')) throw new Error('missing canonical root selection projection');",
    "if (RootSelection !== SurfaceSelection || RootOutsideSelectionError !== OutsideSelectionError) throw new Error('selection compatibility names are not aliases'); const surfaceDeclaration = defineApplication({ name: 'surface-consumer', roots: [() => ({ kind: 'role', name: 'team', description: 'Team.', instructions: 'Route.', children: [() => ({ kind: 'role', name: 'editor', description: 'Editor.', instructions: 'Edit.' })] })] }); const surfaceApplication = compileRuntimeApplication(surfaceDeclaration); const promoted = new SelectedGraph(surfaceApplication.index, SurfaceSelection.only('team/*')); if (promoted.roots.map((node) => promoted.refOf(node)).join(',') !== 'team/editor' || promoted.parentOf(promoted.find('team/editor')) !== undefined) throw new Error('missing promoted path-selected surface'); const promotedDisclosure = surfaceApplication.disclosure.select(SurfaceSelection.only('team/editor')); if (promotedDisclosure.discover().roles[0]?.ref !== 'team/editor' || promotedDisclosure.open('team/editor').ref !== 'team/editor') throw new Error('missing promoted disclosure surface'); const surfaceSelector = new HeaderSurfaceSelector(); const sealedServer = buildServer(surfaceDeclaration, { surfaceSelector }); if (sealedServer.surfaceSelector !== surfaceSelector || sealedServer.application.index !== surfaceApplication.index && sealedServer.application.index.name !== surfaceApplication.index.name || sealedServer.build() !== sealedServer.build() || 'registerTool' in sealedServer) throw new Error('missing sealed idempotent server container'); const selectedHeader = surfaceSelector.select(surfaceApplication.index, { [SELECT_HEADER]: 'team/editor' }); const fixedHeader = new FixedRootSelector(SurfaceSelection.only('team')).select(surfaceApplication.index); if (selectedHeader.names?.join(',') !== 'team/editor' || new HeaderRootSelector().select(surfaceApplication.index, { [ROOTS_HEADER]: 'team' }).names?.join(',') !== 'team' || fixedHeader.names?.join(',') !== 'team') throw new Error('missing current, legacy, or fixed selection facade');",
    "const manager = new ControllerManager(); manager.registerSkill(() => ({ kind: 'skill', name: 'managed', description: 'Managed.', instructions: 'Read.' })); if (manager.compile('consumer-manager').find('managed').kind !== 'skill') throw new Error('missing manager registration');",
    "class ConsumerChannels extends Channels { open() {} close() {} } const lifecycle = new ConsumerChannels(); if (defineApplication({ name: 'consumer-channels', channels: lifecycle, roots: [() => ({ kind: 'skill', name: 'live', description: 'Live.', instructions: 'Read.' })] }).channels !== lifecycle) throw new Error('missing nominal Channels declaration'); const rawHandle = { raw: true, open() { throw new Error('raw handle must not open'); }, close() { throw new Error('raw handle must not close'); } }; const rawManager = new ControllerManager({ channels: rawHandle }); rawManager.registerSkill(() => ({ kind: 'skill', name: 'raw', description: 'Raw.', instructions: 'Read.' })); const rawManagerApplication = rawManager.application('consumer-raw'); if (rawManager.compile('consumer-raw-index').channels !== rawHandle || compileRuntimeApplication(rawManagerApplication).index.channels !== rawHandle) throw new Error('missing raw manager handle');",
    "const telemetry = new InMemoryTelemetry(); reportTelemetry(telemetry, 'consumer/check'); if (telemetry.usage('consumer/check').callCount !== 1) throw new Error('missing telemetry aggregate');",
    "await withTelemetry(telemetry, async () => { await Promise.resolve(); if (currentTelemetry() !== telemetry) throw new Error('missing telemetry scope'); }); let missingTelemetryScope = false; try { currentTelemetry(); } catch { missingTelemetryScope = true; } if (!missingTelemetryScope) throw new Error('telemetry scope leaked');",
    "const rawApplication = { name: ' packed declaration ', roots: [() => ({ kind: 'skill', name: 'approval', description: 'Require approval.', instructions: 'Wait for a person.' }), () => ({ kind: 'role', name: 'hidden', description: 'Hidden.', instructions: 'Stay hidden.' })], prompts: [{ opens: 'approval', description: 'Open approval.', modelMayOpen: false }] };",
    'const rawRuntime = compileRuntimeApplication(rawApplication);',
    "const packedTrace = await trace(rawRuntime.disclosure, ['approval']); const packedTraceJson = JSON.parse(inspectionJson(packedTrace)); if (packedTrace.steps.length !== 3 || packedTraceJson.total.estimated_tokens !== packedTrace.total.tokens || packedTraceJson.steps[0].ref !== null) throw new Error('packed inspection replay is incomplete');",
    "if (!buildInstructions(rawRuntime.disclosure).includes('Capabilities:')) throw new Error('public instruction builder omitted its roster');",
    "if (typeof DisclosureAPI !== 'function') throw new Error('missing DisclosureAPI facade');",
    "const packedNavigation = new DisclosureAPI(rawRuntime.disclosure.select(RootSelection.only('approval')));",
    "if (packedNavigation.tools.length !== 3 || packedNavigation.index !== rawRuntime.index || (await packedNavigation.discover()).skills.length !== 1) throw new Error('missing packed DisclosureAPI navigation surface');",
    "const packedInspection = await new DisclosureAPI(rawRuntime.disclosure.select(RootSelection.only('hidden'))).inspect([' hidden ']); if (packedInspection.items[0]?.node.ref !== 'hidden' || JSON.stringify(packedInspection).includes('Stay hidden.')) throw new Error('packed inspection activated or omitted its candidate'); if (rawRuntime.telemetry.usage('hidden').callCount !== 0 || rawRuntime.telemetry.inspectionUsage?.('hidden').callCount !== 1) throw new Error('packed inspection telemetry was not isolated');",
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
    "import { Contexture, LookupFailure, definePublication, type CompiledContext, type ContextNode, type JsonObject, type JsonValue, type Prompt, type PublicationDeclaration, type Resource, type View } from '@contexture/mcp';",
    "const prompt: Prompt = { opens: 'approval', description: 'Open approval.', modelMayOpen: false };",
    "const resource: Resource = { opens: 'runbook', uri: 'contexture://runbook', description: 'Read runbook.' };",
    "const publication: PublicationDeclaration = definePublication({ kind: 'role', name: 'publish', description: 'Preserve.', instructions: 'Save evidence.' }); void publication;",
    'const reason: LookupFailure = LookupFailure.NO_SUCH_MEMBER;',
    'declare const node: ContextNode; declare const view: View; void node; void view;',
    "const jsonValue: JsonValue = { values: [null, true, 1, 'text'] }; const jsonObject: JsonObject = { jsonValue }; const compiled: CompiledContext = { jsonObject }; void compiled;",
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
    '0.15.0rc1',
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
