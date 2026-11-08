/** Native definition-metadata pull watch over an explicitly trusted committed reader. */
import { randomBytes } from 'node:crypto';
import { canonicalDigest, GraphError, parseCounter, validateID } from '../core/graph/canonical.js';
import type { ManagedIdentity } from '../core/graph/bindings.js';
import { RevisionState, scalarOrder } from '../core/graph/events.js';
import type { JSONObject } from '../core/graph/model.js';
import { origin, selection } from './managed-read-authority.js';
import {
  CursorSigner,
  encode,
  identity,
  jsonObject,
  positive,
  resync,
  same,
} from './managed-read-state.js';

export interface CommittedDefinitionBatch {
  /** Private durable position. Never returned to the untrusted consumer. */
  readonly position: string;
  /** Final state AFTER ALL same-graph facts in one committed durable record. */
  readonly state: RevisionState;
}
export interface CommittedBatchWindow {
  /** Exact retained state at/before the requested checkpoint, not today's head. */
  readonly before: RevisionState;
  readonly batches: readonly CommittedDefinitionBatch[];
  /** Last fully examined durable position, including filtered/unrelated records. */
  readonly through: string;
  /** True when pending durable batches/bytes exceed requested backlog bounds. */
  readonly overflow: boolean;
}
export interface CommittedReadCut {
  readonly identity: ManagedIdentity;
  readonly store_origin: string;
  /** Fresh graph.watch admission scope, including authorized stable IDs. */
  readonly scope_ids: readonly string[];
  readonly snapshot: RevisionState;
  readonly watermark: string;
  /** Checkpoints below this durable position cannot be reconstructed. */
  readonly retained_after: string;
  readBatches(
    after: string,
    bounds: Readonly<{ max_batches: number; max_bytes: number }>,
  ): CommittedBatchWindow;
}
export interface CommittedBatchReadPort {
  /**
   * Synchronous owner-serialized durable read fence, exactly one dispatch.
   * snapshot + watermark + retention + readBatches come from ONE verified cut.
   * Never attest uncommitted graph head or synthesize missing Journal history.
   * Throw history_unavailable for retention/blob gaps; propagate corruption.
   */
  read<T>(graphID: string, dispatch: (cut: CommittedReadCut) => T): T;
}

export class WatchProfile {
  readonly maxBatches: number;
  readonly maxBytes: number;
  readonly inlineBytes: number;
  readonly maxMilliseconds: number;
  readonly name: string;
  constructor(
    options: {
      maxBatches?: number;
      maxBytes?: number;
      inlineBytes?: number;
      maxMilliseconds?: number;
      name?: string;
    } = {},
  ) {
    this.maxBatches = positive(options.maxBatches ?? 64);
    this.maxBytes = positive(options.maxBytes ?? 1024 * 1024);
    this.inlineBytes = positive(options.inlineBytes ?? Math.min(this.maxBytes, 256 * 1024));
    this.maxMilliseconds = positive(options.maxMilliseconds ?? 1000);
    this.name = options.name ?? 'native-definition-metadata-v1';
    if (
      this.maxBatches > 1024 ||
      this.maxBytes > 16 * 1024 * 1024 ||
      this.inlineBytes > Math.min(this.maxBytes, 1024 * 1024) ||
      this.maxMilliseconds > 30000 ||
      typeof this.name !== 'string' ||
      !this.name.length ||
      this.name.length > 128
    )
      throw new GraphError('schema_invalid', 'Invalid bounded native watch profile');
    Object.freeze(this);
  }
  asJSON(): JSONObject {
    return {
      max_batches: this.maxBatches,
      max_bytes: this.maxBytes,
      inline_bytes: this.inlineBytes,
      max_milliseconds: this.maxMilliseconds,
      name: this.name,
    };
  }
}
export interface WatchRequest {
  readonly graph_id: string;
  /** Exact stable-ID attenuation, as in the Python native watch candidate. */
  readonly selection?: readonly string[];
  readonly profile?: WatchProfile;
}
export interface WatchOptions {
  readonly reader: CommittedBatchReadPort;
  readonly signer: CursorSigner;
  readonly clock?: () => number;
  readonly maxSessions?: number;
  readonly maxHandles?: number;
  readonly maxRetainedBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly maxBacklogBatches?: number;
  readonly maxBacklogBytes?: number;
  readonly maxTTL?: number;
}

