/** Native physical graph authoring over accepted FileJournal facts, not a second store. */
import {
  GraphError,
  canonicalDigest,
  canonicalJSON,
  decodeJSON,
  freezeJSON,
  parseCounter,
  validateID,
} from '../core/graph/canonical.js';
import type { FrozenJSON } from '../core/graph/canonical.js';
import { contractDigest } from '../core/graph/bindings.js';
import type { ManagedIdentity } from '../core/graph/bindings.js';
import { GraphIndex } from '../core/graph/index.js';
import { GraphDefinition, placements } from '../core/graph/model.js';
import type { JSONObject, PublicationContracts } from '../core/graph/model.js';
import { definitionDiff } from '../core/graph/diff.js';
import {
  RevisionState,
  UnseededState,
  bootstrapEvent,
  changeEvent,
  equalJSON,
  resolveFacts,
  scalarOrder,
} from '../core/graph/events.js';
import { GraphJournalProjection, projectGraphJournal } from '../core/graph/journal-projection.js';
import type { GraphJournalProjectionOptions } from '../core/graph/journal-projection.js';
import type { History } from '../core/graph/history.js';
import {
  DEFAULT_LIMITS,
  PureRevisionState,
  TransactionEnvelope,
  prepare,
  recheckPrepared,
} from '../core/graph/transactions.js';
import type {
  PurePreparedTransaction,
  PureTransactionOptions,
  TransactionLimits,
} from '../core/graph/transactions.js';
import type {
  DefinitionReadPort,
  DefinitionReadRequest,
  DefinitionReadView,
} from '../application/managed-read-authority.js';
import type {
  CommittedBatchReadPort,
  CommittedReadCut,
  CommittedBatchWindow,
} from '../application/managed-watch.js';
import { FileJournal, CommitUnknown } from './managed-journal.js';
import type { ProjectionPort } from './managed-journal.js';
import type {
  JournalHistoryView,
  ReleaseGraphProjector,
  ReleaseHistoryReader,
  ReleaseHostAdmission,
  ReleaseHostContext,
  ReleaseHostPort,
} from './managed-releases.js';

export { FileJournal, CommitUnknown };
export { GraphJournalProjection, projectGraphJournal };
export type { GraphJournalProjectionOptions };
export {
  StoreOperations,
  NATIVE_JOURNAL_SOFTWARE_SUPPORT,
  REGISTERED_MANAGED_SCHEMA_DIGEST,
  DEFAULT_STORE_BUDGET,
  checkSoftwareCompatibility,
  trustedStoreOperator,
  storeFailure,
  readStoreFile,
} from './managed-store-ops.js';
export type {
  StoreResult,
  StoreOperation,
  StoreAnchor,
  BackupArtifact,
  SoftwareCompatibility,
  TrustedStoreOperator,
} from './managed-store-ops.js';
export type { OfflineJournalBudget } from './managed-journal.js';

