/** Pure complete accepted-Journal projection. It performs no Host or business callbacks. */
import { List as PersistentList, Map as PersistentMap, Set as PersistentSet } from 'immutable';

import { GraphError, canonicalDigest, freezeJSON, parseCounter, validateID } from './canonical.js';
import { contractDigest } from './bindings.js';
import { History } from './history.js';
import { UnseededState, equalJSON, scalarOrder } from './events.js';
import type { JSONObject, PublicationContracts } from './model.js';
import { RELEASE_EVENT_TYPES, emptyReleaseState, reduceReleaseEvent } from './releases.js';
import type { ReleaseState } from './releases.js';

function corrupt(message: string): never {
  throw new GraphError('journal_corrupt', message);
}
function obj(value: unknown): JSONObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    corrupt('Expected Journal object');
  return value as JSONObject;
}
function list(value: unknown): readonly JSONObject[] {
  if (!Array.isArray(value)) corrupt('Expected Journal array');
  return value.map(obj);
}
function blob(value: unknown): JSONObject {
  const ref = obj(value);
  if (
    Object.keys(ref).length !== 3 ||
    !Object.hasOwn(ref, 'digest') ||
    !Object.hasOwn(ref, 'size') ||
    !Object.hasOwn(ref, 'media_type')
  )
    corrupt('Invalid required blob reference');
  contractDigest(ref.digest);
  parseCounter(ref.size);
  if (typeof ref.media_type !== 'string' || ref.media_type.length === 0)
    corrupt('Blob media type required');
  return ref;
}

export interface GraphJournalProjectionOptions {
  /** Trusted inert validation evidence; never a registry/handler callback during replay. */
  readonly publicationContracts?: PublicationContracts;
}

export class GraphJournalProjection {
  readonly records!: readonly JSONObject[];
  readonly histories: Readonly<Record<string, History>>;
  readonly checkpoint!: JSONObject;
  readonly storeID: string | undefined;
  readonly watermark: string;
  readonly lastRecordHash: string | null;
  readonly #options: GraphJournalProjectionOptions;
  readonly #recordEntries: PersistentList<JSONObject>;
  readonly #receipts: PersistentMap<string, JSONObject>;
  readonly #blobRefs: PersistentMap<string, JSONObject>;
  readonly #batches: PersistentSet<string>;
  readonly #releases: ReleaseState;
  #recordsCache: readonly JSONObject[] | undefined;
  #checkpointCache: JSONObject | undefined;

