/** Local bounded projection bytes/handles, never a graph owner or Journal. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJSON, freezeJSON, GraphError, validateID } from '../core/graph/canonical.js';
import type { FrozenJSON } from '../core/graph/canonical.js';
import type { ManagedIdentity } from '../core/graph/bindings.js';
import type { CatalogKind } from '../core/graph/catalog.js';
import type { JSONObject } from '../core/graph/model.js';
import { MaterialBudget, sliceItems } from '../core/graph/paging.js';

export function resync(): never {
  throw new GraphError('resync_required', 'Native read view unavailable; resync required');
}
export function encode(value: unknown): string {
  return Buffer.from(canonicalJSON(value)).toString('utf8');
}
export function jsonObject(raw: string): JSONObject {
  const value: unknown = JSON.parse(raw);
  return freezeJSON(value) as JSONObject;
}
export function same(left: unknown, right: unknown): boolean {
  return encode(left) === encode(right);
}
export function identity(value: ManagedIdentity): ManagedIdentity {
  return Object.freeze({
    actor_id: validateID(value.actor_id),
    tenant_id: validateID(value.tenant_id),
    authority_revision: validateID(value.authority_revision),
  });
}
export function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Positive bound required');
  return value;
}

/** Explicit Host-owned key. Handles reveal no coordinates, scope or offsets. */
export class CursorSigner {
  #key!: Buffer;
  #version!: string;
  constructor(key: Uint8Array) {
    this.rotate(key);
  }
  get version(): string {
    return this.#version;
  }
  rotate(key: Uint8Array): void {
    if (!(key instanceof Uint8Array) || key.length < 32)
      throw new RangeError('Explicit Host-owned cursor key of at least 32 bytes required');
    this.#key = Buffer.from(key);
    this.#version = randomBytes(32).toString('hex');
  }
  issue(subject?: string): string {
    const handle =
      subject === undefined
        ? randomBytes(32).toString('hex')
        : createHmac('sha256', this.#key).update(subject).digest('hex');
    const mac = createHmac('sha256', this.#key)
      .update('native-paging-v1\0' + handle)
      .digest('hex');
    return handle + '.' + mac;
  }
  valid(token: unknown): token is string {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}\.[0-9a-f]{64}$/u.test(token)) return false;
    const expected = createHmac('sha256', this.#key)
      .update('native-paging-v1\0' + token.slice(0, 64))
      .digest();
    return timingSafeEqual(expected, Buffer.from(token.slice(65), 'hex'));
  }
}

export class PageProfile {
  readonly limit: number;
  readonly kinds: readonly CatalogKind[];
  readonly name: string;
  constructor(options: { limit?: number; kinds?: readonly CatalogKind[]; name?: string } = {}) {
    this.limit = options.limit ?? 200;
    const kinds = options.kinds ?? ['role', 'skill', 'tool'];
    this.name = options.name ?? 'native-route-v1';
    if (
      !Number.isSafeInteger(this.limit) ||
      this.limit < 1 ||
      this.limit > 1000 ||
      !Array.isArray(kinds) ||
      kinds.some((kind) => !['role', 'skill', 'tool'].includes(kind)) ||
      typeof this.name !== 'string' ||
      !this.name.length ||
      this.name.length > 128
    )
      throw new GraphError('schema_invalid', 'Invalid native page profile');
    this.kinds = Object.freeze([...new Set(kinds)].sort());
    Object.freeze(this);
  }
  asJSON(): JSONObject {
    return { limit: this.limit, kinds: this.kinds, name: this.name };
  }
}

export interface PageStoreOptions {
  readonly signer: CursorSigner;
  readonly maxSnapshots?: number;
  readonly maxBytes?: number;
  readonly maxItems?: number;
  readonly maxCursors?: number;
  readonly responseBytes?: number;
  readonly maxTTL?: number;
  /** Monotonic milliseconds; custom clocks require sweep(). */
  readonly clock?: () => number;
}

interface Snapshot {
  readonly binding: string;
  readonly envelope: string;
  readonly streams: ReadonlyMap<string, readonly string[]>;
  readonly profile: PageProfile;
  readonly relationPages?: boolean;
  readonly expires: number;
  readonly version: string;
  readonly size: number;
  readonly authorize: (dispatch: () => JSONObject) => Promise<JSONObject>;
  readonly dispose: () => void;
  readonly cursors: Map<string, string>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface SnapshotInput {
  readonly binding: unknown;
  readonly envelope: JSONObject;
  readonly streams: Readonly<Record<string, readonly JSONObject[]>>;
  readonly profile: PageProfile;
  readonly relationPages?: boolean;
  readonly expires: number;
  readonly version: string;
  readonly authorize: Snapshot['authorize'];
  readonly dispose: () => void;
}

/** Every continuation dispatches synchronously inside a CURRENT authority fence. */
export class SnapshotPages {
  readonly #options: Required<Omit<PageStoreOptions, 'clock'>> & { clock: () => number };
  readonly #automatic: boolean;
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #tokens = new Map<string, { sid: string; stream: string; offset: number }>();
  #bytes = 0;
  #pending = 0;
  #closed = false;
  constructor(options: PageStoreOptions) {
    if (!(options.signer instanceof CursorSigner)) throw new TypeError('CursorSigner required');
    this.#options = {
      signer: options.signer,
      maxSnapshots: positive(options.maxSnapshots ?? 64),
      maxBytes: positive(options.maxBytes ?? 16 * 1024 * 1024),
      maxItems: positive(options.maxItems ?? 10000),
      maxCursors: positive(options.maxCursors ?? 20000),
      responseBytes: positive(options.responseBytes ?? 8 * 1024 * 1024),
      maxTTL: positive(options.maxTTL ?? 60000),
      clock: options.clock ?? (() => performance.now()),
    };
    if (this.#options.maxTTL > 3600000) throw new RangeError('Bounded TTL required');
    this.#automatic = options.clock === undefined;
  }
  get counts(): Readonly<{ snapshots: number; pending: number; bytes: number; cursors: number }> {
    return {
      snapshots: this.#snapshots.size,
      pending: this.#pending,
      bytes: this.#bytes,
      cursors: this.#tokens.size,
    };
  }
  get requiresExplicitSweep(): boolean {
    return !this.#automatic;
  }
  materialBudget(): MaterialBudget {
    return new MaterialBudget(this.#options.maxItems, this.#options.maxBytes);
  }
  begin(ttl: number): { expires: number; version: string; finish(): void } {
    this.sweep();
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > this.#options.maxTTL)
      throw new GraphError('schema_invalid', 'Invalid native read TTL');
    if (this.#closed) resync();
    if (this.#snapshots.size + this.#pending >= this.#options.maxSnapshots)
      throw new GraphError('resource_busy', 'Native snapshot capacity unavailable');
    this.#pending++;
    let finished = false;
    return {
      expires: this.#options.clock() + ttl,
      version: this.#options.signer.version,
      finish: () => {
        if (!finished) this.#pending--;
        finished = true;
      },
    };
  }
  private alive(s: Pick<Snapshot, 'expires' | 'version'>): void {
    if (
      this.#closed ||
      this.#options.clock() >= s.expires ||
      s.version !== this.#options.signer.version
    )
      resync();
  }
  private drop(sid: string): void {
    const s = this.#snapshots.get(sid);
    if (s === undefined) return;
    this.#snapshots.delete(sid);
    for (const token of s.cursors.values()) this.#tokens.delete(token);
    this.#bytes -= s.size;
    if (s.timer !== undefined) clearTimeout(s.timer);
    s.dispose();
  }
  sweep(): number {
    let removed = 0;
    for (const [sid, s] of this.#snapshots)
      if (
        this.#closed ||
        this.#options.clock() >= s.expires ||
        s.version !== this.#options.signer.version
      ) {
        this.drop(sid);
        removed++;
      }
    return removed;
  }
  shutdown(): void {
    this.#closed = true;
    this.sweep();
  }
  private arm(sid: string, s: Snapshot): void {
    if (!this.#automatic) return;
    s.timer = setTimeout(
      () => {
        if (this.#snapshots.get(sid) !== s) return;
        this.sweep();
        if (this.#snapshots.has(sid)) this.arm(sid, s);
      },
      Math.max(1, s.expires - this.#options.clock()),
    );
    s.timer.unref();
  }
  private cursor(sid: string, s: Snapshot, stream: string, offset: number): string {
    const key = encode([stream, offset]);
    let token = s.cursors.get(key);
    if (token === undefined) {
      if (this.#tokens.size >= this.#options.maxCursors)
        throw new GraphError('resource_busy', 'Native cursor capacity unavailable');
      token = this.#options.signer.issue();
      s.cursors.set(key, token);
      this.#tokens.set(token, { sid, stream, offset });
    }
    return token;
  }
  create(input: SnapshotInput): JSONObject {
    this.alive(input);
    const streams = new Map<string, readonly string[]>();
    let size = Buffer.byteLength(encode(input.envelope));
    let count = 0;
    for (const [name, items] of Object.entries(input.streams)) {
      const values = items.map((item) => {
        const raw = encode(item);
        size += Buffer.byteLength(raw);
        count++;
        if (size > this.#options.maxBytes || count > this.#options.maxItems)
          throw new GraphError('too_large', 'Native projection exceeds material budget');
        return raw;
      });
      streams.set(name, values);
    }
    if (size > this.#options.maxBytes)
      throw new GraphError('too_large', 'Native projection envelope exceeds material budget');
    if (this.#bytes + size > this.#options.maxBytes)
      throw new GraphError('resource_busy', 'Native retained material capacity unavailable');
    const sid = randomBytes(32).toString('hex');
    const s: Snapshot = {
      ...input,
      binding: encode(input.binding),
      envelope: encode(input.envelope),
      streams,
      size,
      cursors: new Map(),
    };
    // Preflight every atomic item, including items beyond the first page.
    for (const [stream, items] of streams)
      for (const raw of items)
        this.fits(
          input.relationPages === true
            ? {
                ...input.envelope,
                snapshot: sid,
                [stream + '_page']: {
                  items: [jsonObject(raw)],
                  complete: false,
                  next_cursor: 'x'.repeat(129),
                },
              }
            : {
                ...input.envelope,
                snapshot: sid,
                stream,
                items: [jsonObject(raw)],
                complete: false,
                next_cursor: 'x'.repeat(129),
              },
        );
    this.#snapshots.set(sid, s);
    this.#bytes += size;
    try {
      const result =
        input.relationPages === true
          ? this.relations(
              sid,
              s,
              [...streams.keys()].map((name) => [name, 0]),
            )
          : {
              ...input.envelope,
              snapshot: sid,
              streams: Object.fromEntries(
                [...streams.keys()].map((n) => [n, this.cursor(sid, s, n, 0)]),
              ),
            };
      this.fits(result);
      this.alive(s);
      this.arm(sid, s);
      return result;
    } catch (error) {
      this.drop(sid);
      throw error;
    }
  }
  private fits(value: unknown): void {
    if (Buffer.byteLength(encode(value)) > this.#options.responseBytes)
      throw new GraphError('too_large', 'Native read response exceeds byte budget');
  }
  private relations(
    sid: string,
    s: Snapshot,
    offsets: readonly (readonly [string, number])[],
  ): JSONObject {
    const result: Record<string, FrozenJSON> = {
      ...jsonObject(s.envelope),
      snapshot: sid,
    };
    const shell = Object.fromEntries(
      offsets.map(([name]) => [
        name + '_page',
        { items: [], complete: false, next_cursor: 'x'.repeat(129) },
      ]),
    );
    let remaining =
      this.#options.responseBytes - Buffer.byteLength(encode({ ...result, ...shell }));
    const minimums = offsets.map(([name, offset]) => {
      const first = s.streams.get(name)![offset];
      return first === undefined ? 0 : Buffer.byteLength(first);
    });
    remaining -= minimums.reduce((sum, size) => sum + size, 0);
    if (remaining < 0) throw new GraphError('too_large', 'Atomic native open exceeds byte budget');
    for (let i = 0; i < offsets.length; i++) {
      const [name, offset] = offsets[i]!;
      const page = sliceItems(
        s.streams.get(name)!,
        offset,
        s.profile.limit,
        2 + minimums[i]! + remaining,
      );
      const consumed = Buffer.byteLength('[' + page.items.join(',') + ']') - 2;
      remaining -= consumed - minimums[i]!;
      result[name + '_page'] = {
        items: page.items.map(jsonObject),
        complete: page.nextOffset === null,
        ...(page.nextOffset === null
          ? {}
          : { next_cursor: this.cursor(sid, s, name, page.nextOffset) }),
      };
    }
    this.fits(result);
    return result;
  }
  async page(token: string, stream: string, binding: unknown): Promise<JSONObject> {
    this.sweep();
    if (!this.#options.signer.valid(token)) resync();
    const entry = this.#tokens.get(token);
    if (entry === undefined) resync();
    const s = this.#snapshots.get(entry.sid);
    if (s === undefined) resync();
    try {
      if (stream !== entry.stream || encode(binding) !== s.binding) resync();
      return await s.authorize(() => {
        this.alive(s);
        if (this.#snapshots.get(entry.sid) !== s) resync();
        if (s.relationPages === true) return this.relations(entry.sid, s, [[stream, entry.offset]]);
        const envelope = { ...jsonObject(s.envelope), snapshot: entry.sid, stream };
        const shell = { ...envelope, items: [], complete: false, next_cursor: 'x'.repeat(129) };
        const budget = this.#options.responseBytes - Buffer.byteLength(encode(shell)) + 2;
        if (budget < 2) throw new GraphError('too_large', 'Native page envelope too large');
        const page = sliceItems(s.streams.get(stream)!, entry.offset, s.profile.limit, budget);
        const result = {
          ...envelope,
          items: page.items.map(jsonObject),
          complete: page.nextOffset === null,
          ...(page.nextOffset === null
            ? {}
            : { next_cursor: this.cursor(entry.sid, s, stream, page.nextOffset) }),
        };
        this.fits(result);
        this.alive(s);
        return result;
      });
    } catch (error) {
      this.drop(entry.sid);
      if (
        error instanceof GraphError &&
        (error.code === 'permission_denied' || error.code === 'not_ready')
      )
        resync();
      throw error;
    }
  }
}