export interface GraphOwnerContext {
  readonly actor_ref: string;
  readonly identity: ManagedIdentity;
  readonly host_permissions: readonly string[];
}
export interface GraphApproval {
  readonly actor_id: string;
  readonly tenant_id: string;
  readonly authority_revision: string;
  readonly subject_digest: string;
  readonly expires_at: string;
}
export interface GraphAdmission {
  readonly context: GraphOwnerContext;
  readonly graph_id: string;
  readonly operation: string;
  readonly operations: readonly string[];
  readonly base_revision: string;
  readonly base_digest: string;
  readonly candidate_digest: string;
  readonly impact: readonly string[];
  readonly reference_targets: readonly string[];
  readonly approval_subject_digest: string | undefined;
  readonly approval: GraphApproval | undefined;
  readonly payload_refs: readonly JSONObject[];
  readonly release?: ReleaseHostAdmission;
}
export interface GraphAdmissionDecision {
  readonly allowed: boolean;
  readonly authority_revision: string;
  readonly scope_ids: readonly string[];
  readonly approval_required: boolean;
}
export interface GraphOwnerHost {
  current(): GraphOwnerContext;
  verifyApproval(
    context: GraphOwnerContext,
    reference: string,
    subjectDigest: string,
    now: string,
  ): GraphApproval;
  decide(admission: GraphAdmission): GraphAdmissionDecision;
  /** Independent current authority fence, synchronous and shared with release publication. */
  fence<T>(context: GraphOwnerContext, action: () => T): T;
}
export interface GraphOwnerSerialization {
  /** Explicit shared serialization; invoke action once synchronously, never retain it. */
  run<T>(action: () => T): T;
}
/** Explicit local serialization capability. It grants no identity, policy or approval. */
export class SynchronousJournalSerialization implements GraphOwnerSerialization {
  #busy = false;
  run<T>(action: () => T): T {
    if (this.#busy)
      throw new GraphError('resource_busy', 'Shared Journal operation already active');
    this.#busy = true;
    try {
      return synchronous(action());
    } finally {
      this.#busy = false;
    }
  }
}

function synchronous<T>(value: T): T {
  if (value instanceof Promise) {
    void value.catch(() => undefined);
    throw new GraphError('permission_denied', 'Trusted owner ports must complete synchronously');
  }
  return value;
}
function utc(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.endsWith('Z') ||
    value.startsWith('0000-') ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new GraphError('schema_invalid', 'Canonical UTC timestamp required');
  return value;
}
function compareUTC(left: string, right: string): number {
  const a = utc(left),
    b = utc(right);
  if (a.slice(0, 19) !== b.slice(0, 19)) return a.slice(0, 19) < b.slice(0, 19) ? -1 : 1;
  const x = a.slice(19, -1).replace('.', ''),
    y = b.slice(19, -1).replace('.', '');
  const width = Math.max(x.length, y.length);
  return x.padEnd(width, '0') < y.padEnd(width, '0')
    ? -1
    : x.padEnd(width, '0') > y.padEnd(width, '0')
      ? 1
      : 0;
}
function object(value: unknown, required?: string, optional = ''): JSONObject {
  const obj = freezeJSON(value);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
    throw new GraphError('schema_invalid', 'Expected closed native graph object');
  if (required !== undefined) {
    const allowed = new Set(`${required} ${optional}`.split(' ').filter(Boolean));
    if (
      required
        .split(' ')
        .filter(Boolean)
        .some((key) => !Object.hasOwn(obj, key)) ||
      Object.keys(obj).some((key) => !allowed.has(key))
    )
      throw new GraphError('schema_invalid', 'Missing required or unknown graph fields');
  }
  return obj as JSONObject;
}
function current(value: GraphOwnerContext): GraphOwnerContext {
  if (!Array.isArray(value.host_permissions))
    throw new GraphError('permission_denied', 'Host permissions required');
  return Object.freeze({
    actor_ref: validateID(value.actor_ref),
    identity: Object.freeze({
      actor_id: validateID(value.identity.actor_id),
      tenant_id: validateID(value.identity.tenant_id),
      authority_revision: validateID(value.identity.authority_revision),
    }),
    host_permissions: Object.freeze(
      [...new Set(value.host_permissions.map((id) => validateID(id)))].sort(scalarOrder),
    ),
  });
}
function ids(snapshot: RevisionState): readonly string[] {
  return Object.freeze(Object.keys(snapshot.definition.nodes).sort(scalarOrder));
}
function pure(snapshot: RevisionState): PureRevisionState {
  return new PureRevisionState(snapshot.definition, snapshot.revision, snapshot.tombstones);
}
function validationOptions(options: GraphJournalProjectionOptions): GraphJournalProjectionOptions {
  if (options.publicationContracts === undefined) return Object.freeze({});
  return Object.freeze({
    publicationContracts: Object.freeze({ ...options.publicationContracts }),
  });
}
export function graphJournalProjector(options: GraphJournalProjectionOptions = {}): ProjectionPort {
  const captured = validationOptions(options);
  return (records) => projectGraphJournal(records, captured);
}

interface IssuedPreview {
  readonly storeID: string;
  readonly context: GraphOwnerContext;
  readonly request: JSONObject;
  readonly expiresAt: string;
  readonly definition?: GraphDefinition;
  readonly prepared?: PurePreparedTransaction;
  readonly digest: string;
}
const previewValues = new WeakMap<GraphPreview, IssuedPreview>();
const previewToken = Symbol('owner-issued graph preview');
export class GraphPreview {
  readonly receipt: JSONObject;
  constructor(token: symbol, receipt: JSONObject, issued: IssuedPreview) {
    if (token !== previewToken) throw new GraphError('schema_invalid', 'Use owner preview methods');
    this.receipt = receipt;
    previewValues.set(this, issued);
    Object.freeze(this);
  }
}
const bindings = new WeakMap<FileJournal, FileJournalGraphOwner>();

export class FileJournalGraphOwner {
  readonly #host: GraphOwnerHost;
  readonly #serialization: GraphOwnerSerialization;
  readonly #clock: () => string;
  readonly #validation: GraphJournalProjectionOptions;
  readonly #limits: TransactionLimits;
  readonly storeID: string;
  #journal: FileJournal;
  #busy = false;
  #closed = false;
  #stopped = false;
  #confirmedSequence = '0';
  #confirmedHash: FrozenJSON = null;
  #confirmedProjection: GraphJournalProjection | undefined;

