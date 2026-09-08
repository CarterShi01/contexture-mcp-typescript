/**
 * Contexture's declaration-facing TypeScript API.
 *
 * Runtime compilation and Host adapters are deliberately imported from
 * @contexture/mcp/server so declaration-only consumers do not load an SDK.
 */
export {
  CONTEXTURE_SPECIFICATION_REVISION,
  CONTEXTURE_SPECIFICATION_VERSION,
} from './core/foundation/specification.js';
export {
  DISCOVER_GATEWAY_NAME,
  GATEWAY_TOOL_NAMES,
  INVOKE_GATEWAY_NAME,
  INVOKE_READ_ONLY_GATEWAY_NAME,
  OPEN_GATEWAY_NAME,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  REFERENCE_SEPARATOR,
} from './core/foundation/vocabulary.js';
export type { GatewayName } from './core/foundation/vocabulary.js';
export { Contexture, defineApplication } from './application.js';
export type { ApplicationDeclaration, ManagedApplicationDeclaration } from './application.js';
export { Channels } from './core/model/channels.js';
export type { ChannelHandle } from './core/model/channels.js';
export { defineTool } from './core/model/declarations.js';
export { ControllerManager } from './core/model/manager.js';
export type { RoleFactory, SkillFactory, ToolFactory } from './core/model/manager.js';
export type {
  BaseNodeDeclaration,
  Factory,
  NodeDeclaration,
  NodeKind,
  RoleDeclaration,
  SkillDeclaration,
  ToolCallContext,
  ToolDeclaration,
  ToolDefinition,
} from './core/model/declarations.js';
export type { CleanupRegistrar } from './core/model/channels.js';
export type {
  Prompt,
  PromptDeclaration,
  Resource,
  ResourceDeclaration,
} from './core/foundation/publications.js';
export { Principal } from './core/foundation/principal.js';
export type { PrincipalOptions } from './core/foundation/principal.js';
export {
  currentPrincipal,
  currentTelemetry,
  InMemoryTelemetry,
  reportTelemetry,
} from './core/model/runtime.js';
export type { NodeUsage, Telemetry, TelemetryEvent } from './core/model/runtime.js';
export { currentGraph, withGraph } from './core/model/graph-context.js';
export {
  RootOutsideSelectionError,
  RootSelection,
  RootSelectionError,
  SelectedGraph,
} from './core/model/root-selection.js';
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
  WrongDoorError,
} from './core/foundation/errors.js';
export type { NodeNotFoundFacts } from './core/foundation/errors.js';