  constructor(
    value: unknown,
    options: GraphJournalProjectionOptions = {},
    prefix?: GraphJournalProjection,
  ) {
    if (prefix !== undefined && options !== prefix.#options)
      throw new GraphError(
        'contract_mismatch',
        'Extension requires the verified prefix validation evidence',
      );
    this.#options =
      prefix === undefined
        ? Object.freeze({
            ...(options.publicationContracts === undefined
              ? {}
              : {
                  publicationContracts: Object.freeze({ ...options.publicationContracts }),
                }),
          })
        : prefix.#options;
    options = this.#options;
    const records = list(freezeJSON(value));
    const histories = new Map<string, History>(Object.entries(prefix?.histories ?? {}));
    let receipts = prefix === undefined ? PersistentMap<string, JSONObject>() : prefix.#receipts;
    let blobRefs = prefix === undefined ? PersistentMap<string, JSONObject>() : prefix.#blobRefs;
    let batches = prefix === undefined ? PersistentSet<string>() : prefix.#batches;
    let releases = prefix === undefined ? emptyReleaseState() : prefix.#releases;
    const offset = prefix === undefined ? 0 : prefix.#recordEntries.size;
    let storeID: string | undefined = prefix?.storeID,
      previous = prefix?.lastRecordHash ?? null;
    for (const [ordinal, record] of records.entries()) {
      const required =
        'schema store_id journal_seq event_batch_id prev_record_hash events written_at actor_ref correlation_id payload_digest record_hash'.split(
          ' ',
        );
      if (
        required.some((key) => !Object.hasOwn(record, key)) ||
        Object.keys(record).some((key) => !required.includes(key) && key !== 'command_receipt')
      )
        corrupt('Missing required or unknown Journal header fields');
      validateID(record.actor_ref);
      validateID(record.correlation_id);
      const batch = validateID(record.event_batch_id);
      if (batches.has(batch)) corrupt('Duplicate Journal event batch identity');
      batches = batches.add(batch);
      if (
        typeof record.written_at !== 'string' ||
        !record.written_at.endsWith('Z') ||
        record.written_at.startsWith('0000-') ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u.test(
          record.written_at,
        ) ||
        !Number.isFinite(Date.parse(record.written_at)) ||
        new Date(record.written_at).toISOString().slice(0, 19) !== record.written_at.slice(0, 19)
      )
        corrupt('Invalid Journal UTC timestamp');
      if (
        record.schema !== 'contexture.journal-record/v1' ||
        record.journal_seq !== String(offset + ordinal + 1) ||
        record.prev_record_hash !== previous
      )
        corrupt('Journal sequence or hash chain differs');
      const currentStore = validateID(record.store_id);
      if (storeID !== undefined && currentStore !== storeID)
        corrupt('Journal store origin changed');
      storeID = currentStore;
      const payload = {
        events: record.events,
        ...(record.command_receipt === undefined
          ? {}
          : { command_receipt: record.command_receipt }),
      };
      contractDigest(record.record_hash);
      contractDigest(record.payload_digest);
      if (
        canonicalDigest(payload, 'contexture.journal-payload/v1') !== record.payload_digest ||
        canonicalDigest(
          Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'record_hash')),
          'contexture.journal-record/v1',
        ) !== record.record_hash
      )
        corrupt('Journal digest differs');
      previous = record.record_hash as string;
      const events = list(record.events);
      if (events.length === 0) corrupt('Complete event batch required');
      const graphEvents = new Set<string>();
      let lastGraphEvent: JSONObject | undefined;
      for (const event of events) {
        if (event.type === 'GraphChangeCommitted' || event.type === 'CommandCompleted') {
          lastGraphEvent = event;
          const graphID = validateID(event.graph_id);
          if (graphEvents.has(graphID))
            throw new GraphError(
              'unsupported_contract',
              'Existing History requires one graph event per graph per Journal record',
            );
          graphEvents.add(graphID);
          const history = histories.get(graphID);
          if (history === undefined) {
            histories.set(
              graphID,
              History.bootstrap(new UnseededState(graphID), event, {
                journalSeq: record.journal_seq as string,
                ...(options.publicationContracts === undefined
                  ? {}
                  : { publicationContracts: options.publicationContracts }),
              }),
            );
          } else {
            const tombstones = new Map(
              history.head.tombstones.map((t) => [t.node_id as string, t]),
            );
            for (const fact of event.resolved_facts === undefined
              ? []
              : list(event.resolved_facts)) {
              if (fact.type === 'NodeDeleted') {
                const tombstone = obj(fact.tombstone);
                tombstones.set(validateID(tombstone.node_id), tombstone);
              } else if (fact.type === 'CreationPolicyMigrated') {
                const id = validateID(fact.node_id),
                  prior = tombstones.get(id);
                if (prior !== undefined)
                  tombstones.set(id, freezeJSON({ ...prior, mutable: fact.after }) as JSONObject);
              }
            }
            histories.set(
              graphID,
              history.append(event, {
                journalSeq: record.journal_seq as string,
                tombstones: [...tombstones.values()],
                ...(options.publicationContracts === undefined
                  ? {}
                  : { publicationContracts: options.publicationContracts }),
              }),
            );
          }
        } else if (event.type === 'RecoveryActionRecorded') {
          validateID(event.action_id);
          if (typeof event.action !== 'string' || !event.action)
            corrupt('Recovery action required');
          const ref = blob(event.evidence),
            key = JSON.stringify([ref.digest, ref.media_type]);
          const prior = blobRefs.get(key);
          if (prior !== undefined && !equalJSON(prior, ref))
            corrupt('Conflicting required blob evidence');
          blobRefs = blobRefs.set(key, ref);
        } else if (
          RELEASE_EVENT_TYPES.includes(event.type as (typeof RELEASE_EVENT_TYPES)[number])
        ) {
          releases = reduceReleaseEvent(releases, event, record);
        } else {
          throw new GraphError('unsupported_contract', 'Unregistered required Journal event');
        }
      }
      if (record.command_receipt !== undefined) {
        const receipt = obj(record.command_receipt);
        const actor = validateID(receipt.actor_ref),
          key = validateID(receipt.idempotency_key);
        if (
          receipt.schema !== 'contexture.command-receipt/v1' ||
          receipt.actor_ref !== record.actor_ref ||
          receipt.journal_seq !== record.journal_seq ||
          receipts.has(JSON.stringify([actor, key]))
        )
          corrupt('Receipt actor, key or accepted position differs');
        validateID(receipt.graph_id);
        contractDigest(receipt.request_digest);
        parseCounter(receipt.revision);
        if (
          !['committed', 'noop'].includes(String(receipt.status)) ||
          !['strict', 'process_crash'].includes(String(receipt.durability))
        )
          corrupt('Invalid command receipt');
        if (
          lastGraphEvent !== undefined &&
          (receipt.graph_id !== lastGraphEvent.graph_id ||
            receipt.revision !== (lastGraphEvent.result_revision ?? lastGraphEvent.revision) ||
            receipt.request_digest !== lastGraphEvent.command_digest ||
            receipt.status !== (lastGraphEvent.type === 'CommandCompleted' ? 'noop' : 'committed'))
        )
          corrupt('Receipt differs from accepted graph event');
        receipts = receipts.set(JSON.stringify([actor, key]), receipt);
        const result = obj(receipt.operation_result);
        if (Object.hasOwn(result, 'blob')) {
          if (Object.keys(result).length !== 1) corrupt('Invalid operation result carrier');
          const ref = blob(result.blob),
            marker = JSON.stringify([ref.digest, ref.media_type]);
          const prior = blobRefs.get(marker);
          if (prior !== undefined && !equalJSON(prior, ref))
            corrupt('Conflicting receipt blob evidence');
          blobRefs = blobRefs.set(marker, ref);
        } else if (Object.keys(result).length !== 1 || !Object.hasOwn(result, 'inline')) {
          corrupt('Invalid operation result');
        }
      }
    }
    const ordered = [...histories].sort(([a], [b]) => scalarOrder(a, b));
    this.#recordEntries = (
      prefix === undefined ? PersistentList<JSONObject>() : prefix.#recordEntries
    ).concat(records);
    const table = Object.create(null) as Record<string, History>;
    for (const [graphID, history] of ordered) table[graphID] = history;
    this.histories = Object.freeze(table);
    this.storeID = storeID;
    this.watermark = String(this.#recordEntries.size);
    this.lastRecordHash = typeof previous === 'string' ? previous : null;
    this.#receipts = receipts;
    this.#blobRefs = blobRefs;
    this.#batches = batches;
    this.#releases = releases;
    Object.defineProperties(this, {
      records: {
        enumerable: true,
        get: () => {
          this.#recordsCache ??= Object.freeze(this.#recordEntries.toArray());
          return this.#recordsCache;
        },
      },
      checkpoint: {
        enumerable: true,
        get: () => {
          this.#checkpointCache ??= this.#checkpoint();
          return this.#checkpointCache;
        },
      },
    });
    Object.freeze(this);
  }

  #checkpoint(): JSONObject {
    return freezeJSON({
      graphs: Object.entries(this.histories)
        .sort(([a], [b]) => scalarOrder(a, b))
        .map(([, history]) => ({
          definition: history.head.definition.asJSON(),
          head: history.head.revision,
          definition_digest: history.head.definitionDigest,
          tombstones: history.head.tombstones,
        })),
      ...this.#releases,
      receipts_index: [...this.#receipts.values()].sort(
        (a, b) =>
          scalarOrder(a.actor_ref as string, b.actor_ref as string) ||
          scalarOrder(a.idempotency_key as string, b.idempotency_key as string),
      ),
      projection_versions: {},
      blob_refs: [...this.#blobRefs.values()].sort(
        (a, b) =>
          scalarOrder(a.digest as string, b.digest as string) ||
          scalarOrder(a.media_type as string, b.media_type as string),
      ),
    }) as JSONObject;
  }
  extend(suffix: unknown): GraphJournalProjection {
    return new GraphJournalProjection(suffix, this.#options, this);
  }
  history(graphID: string): History {
    const history = this.histories[validateID(graphID)];
    if (history === undefined)
      throw new GraphError('history_unavailable', 'Graph has no accepted definition');
    return history;
  }
}

/** Project actual accepted bytes only; no fabricated graph head or empty fallback. */
export function projectGraphJournal(
  records: unknown,
  options: GraphJournalProjectionOptions = {},
): JSONObject {
  return new GraphJournalProjection(records, options).checkpoint;
}
