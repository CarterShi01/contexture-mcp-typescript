export {
  CONTEXTURE_SPECIFICATION_REVISION,
  CONTEXTURE_SPECIFICATION_VERSION,
} from './foundation/specification.js';
export type {
  BaseNodeDeclaration,
  Channels,
  CleanupRegistrar,
  Factory,
  NodeDeclaration,
  NodeKind,
  RoleDeclaration,
  SkillDeclaration,
  ToolCallContext,
  ToolDeclaration,
} from './model/declarations.js';
export { defineTool } from './model/declarations.js';
export { compileApplication, compileDisclosureApplication } from './model/compiler.js';
export type {
  ApplicationCompilation,
  CompiledApplication,
  CompiledNode,
  CompiledRole,
  CompiledSkill,
  CompiledTool,
} from './model/compiler.js';
export { Disclosure, RefusedError } from './model/disclosure.js';
export type { Discovery, RoutingCard } from './model/disclosure.js';
export {
  ApplicationRuntime,
  currentGraph,
  currentPrincipal,
  currentRootSelection,
  currentTelemetry,
  InMemoryTelemetry,
  reportTelemetry,
  WrongDoorError,
} from './model/runtime.js';
export type { NodeUsage, Telemetry, TelemetryEvent } from './model/runtime.js';
export {
  RootOutsideSelectionError,
  RootSelection,
  RootSelectionError,
  SelectedGraph,
} from './model/root-selection.js';
export { bindTool } from './model/binding.js';
export type { JsonObject, JsonValue, ToolBinding } from './model/binding.js';
export { withChannels } from './model/channels.js';
export {
  DISCLOSURE_GATEWAY,
  EXECUTION_GATEWAY,
  Gateway,
  GATEWAY,
  takenByPersonMessage,
  unresolvedMessage,
  wrongDoorMessage,
} from './model/system-api.js';
export type { GatewayTool } from './model/system-api.js';
export { GATEWAY_TOOL_NAMES } from './mcp-interface/tool.js';
export type { GatewayName } from './mcp-interface/tool.js';
export type { Prompt, PromptDeclaration } from './mcp-interface/prompt.js';
export type { Resource, ResourceDeclaration } from './mcp-interface/resource.js';
export { Principal } from './foundation/principal.js';
export type { PrincipalOptions } from './foundation/principal.js';
export {
  ContextureError,
  ContainmentCycleError,
  DeclarationError,
  DuplicateNameError,
  ModelValidationError,
  InputValidationError,
  LookupFailure,
  NodeNotFoundError,
  PermissionError,
  RejectedError,
  UnresolvedReferenceError,
} from './foundation/errors.js';
export type { NodeNotFoundFacts } from './foundation/errors.js';
