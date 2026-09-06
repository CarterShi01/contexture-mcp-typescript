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
export type { ApplicationDeclaration } from './application.js';
export { defineTool } from './core/model/declarations.js';
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
} from './core/model/declarations.js';
export type { PromptDeclaration } from './core/mcp-interface/prompt.js';
export type { ResourceDeclaration } from './core/mcp-interface/resource.js';
export { Principal } from './core/foundation/principal.js';
export type { PrincipalOptions } from './core/foundation/principal.js';
export { currentGraph, currentPrincipal, currentTelemetry } from './core/model/runtime.js';
export {
  ContextureError,
  ContainmentCycleError,
  DeclarationError,
  DuplicateNameError,
  ModelValidationError,
  InputValidationError,
  NodeNotFoundError,
  PermissionError,
  RejectedError,
  UnresolvedReferenceError,
} from './core/foundation/errors.js';
