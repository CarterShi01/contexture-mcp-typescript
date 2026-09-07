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
} from './core/model/declarations.js';
export type { CleanupRegistrar } from './core/model/channels.js';
export type { Prompt, PromptDeclaration } from './core/mcp-interface/prompt.js';
export type { Resource, ResourceDeclaration } from './core/mcp-interface/resource.js';
export { Principal } from './core/foundation/principal.js';
export type { PrincipalOptions } from './core/foundation/principal.js';
export {
  currentGraph,
  currentPrincipal,
  currentTelemetry,
  InMemoryTelemetry,
  reportTelemetry,
} from './core/model/runtime.js';
export type { NodeUsage, Telemetry, TelemetryEvent } from './core/model/runtime.js';
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
} from './core/foundation/errors.js';
export type { NodeNotFoundFacts } from './core/foundation/errors.js';