  constructor(
    journal: FileJournal,
    options: {
      host: GraphOwnerHost;
      serialization: GraphOwnerSerialization;
      clock: () => string;
      publicationContracts?: PublicationContracts;
      limits?: TransactionLimits;
    },
  ) {
    if (!(journal instanceof FileJournal))
      throw new GraphError('schema_invalid', 'Native FileJournal custody required');
    if (bindings.has(journal))
      throw new GraphError('resource_busy', 'Journal already has a graph owner');
    this.#journal = journal;
    this.storeID = validateID(journal.meta.store_id);
    this.#host = Object.freeze({
      current: options.host.current.bind(options.host),
      verifyApproval: options.host.verifyApproval.bind(options.host),
      decide: options.host.decide.bind(options.host),
      fence: options.host.fence.bind(options.host),
    });
    this.#serialization = Object.freeze({
      run: options.serialization.run.bind(options.serialization),
    });
    this.#clock = options.clock;
    if (typeof this.#clock !== 'function') throw new TypeError('Explicit Host clock required');
    this.#validation = validationOptions(options);
    const limits = object(options.limits ?? DEFAULT_LIMITS, Object.keys(DEFAULT_LIMITS).join(' '));
    if (
      Object.values(limits).some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0)
    )
      throw new GraphError('schema_invalid', 'Positive graph processing limits required');
    this.#limits = limits as unknown as TransactionLimits;
    this.replay();
    bindings.set(journal, this);
    Object.freeze(this);
  }
  get writesStopped(): boolean {
    return this.#closed || this.#stopped;
  }
  close(): void {
    if (this.#busy) throw new GraphError('resource_busy', 'Cannot detach active graph owner');
    this.#closed = true;
    this.#confirmedProjection = undefined;
    if (bindings.get(this.#journal) === this) bindings.delete(this.#journal);
  }
  private replay(): GraphJournalProjection {
    if (this.#confirmedProjection?.watermark === this.#journal.watermark)
      return this.#confirmedProjection;
    const result =
      this.#confirmedProjection === undefined
        ? new GraphJournalProjection(this.#journal.records(), this.#validation)
        : this.#confirmedProjection.extend(
            this.#journal.records(this.#confirmedProjection.watermark),
          );
    if (result.watermark !== this.#journal.watermark) throw new CommitUnknown();
    if (result.storeID !== undefined && result.storeID !== this.storeID)
      throw new GraphError('contract_mismatch', 'Journal store origin differs');
    this.#confirmedSequence = result.watermark;
    this.#confirmedHash = result.lastRecordHash;
    this.#confirmedProjection = result;
    return result;
  }
  private ready(): void {
    if (this.#closed) throw new GraphError('resource_busy', 'Graph owner is closed');
    if (this.#stopped) throw new CommitUnknown();
    try {
      this.#journal.assertWritable();
    } catch (error) {
      this.#stopped = true;
      throw error;
    }
  }
  private operate<T>(
    action: (context: GraphOwnerContext, cut: GraphJournalProjection) => T,
    sharedAppend = false,
  ): T {
    if (this.#busy) throw new GraphError('resource_busy', 'Graph owner callback reentry refused');
    this.ready();
    this.#busy = true;
    let serialOpen = true,
      serialEntered = false;
    try {
      const serialized = synchronous(
        this.#serialization.run(() => {
          if (!serialOpen || serialEntered)
            throw new GraphError('permission_denied', 'Serialization capability closed');
          serialEntered = true;
          const context = this.identity(),
            cut = this.replay();
          let open = true,
            entered = false;
          try {
            const result = synchronous(
              this.#host.fence(context, () => {
                if (!open || entered)
                  throw new GraphError('permission_denied', 'Host fence capability closed');
                entered = true;
                this.check(context, cut.watermark);
                const dispatched = synchronous(action(context, cut));
                if (this.#journal.watermark !== this.#confirmedSequence) {
                  if (!sharedAppend) throw new CommitUnknown();
                  this.replay();
                }
                return dispatched;
              }),
            );
            if (!entered)
              throw new GraphError('permission_denied', 'Host fence did not invoke dispatch');
            return result;
          } finally {
            open = false;
          }
        }),
      );
      if (!serialEntered)
        throw new GraphError('permission_denied', 'Serialization did not invoke dispatch');
      return serialized;
    } catch (error) {
      if (error instanceof CommitUnknown) this.#stopped = true;
      throw error;
    } finally {
      serialOpen = false;
      this.#busy = false;
    }
  }
  private check(context: GraphOwnerContext, watermark: string): void {
    this.ready();
    if (!equalJSON(this.identity(), context) || this.#journal.watermark !== watermark)
      throw new GraphError('approval_stale', 'Current identity/authority or Journal cut changed');
  }
  private identity(): GraphOwnerContext {
    return current(synchronous(this.#host.current()));
  }
  private approval(
    context: GraphOwnerContext,
    reference: unknown,
    subject: string,
    now: string,
  ): GraphApproval | undefined {
    if (reference === undefined) return undefined;
    const raw = synchronous(
      this.#host.verifyApproval(context, validateID(reference), contractDigest(subject), utc(now)),
    );
    const proof = object(raw, 'actor_id tenant_id authority_revision subject_digest expires_at');
    if (
      proof.actor_id !== context.identity.actor_id ||
      proof.tenant_id !== context.identity.tenant_id ||
      proof.authority_revision !== context.identity.authority_revision ||
      proof.subject_digest !== subject ||
      compareUTC(proof.expires_at as string, now) <= 0
    )
      throw new GraphError(
        'approval_stale',
        'Approval does not bind current actor/authority/exact subject',
      );
    return proof as unknown as GraphApproval;
  }
  private decide(request: GraphAdmission, partial = false): readonly string[] {
    const result = synchronous(this.#host.decide(request));
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof result.allowed !== 'boolean' ||
      typeof result.approval_required !== 'boolean' ||
      !Array.isArray(result.scope_ids) ||
      result.authority_revision !== request.context.identity.authority_revision
    )
      throw new GraphError('permission_denied', 'Current admission evidence required');
    const scope = Object.freeze([...new Set(result.scope_ids.map((id) => validateID(id)))]);
    if (
      !result.allowed ||
      (!partial &&
        [...request.impact, ...request.reference_targets].some((id) => !scope.includes(id)))
    )
      throw new GraphError('permission_denied', 'Current admission denied or incomplete');
    if (result.approval_required && request.approval === undefined)
      throw new GraphError('approval_stale', 'Current policy requires exact approval');
    return scope;
  }
  private request(
    context: GraphOwnerContext,
    snapshot: RevisionState | undefined,
    graphID: string,
    operation: string,
    extra: Partial<Omit<GraphAdmission, 'context' | 'graph_id' | 'operation'>> = {},
  ): GraphAdmission {
    const digest = snapshot?.definitionDigest ?? new UnseededState(graphID).definitionDigest;
    return Object.freeze({
      context,
      graph_id: validateID(graphID),
      operation,
      operations: Object.freeze([]),
      base_revision: snapshot?.revision ?? '0',
      base_digest: digest,
      candidate_digest: digest,
      impact: snapshot === undefined ? Object.freeze([]) : ids(snapshot),
      reference_targets: Object.freeze([]),
      approval_subject_digest: undefined,
      approval: undefined,
      payload_refs: Object.freeze([]),
      ...extra,
    });
  }
  private readSnapshot(
    context: GraphOwnerContext,
    cut: GraphJournalProjection,
    graphID: string,
    revision?: string,
  ): RevisionState {
    const history = cut.history(graphID);
    this.decide(this.request(context, history.head, graphID, 'graph.read'));
    const snapshot = revision === undefined ? history.head : history.at(revision);
    this.decide(this.request(context, snapshot, graphID, 'graph.read'));
    return snapshot;
  }
  read(graphID: string, revision?: string): RevisionState {
    return this.operate((context, cut) => {
      const state = this.readSnapshot(context, cut, graphID, revision);
      this.check(context, cut.watermark);
      return state;
    });
  }
  history(graphID: string): History {
    return this.operate((context, cut) => {
      const history = cut.history(graphID);
      for (const record of history.records)
        this.decide(this.request(context, record.state, graphID, 'graph.read'));
      this.check(context, cut.watermark);
      return history;
    });
  }
  export(graphID: string, revision?: string): Uint8Array {
    return canonicalJSON(this.read(graphID, revision).definition.asJSON());
  }
  receipt(graphID: string, key: string): JSONObject | null {
    return this.operate((context, cut) => {
      this.readSnapshot(context, cut, graphID);
      const prior = this.#journal.getReceipt(context.actor_ref, validateID(key));
      this.check(context, cut.watermark);
      return prior?.graph_id === graphID ? object(prior) : null;
    });
  }
  private prior(
    context: GraphOwnerContext,
    cut: GraphJournalProjection,
    graphID: string,
    key: string,
    digest: string,
  ): JSONObject | undefined {
    const prior = this.#journal.getReceipt(context.actor_ref, validateID(key));
    if (prior === null) return undefined;
    this.readSnapshot(context, cut, validateID(prior.graph_id));
    if (prior.graph_id !== graphID || prior.request_digest !== digest)
      throw new GraphError('idempotency_conflict', 'Actor/key accepted a different command');
    this.check(context, cut.watermark);
    return object(prior);
  }
  private budget(definition: GraphDefinition): void {
    const index = GraphIndex.build(definition, this.#validation.publicationContracts);
    if (
      Object.keys(definition.nodes).length > this.#limits.max_nodes ||
      canonicalJSON(definition.asJSON()).length > this.#limits.max_definition_bytes
    )
      throw new GraphError('limit_exceeded', 'Definition processing budget exceeded');
    let edges = definition.roots.length + definition.publications.length;
    for (const node of index.walk()) {
      edges +=
        node.uses.length +
        (node.kind === 'role' ? placements(node.members).length : 0) +
        (node.kind === 'tool' ? 0 : (node.instruction_template?.parts.length ?? 0));
      if (
        index.locations[node.node_id]!.depth > this.#limits.max_depth ||
        canonicalJSON(node).length > this.#limits.max_node_bytes
      )
        throw new GraphError('limit_exceeded', 'Node processing budget exceeded');
    }
    if (edges > this.#limits.max_edges)
      throw new GraphError('limit_exceeded', 'Edge budget exceeded');
  }
  private payload(
    context: GraphOwnerContext,
    cut: GraphJournalProjection,
    graphID: string,
    reference: unknown,
  ): Uint8Array {
    const ref = object(reference, 'digest size media_type');
    contractDigest(ref.digest);
    if (
      ref.media_type !== 'application/json' ||
      parseCounter(ref.size) > BigInt(this.#limits.max_definition_bytes)
    )
      throw new GraphError('limit_exceeded', 'Canonical definition blob budget exceeded');
    this.decide(
      this.request(context, cut.histories[graphID]?.head, graphID, 'graph.payload', {
        payload_refs: Object.freeze([ref]),
      }),
    );
    this.check(context, cut.watermark);
    return Uint8Array.from(this.#journal.getBlob(ref));
  }
  private bootstrap(value: unknown, context: GraphOwnerContext, cut: GraphJournalProjection) {
    if (!context.host_permissions.includes('graph.bootstrap'))
      throw new GraphError('permission_denied', 'Independent Host bootstrap permission required');
    if (value instanceof Uint8Array) {
      if (value.length > this.#limits.max_transaction_bytes)
        throw new GraphError('limit_exceeded', 'Bootstrap byte budget exceeded');
      value = decodeJSON(value);
    }
    const request = object(
      value,
      'schema graph_id expected_revision seed approval_ref idempotency_key reason correlation_id',
    );
    if (
      request.schema !== 'contexture.bootstrap/v1' ||
      request.expected_revision !== '0' ||
      typeof request.reason !== 'string' ||
      request.reason.length === 0
    )
      throw new GraphError('schema_invalid', 'Closed native bootstrap envelope required');
    for (const field of ['graph_id', 'approval_ref', 'idempotency_key', 'correlation_id'])
      validateID(request[field]);
    if (canonicalJSON(request).length > this.#limits.max_transaction_bytes)
      throw new GraphError('limit_exceeded', 'Bootstrap envelope budget exceeded');
    const payload = object(request.seed);
    let raw: unknown;
    if (Object.keys(payload).length === 1 && Object.hasOwn(payload, 'inline')) raw = payload.inline;
    else if (Object.keys(payload).length === 1 && Object.hasOwn(payload, 'blob')) {
      const bytes = this.payload(context, cut, request.graph_id as string, payload.blob);
      raw = decodeJSON(bytes);
      if (!Buffer.from(bytes).equals(Buffer.from(canonicalJSON(raw))))
        throw new GraphError('schema_invalid', 'Definition blob must contain canonical JSON');
    } else throw new GraphError('schema_invalid', 'Exactly one bootstrap payload required');
    const definition = GraphDefinition.fromJSON(raw, this.#validation.publicationContracts);
    if (definition.graph_id !== request.graph_id)
      throw new GraphError('identity_conflict', 'Bootstrap graph identity differs');
    this.budget(definition);
    if (
      canonicalJSON([{ type: 'GraphSeeded', before: null, after: definition.asJSON() }]).length >
      this.#limits.max_resolved_bytes
    )
      throw new GraphError('limit_exceeded', 'Bootstrap fact budget exceeded');
    const digest = canonicalDigest(
      {
        schema: 'contexture.bootstrap/v1',
        graph_id: definition.graph_id,
        expected_revision: '0',
        seed_digest: definition.definitionDigest,
        reason: request.reason,
      },
      'contexture.command/v1',
    );
    return { request, definition, digest };
  }
  previewBootstrap(value: unknown, options: { expiresAt: string }): GraphPreview {
    return this.operate((context, cut) => {
      const { request, definition, digest } = this.bootstrap(value, context, cut);
      if (cut.histories[definition.graph_id] !== undefined)
        throw new GraphError('revision_conflict', 'Bootstrap requires unseeded graph');
      const now = utc(this.#clock()),
        expiresAt = utc(options.expiresAt);
      if (compareUTC(expiresAt, now) <= 0)
        throw new GraphError('approval_stale', 'Preview expiry must be in the future');
      const proof = this.approval(context, request.approval_ref, digest, now);
      this.decide(
        this.request(context, undefined, definition.graph_id, 'graph.bootstrap.preview', {
          operations: Object.freeze(['bootstrap']),
          candidate_digest: definition.definitionDigest,
          impact: Object.freeze(Object.keys(definition.nodes).sort(scalarOrder)),
          approval_subject_digest: digest,
          approval: proof,
        }),
      );
      if (proof === undefined)
        throw new GraphError('approval_stale', 'Bootstrap requires verified exact approval');
      this.check(context, cut.watermark);
      if (compareUTC(expiresAt, this.#clock()) <= 0)
        throw new GraphError('approval_stale', 'Bootstrap preview expired during admission');
      return new GraphPreview(
        previewToken,
        object({ graph_id: definition.graph_id, request_digest: digest, expires_at: expiresAt }),
        {
          storeID: this.storeID,
          context,
          request,
          definition,
          digest,
          expiresAt,
        },
      );
    });
  }
  private txOptions(
    context: GraphOwnerContext,
    cut: GraphJournalProjection,
    request: TransactionEnvelope,
  ): PureTransactionOptions {
    const histories: PureRevisionState[] = [],
      payloads: Uint8Array[] = [];
    for (const raw of request.value.commands as readonly JSONObject[]) {
      if (raw.op === 'restore_nodes')
        histories.push(
          pure(
            this.readSnapshot(
              context,
              cut,
              request.value.graph_id as string,
              raw.revision as string,
            ),
          ),
        );
      const payload = raw.payload;
      if (
        payload !== undefined &&
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        Object.hasOwn(payload, 'blob')
      )
        payloads.push(
          this.payload(
            context,
            cut,
            request.value.graph_id as string,
            (payload as JSONObject).blob,
          ),
        );
    }
    return {
      limits: this.#limits,
      ...this.#validation,
      ...(histories.length === 0 ? {} : { history: histories }),
      ...(payloads.length === 0 ? {} : { payloads }),
    };
  }
  private txAdmission(
    context: GraphOwnerContext,
    prepared: PurePreparedTransaction,
    operation: string,
    approval?: GraphApproval,
  ): GraphAdmission {
    if (
      (prepared.rootOperations || prepared.protection.roots_changed) &&
      !context.host_permissions.includes('graph.roots')
    )
      throw new GraphError('permission_denied', 'Independent Host graph.roots permission required');
    return this.request(
      context,
      new RevisionState(prepared.base.definition, prepared.base.revision, prepared.base.tombstones),
      prepared.base.definition.graph_id,
      operation,
      {
        operations: Object.freeze(
          (prepared.envelope.value.commands as readonly JSONObject[]).map(
            (command) => command.op as string,
          ),
        ),
        candidate_digest: prepared.candidate.definitionDigest,
        impact: prepared.protection.impact,
        reference_targets: prepared.protection.reference_targets,
        approval_subject_digest: prepared.approvalSubjectDigest,
        approval,
      },
    );
  }
  preview(value: unknown, options: { expiresAt: string }): GraphPreview {
    return this.operate((context, cut) => {
      const request = TransactionEnvelope.fromJSON(
          value instanceof TransactionEnvelope ? value.value : value,
          this.#limits,
        ),
        graphID = request.value.graph_id as string;
      const base = this.readSnapshot(context, cut, graphID);
      const prepared = prepare(pure(base), request, this.txOptions(context, cut, request));
      const now = utc(this.#clock()),
        expiresAt = utc(options.expiresAt);
      if (compareUTC(expiresAt, now) <= 0)
        throw new GraphError('approval_stale', 'Preview expiry must be in the future');
      const proof = this.approval(
        context,
        request.value.approval_ref,
        prepared.approvalSubjectDigest,
        now,
      );
      this.decide(this.txAdmission(context, prepared, 'graph.preview', proof));
      this.check(context, cut.watermark);
      if (compareUTC(expiresAt, this.#clock()) <= 0)
        throw new GraphError('approval_stale', 'Preview expired during admission');
      const receipt = object({
        schema: 'contexture.preview-receipt/v1',
        base_revision: base.revision,
        base_digest: base.definitionDigest,
        candidate_digest: prepared.candidate.definitionDigest,
        command_digest: request.commandDigest,
        resolved_fact_digest: prepared.factsDigest,
        definition_diff: definitionDiff(base.definition, prepared.candidate).asJSON(),
        impact: prepared.protection.impact,
        validation_report: [],
        approval_subject: prepared.approvalSubject,
        expires_at: expiresAt,
      });
      return new GraphPreview(previewToken, receipt, {
        storeID: this.storeID,
        context,
        request: request.value,
        prepared,
        digest: request.commandDigest,
        expiresAt,
      });
    });
  }
  private persist(
    context: GraphOwnerContext,
    cut: GraphJournalProjection,
    event: JSONObject,
    request: JSONObject,
    digest: string,
    revision: string,
    proof?: GraphApproval,
    expiresAt?: string,
  ): JSONObject {
    const resultDigest =
      event.after_digest ?? cut.history(request.graph_id as string).head.definitionDigest;
    const receipt = object({
      schema: 'contexture.command-receipt/v1',
      graph_id: request.graph_id,
      actor_ref: context.actor_ref,
      idempotency_key: request.idempotency_key,
      request_digest: digest,
      revision,
      journal_seq: String(parseCounter(cut.watermark) + 1n),
      status: event.type === 'CommandCompleted' ? 'noop' : 'committed',
      durability: this.#journal.durability,
      operation_result: {
        inline: { graph_id: request.graph_id, revision, definition_digest: resultDigest },
      },
    });
    this.check(context, cut.watermark);
    const now = utc(this.#clock());
    if (proof !== undefined && compareUTC(proof.expires_at, now) <= 0)
      throw new GraphError('approval_stale', 'Approval expired before append');
    if (expiresAt !== undefined && compareUTC(expiresAt, now) <= 0)
      throw new GraphError('approval_stale', 'Preview expired before append');
    this.check(context, cut.watermark);
    try {
      const accepted = this.#journal.append([event], {
        actor_ref: context.actor_ref,
        command_receipt: receipt,
        correlation_id: request.correlation_id as string,
        written_at: now,
      });
      if (accepted.journal_seq !== receipt.journal_seq) throw new CommitUnknown();
      const after = this.replay();
      if (after.watermark !== receipt.journal_seq) throw new CommitUnknown();
      return receipt;
    } catch (error) {
      this.#stopped = true;
      throw error;
    }
  }
  commit(preview: GraphPreview, options: { approvalRef?: string } = {}): JSONObject {
    return this.operate((context, cut) => {
      const issued = previewValues.get(preview);
      if (issued === undefined || issued.storeID !== this.storeID)
        throw new GraphError('schema_invalid', 'Same-store owner-issued preview required');
      const graphID = issued.request.graph_id as string;
      const request =
        issued.prepared === undefined
          ? issued.request
          : TransactionEnvelope.fromJSON(issued.request, this.#limits).value;
      const prior = this.prior(
        context,
        cut,
        graphID,
        request.idempotency_key as string,
        issued.digest,
      );
      if (prior !== undefined) return prior;
      if (!equalJSON(issued.context, context) || compareUTC(issued.expiresAt, this.#clock()) <= 0)
        throw new GraphError(
          'approval_stale',
          'Preview context or expiry changed; re-preview required',
        );
      if (issued.prepared === undefined) {
        const fresh = this.bootstrap(request, context, cut);
        if (
          cut.histories[graphID] !== undefined ||
          fresh.digest !== issued.digest ||
          fresh.definition.definitionDigest !== issued.definition?.definitionDigest
        )
          throw new GraphError(
            'revision_conflict',
            'Bootstrap preview no longer matches unseeded graph',
          );
        const proof = this.approval(
          context,
          request.approval_ref,
          fresh.digest,
          utc(this.#clock()),
        );
        if (proof === undefined)
          throw new GraphError('approval_stale', 'Bootstrap requires exact approval');
        this.decide(
          this.request(context, undefined, graphID, 'graph.bootstrap', {
            operations: Object.freeze(['bootstrap']),
            candidate_digest: fresh.definition.definitionDigest,
            impact: Object.freeze(Object.keys(fresh.definition.nodes).sort(scalarOrder)),
            approval_subject_digest: fresh.digest,
            approval: proof,
          }),
        );
        return this.persist(
          context,
          cut,
          bootstrapEvent(new UnseededState(graphID), fresh.definition, {
            commandDigest: fresh.digest,
            reason: request.reason as string,
            approvalRef: request.approval_ref as string,
          }),
          request,
          fresh.digest,
          '1',
          proof,
          issued.expiresAt,
        );
      }
      const state = this.readSnapshot(context, cut, graphID);
      const fresh = recheckPrepared(
        pure(state),
        issued.prepared,
        this.txOptions(context, cut, TransactionEnvelope.fromJSON(request, this.#limits)),
      );
      const proof = this.approval(
        context,
        options.approvalRef ?? request.approval_ref,
        fresh.approvalSubjectDigest,
        utc(this.#clock()),
      );
      this.decide(this.txAdmission(context, fresh, 'graph.transition', proof));
      const change = resolveFacts(state, fresh.candidate);
      if (!equalJSON(change.facts, fresh.facts) || !equalJSON(change.tombstones, fresh.tombstones))
        throw new GraphError(
          'unsupported_contract',
          'Transaction and event kernels disagree on accepted facts',
        );
      return this.persist(
        context,
        cut,
        changeEvent(state, change, {
          commandDigest: fresh.envelope.commandDigest,
          reason: request.reason as string,
        }),
        request,
        fresh.envelope.commandDigest,
        fresh.resultRevision,
        proof,
        issued.expiresAt,
      );
    });
  }
  recover(journal: FileJournal): void {
    if (!(journal instanceof FileJournal))
      throw new GraphError('schema_invalid', 'Native FileJournal recovery custody required');
    if (this.#busy || this.#closed)
      throw new GraphError('resource_busy', 'Cannot rebind active/closed graph owner');
    this.#busy = true;
    let open = true,
      entered = false;
    try {
      synchronous(
        this.#serialization.run(() => {
          if (!open || entered)
            throw new GraphError('permission_denied', 'Recovery serialization capability closed');
          entered = true;
          journal.assertWritable();
          const projection = new GraphJournalProjection(journal.records(), this.#validation);
          if (
            journal.meta.store_id !== this.storeID ||
            parseCounter(projection.watermark) < parseCounter(this.#confirmedSequence) ||
            (this.#confirmedSequence !== '0' &&
              projection.records[Number(parseCounter(this.#confirmedSequence)) - 1]?.record_hash !==
                this.#confirmedHash) ||
            (bindings.has(journal) && bindings.get(journal) !== this)
          )
            throw new GraphError(
              'contract_mismatch',
              'Recovered graph store origin/prefix/ownership differs',
            );
          if (bindings.get(this.#journal) === this) bindings.delete(this.#journal);
          this.#journal = journal;
          bindings.set(journal, this);
          this.#confirmedProjection = projection;
          this.#confirmedSequence = projection.watermark;
          this.#confirmedHash = projection.lastRecordHash;
          this.#stopped = false;
        }),
      );
      if (!entered)
        throw new GraphError('permission_denied', 'Recovery serialization did not dispatch');
    } finally {
      open = false;
      this.#busy = false;
    }
  }

  releaseGraphProjector(): ReleaseGraphProjector {
    const validation = this.#validation;
    return (records) => {
      const checkpoint = projectGraphJournal(records, validation);
      return {
        graphs: checkpoint.graphs!,
        projection_versions: checkpoint.projection_versions!,
        blob_refs: checkpoint.blob_refs!,
      };
    };
  }
  releaseHistoryReader(): ReleaseHistoryReader {
    return Object.freeze({
      read: (graphID: string, revision: string, view: JournalHistoryView) => {
        this.ready();
        const accepted = this.replay();
        if (
          view.storeID !== this.storeID ||
          view.watermark !== String(view.records.length) ||
          view.records.length > accepted.records.length ||
          view.records.some((record, i) => record.record_hash !== accepted.records[i]?.record_hash)
        )
          throw new GraphError(
            'contract_mismatch',
            'Release history is not an accepted same-store prefix',
          );
        const projection = new GraphJournalProjection(view.records, this.#validation),
          history = projection.history(graphID);
        const snapshot = history.at(revision);
        const record = [...history.records]
          .reverse()
          .find((item) => item.state.revision === revision)!;
        return Object.freeze({
          snapshot,
          storeID: this.storeID,
          journalSeq: record.journalSeq,
          recordHash: view.records[Number(parseCounter(record.journalSeq)) - 1]!
            .record_hash as string,
        });
      },
    });
  }
  private releaseAdmission(
    value: ReleaseHostAdmission,
    context: GraphOwnerContext,
    cut: GraphJournalProjection,
    proof?: GraphApproval,
  ): GraphAdmission {
    if (!equalJSON(value.context, { actor_ref: context.actor_ref, identity: context.identity }))
      throw new GraphError('approval_stale', 'Release context differs from current graph Host');
    const history = cut.history(value.request.graphID);
    const state = 'history' in value ? history.at(value.request.revision) : history.head;
    if (
      'history' in value &&
      (value.history.storeID !== this.storeID ||
        value.history.snapshot.definitionDigest !== state.definitionDigest ||
        value.history.snapshot.revision !== state.revision ||
        cut.records.find((record) => record.journal_seq === value.history.journalSeq)
          ?.record_hash !== value.history.recordHash)
    )
      throw new GraphError('contract_mismatch', 'Release admission historical proof differs');
    return this.request(context, state, value.request.graphID, value.operation, {
      operations: Object.freeze([value.operation]),
      candidate_digest: value.request.manifestDigest,
      approval_subject_digest: value.requestDigest,
      approval: proof,
      release: value,
    });
  }
  releaseHost(): ReleaseHostPort {
    return Object.freeze({
      current: (): ReleaseHostContext => {
        const ctx = this.identity();
        return Object.freeze({ actor_ref: ctx.actor_ref, identity: ctx.identity });
      },
      verifyApproval: (value: ReleaseHostAdmission) => {
        const ctx = this.identity(),
          cut = this.replay();
        this.releaseAdmission(value, ctx, cut);
        return value.compilation.kind === 'receipt_read'
          ? undefined
          : this.approval(ctx, value.request.approvalRef, value.requestDigest, utc(this.#clock()));
      },
      admit: (value: ReleaseHostAdmission, raw: unknown) => {
        const ctx = this.identity(),
          cut = this.replay();
        const proof = raw === undefined ? undefined : (object(raw) as unknown as GraphApproval);
        this.decide(this.releaseAdmission(value, ctx, cut, proof));
      },
      fence: <T>(value: ReleaseHostAdmission, raw: unknown, action: () => T): T =>
        this.operate((ctx, cut) => {
          const proof = raw === undefined ? undefined : (object(raw) as unknown as GraphApproval);
          if (
            proof !== undefined &&
            (proof.subject_digest !== value.requestDigest ||
              proof.actor_id !== ctx.identity.actor_id ||
              proof.tenant_id !== ctx.identity.tenant_id ||
              proof.authority_revision !== ctx.identity.authority_revision ||
              compareUTC(proof.expires_at, this.#clock()) <= 0)
          )
            throw new GraphError(
              'approval_stale',
              'Release approval expired at shared graph fence',
            );
          this.decide(this.releaseAdmission(value, ctx, cut, proof));
          this.check(ctx, cut.watermark);
          return synchronous(action());
        }, true),
    });
  }
  definitionReads(): DefinitionReadPort {
    return Object.freeze({
      read: async <T>(
        request: DefinitionReadRequest,
        dispatch: (view: DefinitionReadView) => T,
      ): Promise<T> =>
        this.operate((ctx, cut) => {
          const history = cut.history(request.graph_id);
          if (
            !['head', 'revision'].includes(request.source) ||
            (request.source === 'revision') !== (request.revision !== undefined)
          )
            throw new GraphError('schema_invalid', 'Explicit definition source/revision required');
          const snapshot = request.source === 'head' ? history.head : history.at(request.revision!);
          const scope = this.decide(
            this.request(ctx, history.head, request.graph_id, 'graph.catalog', {
              impact: Object.freeze([]),
            }),
            true,
          );
          this.check(ctx, cut.watermark);
          return synchronous(
            dispatch(
              Object.freeze({
                identity: ctx.identity,
                store_origin: this.storeID,
                index: GraphIndex.build(snapshot.definition, this.#validation.publicationContracts),
                current_index: GraphIndex.build(
                  history.head.definition,
                  this.#validation.publicationContracts,
                ),
                revision: snapshot.revision,
                scope_ids: scope,
              }),
            ),
          );
        }),
    });
  }
  committedReads(): CommittedBatchReadPort {
    return Object.freeze({
      read: <T>(graphID: string, dispatch: (cut: CommittedReadCut) => T): T =>
        this.operate((ctx, cut) => {
          const history = cut.history(graphID);
          const scope = this.decide(
            this.request(ctx, history.head, graphID, 'graph.watch', { impact: Object.freeze([]) }),
            true,
          );
          this.check(ctx, cut.watermark);
          let open = true;
          try {
            return synchronous(
              dispatch(
                Object.freeze({
                  identity: ctx.identity,
                  store_origin: this.storeID,
                  scope_ids: scope,
                  snapshot: history.head,
                  watermark: cut.watermark,
                  retained_after: history.records[0]!.journalSeq,
                  readBatches: (
                    after: string,
                    bounds: Readonly<{ max_batches: number; max_bytes: number }>,
                  ): CommittedBatchWindow => {
                    if (!open)
                      throw new GraphError(
                        'permission_denied',
                        'Committed read cut escaped its fence',
                      );
                    const position = parseCounter(after);
                    if (
                      position > parseCounter(cut.watermark) ||
                      position < parseCounter(history.records[0]!.journalSeq)
                    )
                      throw new GraphError(
                        'history_unavailable',
                        'Committed checkpoint is outside exact history',
                      );
                    if (
                      ![bounds.max_batches, bounds.max_bytes].every(
                        (n) => Number.isSafeInteger(n) && n > 0,
                      )
                    )
                      throw new GraphError(
                        'schema_invalid',
                        'Positive committed window bounds required',
                      );
                    const before = [...history.records]
                      .reverse()
                      .find((record) => parseCounter(record.journalSeq) <= position)!.state;
                    const pending = history.records.filter(
                      (record) => parseCounter(record.journalSeq) > position,
                    );
                    const overflow =
                      pending.length > bounds.max_batches ||
                      pending.reduce(
                        (total, record) =>
                          total +
                          canonicalJSON(cut.records[Number(parseCounter(record.journalSeq)) - 1])
                            .length,
                        0,
                      ) > bounds.max_bytes;
                    return Object.freeze({
                      before,
                      batches: Object.freeze(
                        overflow
                          ? []
                          : pending.map((record) =>
                              Object.freeze({ position: record.journalSeq, state: record.state }),
                            ),
                      ),
                      through: cut.watermark,
                      overflow,
                    });
                  },
                }),
              ),
            );
          } finally {
            open = false;
          }
        }),
    });
  }
}
