/** Pure native graph-authoring primitives; no physical filesystem adapter. */
export { GraphJournalProjection, projectGraphJournal } from './core/graph/journal-projection.js';
export type { GraphJournalProjectionOptions } from './core/graph/journal-projection.js';
export {
  TransactionEnvelope,
  PureRevisionState,
  DEFAULT_LIMITS,
} from './core/graph/transactions.js';
export type { TransactionLimits, PurePreparedTransaction } from './core/graph/transactions.js';
