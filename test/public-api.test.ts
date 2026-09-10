import assert from 'node:assert/strict';
import test from 'node:test';

import * as authoring from '../src/index.js';
import * as core from '../src/core/index.js';
import * as server from '../src/server/index.js';

const authoringConcepts = {
  Channels: authoring.Channels,
  Contexture: authoring.Contexture,
  ContextureError: authoring.ContextureError,
  DeclarationError: authoring.DeclarationError,
  DuplicateNameError: authoring.DuplicateNameError,
  ModelValidationError: authoring.ModelValidationError,
  NodeNotFoundError: authoring.NodeNotFoundError,
  Principal: authoring.Principal,
  bindingInstruction: authoring.bindingInstruction,
  definePostProcess: authoring.definePostProcess,
  definePreProcess: authoring.definePreProcess,
  defineTool: authoring.defineTool,
  version: authoring.PACKAGE_VERSION,
  currentGraph: authoring.currentGraph,
  currentPrincipal: authoring.currentPrincipal,
  currentTelemetry: authoring.currentTelemetry,
} as const;

const serverConcepts = {
  ApplicationRuntime: server.ApplicationRuntime,
  Auth: server.Auth,
  ContextureOptions: server.ContextureOptions,
  ContextureServer: server.ContextureServer,
  defaultHost: server.DEFAULT_HOST,
  defaultPath: server.DEFAULT_PATH,
  defaultPort: server.DEFAULT_PORT,
  FixedRootSelector: server.FixedRootSelector,
  HeaderRootSelector: server.HeaderRootSelector,
  InMemoryTelemetry: server.InMemoryTelemetry,
  currentTelemetry: server.currentTelemetry,
  reportTelemetry: server.reportTelemetry,
  withTelemetry: server.withTelemetry,
  Launch: server.Launch,
  rootsHeader: server.ROOTS_HEADER,
  ServeError: server.ServeError,
  buildServer: server.buildServer,
  compileRuntimeApplication: server.compileRuntimeApplication,
  compileStructuralApplication: server.compileStructuralApplication,
  configureLogging: server.configureLogging,
  claudeCodeConfig: server.claudeCodeConfig,
  cliCommands: server.cliCommands,
  codexConfig: server.codexConfig,
  cursorConfig: server.cursorConfig,
} as const;

const coreConcepts = {
  ApplicationRuntime: core.ApplicationRuntime,
  Channels: core.Channels,
  CompileLevel: core.CompileLevel,
  ContextureError: core.ContextureError,
  ControllerManager: core.ControllerManager,
  DeclarationError: core.DeclarationError,
  DuplicateNameError: core.DuplicateNameError,
  InMemoryTelemetry: core.InMemoryTelemetry,
  ModelValidationError: core.ModelValidationError,
  NodeNotFoundError: core.NodeNotFoundError,
  Principal: core.Principal,
  RootSelection: core.RootSelection,
  SurfaceSelection: core.SurfaceSelection,
  WrongDoorError: core.WrongDoorError,
  bindTool: core.bindTool,
  currentGraph: core.currentGraph,
  currentPrincipal: core.currentPrincipal,
  currentTelemetry: core.currentTelemetry,
} as const;

test('public authoring concepts resolve through the SDK-neutral package entry point', () => {
  for (const [name, value] of Object.entries(authoringConcepts)) {
    assert.notEqual(value, undefined, name);
  }
});

test('public server concepts resolve through the Host package entry point', () => {
  for (const [name, value] of Object.entries(serverConcepts)) {
    assert.notEqual(value, undefined, name);
  }
});

test('public core facade resolves SDK-neutral Python kernel concepts', () => {
  for (const [name, value] of Object.entries(coreConcepts)) {
    assert.notEqual(value, undefined, name);
  }
});

test('public TypeScript declaration types map Python Role, Skill, Tool, Prompt and Resource concepts', () => {
  const role: authoring.RoleDeclaration = {
    kind: 'role',
    name: 'role',
    description: 'Role.',
    instructions: 'Route.',
  };
  const preProcess: authoring.PreProcessDeclaration = authoring.definePreProcess({
    kind: 'role',
    name: 'prepare',
    description: 'Prepare.',
    instructions: 'Prepare.',
  });
  const postProcess: authoring.PostProcessDeclaration = authoring.definePostProcess({
    kind: 'role',
    name: 'finish',
    description: 'Finish.',
    instructions: 'Finish.',
  });
  const skill: authoring.SkillDeclaration = {
    kind: 'skill',
    name: 'skill',
    description: 'Skill.',
    instructions: 'Read.',
  };
  const tool: authoring.ToolDeclaration = {
    kind: 'tool',
    name: 'tool',
    description: 'Tool.',
    readOnly: true,
    invoke: () => undefined,
  };
  const prompt: authoring.Prompt = { opens: 'role', description: 'Open role.' };
  const resource: authoring.Resource = {
    opens: 'tool',
    uri: 'contexture://tool',
    description: 'Read tool.',
  };
  void role;
  void preProcess;
  void postProcess;
  void skill;
  void tool;
  void prompt;
  void resource;
});

test('removed Publication authoring API is absent at runtime', () => {
  assert.equal('definePublication' in authoring, false);
  assert.equal('Publication' in authoring, false);
});

test('public server telemetry types remain directly importable', () => {
  const collector: server.Telemetry = new server.InMemoryTelemetry();
  const usage: server.NodeUsage = collector.usage('public');
  const event: server.TelemetryEvent = {
    ref: 'public',
    failed: false,
    occurredAt: new Date(0).toISOString(),
  };
  assert.equal(usage.ref, 'public');
  assert.equal(event.ref, 'public');
});

test('public JSON and compiled context types retain native recursive shapes', () => {
  const value: authoring.JsonValue = { nested: [null, true, 3, 'text'] };
  const object: authoring.JsonObject = { value };
  const context: authoring.CompiledContext = { object };
  assert.deepEqual(context, { object: { value: { nested: [null, true, 3, 'text'] } } });
});