interface Session {
  readonly id: string;
  readonly graphID: string;
  readonly identity: ManagedIdentity;
  readonly origin: string;
  readonly scope: readonly string[];
  readonly selection: readonly string[] | undefined;
  readonly binding: string;
  readonly profile: WatchProfile;
  readonly expires: number;
  readonly version: string;
  readonly positions: Map<string, string>;
  readonly fetches: Map<string, string>;
  size: number;
}

function payload(
  state: RevisionState,
  scope: readonly string[],
  selected?: readonly string[],
): string {
  const allowed = new Set(scope);
  const selectedIDs = selected === undefined ? undefined : new Set(selected);
  const visible = (id: string): boolean => allowed.has(id) && (selectedIDs?.has(id) ?? true);
  return encode({
    nodes: Object.keys(state.definition.nodes)
      .sort(scalarOrder)
      .filter(visible)
      .map((id) => {
        const n = state.definition.nodes[id]!;
        return { node_id: id, kind: n.kind, name: n.name, description: n.description };
      }),
    roots: state.definition.roots.filter((root) => visible(root.node_id)),
  });
}
function request(value: WatchRequest): string {
  validateID(value.graph_id);
  if (value.profile !== undefined && !(value.profile instanceof WatchProfile))
    throw new GraphError('schema_invalid', 'Invalid native watch profile');
  return encode({
    graph_id: value.graph_id,
    selection: selection(value.selection) ?? null,
    profile: (value.profile ?? new WatchProfile()).asJSON(),
  });
}

