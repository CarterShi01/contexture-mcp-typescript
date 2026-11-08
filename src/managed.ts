/**
 * SDK-neutral native managed-runtime candidate. This is not an accepted managed
 * profile, a replacement for the pinned static API, or a fleet/durability claim.
 */
export {
  GraphError,
  canonicalDigest,
  canonicalJSON,
  freezeJSON,
  thawJSON,
} from './core/graph/canonical.js';
export type { FrozenJSON, GraphErrorCode } from './core/graph/canonical.js';
export { GraphDefinition, PublicationContract, bindingDescriptor } from './core/graph/model.js';
export type {
  BindingDescriptor,
  JSONObject,
  NodeSpec,
  Portability,
  TemplatePart,
} from './core/graph/model.js';
export { GraphIndex } from './core/graph/index.js';
export { History } from './core/graph/history.js';
export { RevisionState } from './core/graph/events.js';
export { ManagedReference, formatReference, parseReference } from './core/graph/references.js';
export {
  BindingRegistration,
  ExecutionManifest,
  RegistryGeneration,
  compileManagedSchema,
} from './core/graph/bindings.js';
export type {
  BindingRegistrationOptions,
  ExecutionManifestOptions,
  ManagedCallContext,
  ManagedEffect,
  ManagedIdentity,
  ManagedSchema,
  ResolvedBinding,
} from './core/graph/bindings.js';
export { StructuralPlan } from './core/graph/compiler.js';
export type { ManagedCompilerOptions } from './core/graph/compiler.js';
export { ReadyGeneration, prepareGeneration } from './application/managed-generation.js';
export type {
  PreparationAdapterRegistration,
  PreparationContext,
  PreparedResource,
  ResourceLease,
  RetainedGeneration,
} from './application/managed-generation.js';
export { LocalServingCoordinator } from './application/managed-serving.js';
export type {
  CapturedRelease,
  LocalServingResult,
  ReleaseAuthority,
  ServingAttempt,
  ServingGeneration,
  ServingLease,
  ServingPreparationProvider,
} from './application/managed-serving.js';
export { ManagedRuntime } from './application/managed-runtime.js';
export type {
  ManagedRequest,
  ManagedRequestOptions,
  ManagedRunPin,
  RequestAuthority,
  RequestAuthorization,
} from './application/managed-runtime.js';
export { RunLeaseService } from './application/managed-run-leases.js';
export type { RunLeaseContext } from './application/managed-run-leases.js';
export { CatalogProfile, ManagedCatalogService } from './application/managed-catalog.js';
export type { CatalogRequest, CatalogStream } from './application/managed-catalog.js';
export type {
  CatalogSource,
  DefinitionReadPort,
  DefinitionReadRequest,
  DefinitionReadView,
  ServingReadPort,
} from './application/managed-read-authority.js';
export { CursorSigner, PageProfile, ManagedPagingService } from './application/managed-paging.js';
export type { PageOperation, PageRelation, PagingRequest } from './application/managed-paging.js';
export type { PageStoreOptions } from './application/managed-read-state.js';
export { ManagedWatchService, WatchProfile } from './application/managed-watch.js';
export type {
  CommittedBatchReadPort,
  CommittedDefinitionBatch,
  CommittedBatchWindow,
  CommittedReadCut,
  WatchOptions,
  WatchRequest,
} from './application/managed-watch.js';
