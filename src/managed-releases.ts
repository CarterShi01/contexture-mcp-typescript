/** Pure managed candidate release contracts, without a physical journal dependency. */
export {
  RELEASE_EVENT_TYPES,
  ReleaseRequest,
  attemptIdentity,
  emptyReleaseState,
  importReleaseState,
  reduceReleaseEvent,
  releaseIdentity,
  releaseReceipt,
  replayReleases,
} from './core/graph/releases.js';
export type { AttemptIdentity, ReleaseIdentity, ReleaseState } from './core/graph/releases.js';
export type { ServingObservationPort } from './application/managed-serving.js';