export class ManagedWatchService {
  readonly #read: CommittedBatchReadPort['read'];
  readonly #signer: CursorSigner;
  readonly #clock: () => number;
  readonly #limits: Required<Omit<WatchOptions, 'reader' | 'signer' | 'clock'>>;
  readonly #sessions = new Map<string, Session>();
  readonly #handles = new Map<string, { session: Session; fetch: boolean }>();
  #closed = false;
  #busy = false;
  constructor(options: WatchOptions) {
    if (!(options.signer instanceof CursorSigner)) throw new TypeError('CursorSigner required');
    this.#read = options.reader.read.bind(options.reader);
    this.#signer = options.signer;
    this.#clock = options.clock ?? (() => performance.now());
    this.#limits = {
      maxSessions: positive(options.maxSessions ?? 64),
      maxHandles: positive(options.maxHandles ?? 4096),
      maxRetainedBytes: positive(options.maxRetainedBytes ?? 16 * 1024 * 1024),
      maxPayloadBytes: positive(options.maxPayloadBytes ?? 8 * 1024 * 1024),
      maxBacklogBatches: positive(options.maxBacklogBatches ?? 1024),
      maxBacklogBytes: positive(options.maxBacklogBytes ?? 16 * 1024 * 1024),
      maxTTL: positive(options.maxTTL ?? 60000),
    };
    if (this.#limits.maxTTL > 3600000) throw new RangeError('Bounded watch TTL required');
  }
  private drop(s: Session): void {
    this.#sessions.delete(s.id);
    for (const token of s.positions.keys()) this.#handles.delete(token);
    for (const token of s.fetches.keys()) this.#handles.delete(token);
    s.positions.clear();
    s.fetches.clear();
    s.size = 0;
  }
  sweep(): number {
    let removed = 0;
    for (const s of this.#sessions.values())
      if (this.#closed || s.version !== this.#signer.version || this.#clock() >= s.expires) {
        this.drop(s);
        removed++;
      }
    return removed;
  }
  shutdown(): void {
    this.#closed = true;
    this.sweep();
  }
  private capacity(): void {
    let size = 0;
    for (const s of this.#sessions.values()) size += s.size;
    if (this.#handles.size > this.#limits.maxHandles || size > this.#limits.maxRetainedBytes)
      resync();
  }
  private cursor(s: Session, position: string): string {
    const token = this.#signer.issue(encode([s.id, 'cursor', position]));
    s.positions.set(token, position);
    this.#handles.set(token, { session: s, fetch: false });
    this.capacity();
    return token;
  }
  private cut(view: CommittedReadCut, graphID: string): void {
    identity(view.identity);
    origin(view.store_origin);
    if (
      !(view.snapshot instanceof RevisionState) ||
      view.snapshot.definition.graph_id !== graphID ||
      !Array.isArray(view.scope_ids) ||
      view.scope_ids.some((id) => typeof id !== 'string') ||
      parseCounter(view.retained_after) > parseCounter(view.watermark)
    )
      throw new GraphError('contract_mismatch', 'Trusted committed read cut differs');
  }
  private fresh(s: Session, view: CommittedReadCut): void {
    this.cut(view, s.graphID);
    if (
      this.#closed ||
      this.#sessions.get(s.id) !== s ||
      this.#clock() >= s.expires ||
      s.version !== this.#signer.version ||
      !same(s.identity, identity(view.identity)) ||
      s.origin !== view.store_origin ||
      !same(s.scope, [...new Set(view.scope_ids)].sort())
    )
      resync();
    for (const position of s.positions.values())
      if (parseCounter(position) < parseCounter(view.retained_after))
        throw new GraphError('history_unavailable', 'Watch checkpoint history unavailable');
  }
  private deadline(s: Session, deadline: number): void {
    if (this.#clock() >= Math.min(deadline, s.expires)) resync();
  }
  private bounded(raw: string): void {
    if (Buffer.byteLength(raw) > this.#limits.maxPayloadBytes)
      throw new GraphError('too_large', 'Complete authorized watch payload exceeds receive limit');
  }
  private find(token: string, value: WatchRequest, fetch: boolean): Session {
    this.sweep();
    if (!this.#signer.valid(token)) resync();
    const found = this.#handles.get(token);
    if (found === undefined) resync();
    const s = found.session;
    if (found.fetch !== fetch || request(value) !== s.binding) {
      this.drop(s);
      resync();
    }
    return s;
  }
  private exclusive<T>(dispatch: () => T): T {
    if (this.#busy) throw new GraphError('resource_busy', 'Reentrant watch read refused');
    this.#busy = true;
    try {
      return dispatch();
    } finally {
      this.#busy = false;
    }
  }
  start(value: WatchRequest, ttl = 30000): JSONObject {
    return this.exclusive(() => {
      const binding = request(value);
      const profile = value.profile ?? new WatchProfile();
      const selected = selection(value.selection);
      this.sweep();
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > this.#limits.maxTTL)
        throw new GraphError('schema_invalid', 'Invalid native watch TTL');
      if (this.#closed || this.#sessions.size >= this.#limits.maxSessions) resync();
      const began = this.#clock();
      return this.#read(value.graph_id, (cut) => {
        this.cut(cut, value.graph_id);
        const s: Session = {
          id: randomBytes(32).toString('hex'),
          graphID: value.graph_id,
          identity: identity(cut.identity),
          origin: cut.store_origin,
          scope: Object.freeze([...new Set(cut.scope_ids)].sort()),
          selection: selected,
          binding,
          profile,
          expires: began + ttl,
          version: this.#signer.version,
          positions: new Map(),
          fetches: new Map(),
          size: 0,
        };
        try {
          const raw = payload(cut.snapshot, s.scope, selected);
          this.bounded(raw);
          this.#sessions.set(s.id, s);
          const result = {
            snapshot: jsonObject(raw),
            view_digest: canonicalDigest(jsonObject(raw), 'contexture.view/v1'),
            cursor: this.cursor(s, cut.watermark),
          };
          if (Buffer.byteLength(encode(result)) > profile.maxBytes)
            throw new GraphError('too_large', 'Complete watch snapshot exceeds response budget');
          this.fresh(s, cut);
          this.deadline(s, began + profile.maxMilliseconds);
          return result;
        } catch (error) {
          this.drop(s);
          throw error;
        }
      });
    });
  }
  poll(token: string, value: WatchRequest): JSONObject {
    return this.exclusive(() => {
      const s = this.find(token, value, false);
      try {
        const deadline = this.#clock() + s.profile.maxMilliseconds;
        return this.#read(s.graphID, (cut) => {
          this.fresh(s, cut);
          let position = s.positions.get(token)!;
          if (parseCounter(position) > parseCounter(cut.watermark)) resync();
          const window = cut.readBatches(position, {
            max_batches: this.#limits.maxBacklogBatches,
            max_bytes: this.#limits.maxBacklogBytes,
          });
          if (
            typeof window.overflow !== 'boolean' ||
            !(window.before instanceof RevisionState) ||
            window.before.definition.graph_id !== s.graphID ||
            !Array.isArray(window.batches) ||
            parseCounter(window.through) < parseCounter(position) ||
            parseCounter(window.through) > parseCounter(cut.watermark)
          )
            throw new GraphError('contract_mismatch', 'Trusted committed window differs');
          if (window.overflow || window.batches.length > this.#limits.maxBacklogBatches) resync();
          let priorPosition = parseCounter(position);
          for (const batch of window.batches) {
            const seq = parseCounter(batch.position);
            if (
              seq <= priorPosition ||
              seq > parseCounter(window.through) ||
              !(batch.state instanceof RevisionState) ||
              batch.state.definition.graph_id !== s.graphID
            )
              throw new GraphError('contract_mismatch', 'Committed batch boundary differs');
            priorPosition = seq;
          }
          let previous = payload(window.before, s.scope, s.selection);
          const batches: JSONObject[] = [];
          let examined = 0;
          for (const batch of window.batches) {
            this.deadline(s, deadline);
            if (examined >= s.profile.maxBatches) break;
            const raw = payload(batch.state, s.scope, s.selection);
            this.bounded(raw);
            if (raw !== previous) {
              const seqcursor = this.#signer.issue(encode([s.id, 'cursor', batch.position]));
              const fetch = this.#signer.issue(encode([s.id, 'fetch', batch.position]));
              const descriptorBase = {
                batch_id: this.#signer.issue(encode([s.id, 'batch', batch.position])),
                facts_digest: canonicalDigest(jsonObject(raw), 'contexture.view/v1'),
                size: Buffer.byteLength(raw),
                seqcursor,
              };
              let descriptor: JSONObject = {
                ...descriptorBase,
                ...(Buffer.byteLength(raw) <= s.profile.inlineBytes
                  ? { payload: jsonObject(raw) }
                  : { authorized_fetch_ref: fetch }),
              };
              const responseSize = (): number =>
                Buffer.byteLength(encode({ batches: [...batches, descriptor], cursor: seqcursor }));
              if (responseSize() > s.profile.maxBytes && 'payload' in descriptor)
                descriptor = { ...descriptorBase, authorized_fetch_ref: fetch };
              if (responseSize() > s.profile.maxBytes) {
                if (!batches.length)
                  throw new GraphError(
                    'too_large',
                    'Atomic watch descriptor exceeds response budget',
                  );
                break;
              }
              this.cursor(s, batch.position);
              if ('authorized_fetch_ref' in descriptor) {
                const retained = s.fetches.get(fetch);
                if (retained !== undefined && retained !== raw)
                  throw new GraphError('contract_mismatch', 'Committed batch was rewritten');
                if (retained === undefined) {
                  s.fetches.set(fetch, raw);
                  s.size += Buffer.byteLength(raw);
                  this.#handles.set(fetch, { session: s, fetch: true });
                  this.capacity();
                }
              }
              batches.push(descriptor);
            }
            position = batch.position;
            previous = raw;
            examined++;
          }
          if (examined === window.batches.length) position = window.through;
          const result = { batches, cursor: this.cursor(s, position) };
          if (Buffer.byteLength(encode(result)) > s.profile.maxBytes) resync();
          this.fresh(s, cut);
          this.deadline(s, deadline);
          return result;
        });
      } catch (error) {
        this.drop(s);
        if (error instanceof GraphError && error.code === 'permission_denied') resync();
        throw error;
      }
    });
  }
  /** Fetch the COMPLETE replacement; persist seqcursor only AFTER applying it. */
  fetch(token: string, value: WatchRequest): JSONObject {
    return this.exclusive(() => {
      const s = this.find(token, value, true);
      try {
        const deadline = this.#clock() + s.profile.maxMilliseconds;
        return this.#read(s.graphID, (cut) => {
          this.fresh(s, cut);
          const result = jsonObject(s.fetches.get(token)!);
          this.deadline(s, deadline);
          return result;
        });
      } catch (error) {
        this.drop(s);
        if (error instanceof GraphError && error.code === 'permission_denied') resync();
        throw error;
      }
    });
  }
}
