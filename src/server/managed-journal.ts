/** Candidate Linux FileJournal adapter. Not a supported-platform certificate.
 * fs-ext 2.1.1 supplies fd-native flock(LOCK_EX|LOCK_NB), never PID leases.
 * The host supplies the local managed schema and an independent full projector.
 * No database, Python bridge, command admission, or graph execution lives here.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import {
  CANONICAL_PROFILE,
  MAX_COUNTER,
  canonicalDigest,
  canonicalJSON,
  decodeJSON,
  parseCounter,
  thawJSON,
  JOURNAL_PAYLOAD_DOMAIN,
  JOURNAL_RECORD_DOMAIN,
  CHECKPOINT_DOMAIN,
  JOURNAL_BACKUP_DOMAIN,
} from '../core/graph/canonical.js';

type Wire = Record<string, unknown>;
export type ProjectionPort = (records: readonly Wire[]) => unknown;
export type Durability = 'strict' | 'process_crash';
export class JournalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}
export class CommitUnknown extends JournalError {
  constructor() {
    super('commit_unknown', 'Publication may have happened; close and recover under lock');
  }
}
const PROJECTIONS = [
  'graphs',
  'desired_releases',
  'release_operations',
  'prepare_attempt_history',
  'observations_history',
  'receipts_index',
  'projection_versions',
  'blob_refs',
] as const;
const HEX = /^[0-9a-f]{64}$/u;
const PAD = /^[0-9]{20}$/u;
const directories = ['records', 'blobs', 'checkpoints', 'hints', 'indexes', 'tmp', 'quarantine'];
function fail(code: string, message: string): never {
  throw new JournalError(code, message);
}
function object(value: unknown): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('schema_invalid', 'Expected object');
  return value as Wire;
}
function copy(value: unknown): Wire {
  return object(thawJSON(value));
}
function equal(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJSON(a)).equals(Buffer.from(canonicalJSON(b)));
}
function bytesDigest(raw: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(raw).digest('hex');
}
function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
function entries(value: unknown): Wire[] {
  if (!Array.isArray(value)) fail('schema_invalid', 'Expected array');
  return value.map(object);
}

/** Injectable primitive boundary; the only supported implementation is LinuxFileOps.
 * Overrides are for deterministic syscall fault tests, not alternate durability claims.
 */
export class LinuxFileOps {
  lock(fd: number): void {
    let native: typeof import('fs-ext');
    try {
      native = createRequire(import.meta.url)('fs-ext') as typeof import('fs-ext');
    } catch {
      fail('durability_unsupported', 'Native fs-ext flock dependency is unavailable');
    }
    native.flockSync(fd, 'exnb');
  }
  write(fd: number, data: Uint8Array): number {
    return fs.writeSync(fd, data);
  }
  sync(fd: number): void {
    fs.fsyncSync(fd);
  }
  publish(source: string, destination: string): void {
    // Same-filesystem link is an atomic no-overwrite publication, unlike rename.
    // Both names briefly share an inode. Recovery removes only matching tmp links
    // under the lifetime lock before enforcing the single-link asset invariant.
    fs.linkSync(source, destination);
    fs.unlinkSync(source);
  }
}
export interface JournalOptions {
  readonly schema: unknown;
  readonly durability?: Durability;
  readonly projector?: ProjectionPort;
  readonly fault?: (stage: string) => void;
  readonly fileOps?: LinuxFileOps;
}
export interface AppendOptions {
  readonly actor_ref: string;
  readonly command_receipt?: unknown;
  readonly correlation_id?: string;
  readonly event_batch_id?: string;
  readonly written_at?: string;
}

export class FileJournal {
  readonly root: string;
  readonly durability: Durability;
  readonly recoveryActions: Wire[] = [];
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ops: LinuxFileOps;
  private readonly projector: ProjectionPort | undefined;
  private readonly fault: ((stage: string) => void) | undefined;
  private lockFD: number | undefined;
  private closed = false;
  private unknown = false;
  private busy = false;
  private metadata: Wire = {};
  private accepted: Wire[] = [];
  private receipts = new Map<string, Wire>();

  private constructor(root: string, options: JournalOptions) {
    if (root.split(/[\\/]/u).includes('..')) fail('unsafe_path', 'Dot traversal is forbidden');
    this.root = path.resolve(root);
    this.durability = options.durability ?? 'strict';
    this.ops = options.fileOps ?? new LinuxFileOps();
    this.projector = options.projector;
    this.fault = options.fault;
    const schema = copy(options.schema);
    function inspect(value: unknown): void {
      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }
      if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
          if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#/$defs/')))
            fail('schema_invalid', 'Only local registered schema references are allowed');
          if (key === '$dynamicRef' || key === '$recursiveRef')
            fail('schema_invalid', 'Dynamic references are unsupported');
          inspect(child);
        }
    }
    inspect(schema);
    try {
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      for (const name of [
        'FileJournalMeta',
        'CommitRecord',
        'BlobRef',
        'Checkpoint',
        'CommandReceipt',
      ])
        this.validators.set(name, ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/' + name }));
    } catch {
      fail('schema_invalid', 'Invalid local managed schema');
    }
  }

  static open(root: string, options: JournalOptions): FileJournal {
    return this.initialize(root, options);
  }
  private static initialize(
    root: string,
    options: JournalOptions,
    restore?: Uint8Array,
  ): FileJournal {
    const owner = new FileJournal(root, options);
    try {
      owner.platform();
      owner.mkdir(owner.root);
      const lock = path.join(owner.root, 'writer.lock');
      owner.checkPath(lock);
      const fd = fs.openSync(
        lock,
        fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        owner.ops.lock(fd);
      } catch (error) {
        fs.closeSync(fd);
        if (['EACCES', 'EAGAIN', 'EWOULDBLOCK', 'EDEADLK'].includes(code(error) ?? ''))
          fail('store_in_use', 'Store has an exclusive lifetime owner');
        throw error;
      }
      owner.lockFD = fd;
      owner.checkPath(lock);
      owner.syncDir(owner.root);
      for (const name of directories) owner.mkdir(path.join(owner.root, name));
      // link/unlink publication may have crashed between the two syscalls.
      owner.recoverPublicationLinks();
      const meta = path.join(owner.root, 'META.json');
      if (fs.existsSync(meta)) {
        owner.metadata = owner.readJSON(meta);
        owner.validate('FileJournalMeta', owner.metadata);
        if (owner.metadata.durability !== owner.durability)
          fail('durability_unsupported', 'Persisted durability must match');
        if (restore !== undefined) fail('restore_conflict', 'Restore requires a fresh store');
      } else {
        if (
          ['records', 'blobs', 'checkpoints'].some(
            (name) => fs.readdirSync(path.join(owner.root, name)).length,
          )
        )
          fail('corruption', 'Missing META with durable assets');
        owner.metadata = {
          schema: 'contexture.file-journal/v1',
          store_id: randomUUID(),
          canonical_profile: CANONICAL_PROFILE,
          durability: owner.durability,
          created_at: new Date().toISOString(),
        };
        if (restore !== undefined)
          owner.metadata.restored_from = owner.putBlob(restore, 'application/json');
        owner.validate('FileJournalMeta', owner.metadata);
        owner.publish(meta, canonicalJSON(owner.metadata), 'meta');
      }
      owner.recover();
      if (restore === undefined) owner.verifyRestoreOrigin();
      return owner;
    } catch (error) {
      owner.close();
      throw error;
    }
  }

  private platform(): void {
    if (process.platform !== 'linux' || !['strict', 'process_crash'].includes(this.durability))
      fail('durability_unsupported', 'Only qualified local Linux primitives are implemented');
    if (this.root.split(path.sep).some((part) => /^(onedrive|dropbox|google drive)/iu.test(part)))
      fail('durability_unsupported', 'Cloud synchronized storage is unsupported');
    let parent = this.root;
    for (;;) {
      if (fs.existsSync(path.join(parent, '.git')))
        fail('unsafe_path', 'Store must stay outside source worktrees');
      if (path.dirname(parent) === parent) break;
      parent = path.dirname(parent);
    }
    const mounts = fs
      .readFileSync('/proc/self/mountinfo', 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [left, right] = line.split(' - ');
        const mount = left!
          .split(' ')[4]!
          .replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
        return { mount, type: right!.split(' ')[0]! };
      })
      .filter(
        ({ mount }) =>
          this.root === mount || this.root.startsWith(mount === '/' ? '/' : mount + '/'),
      )
      .sort((a, b) => b.mount.length - a.mount.length);
    const type = mounts[0]?.type ?? 'unknown';
    const allowed =
      this.durability === 'strict'
        ? ['ext4', 'xfs', 'btrfs']
        : ['ext4', 'xfs', 'btrfs', 'tmpfs', 'overlay'];
    if (!allowed.includes(type))
      fail('durability_unsupported', 'Unsupported local filesystem: ' + type);
  }

  private validate(name: string, value: unknown): void {
    if (!this.validators.get(name)?.(value))
      fail('schema_invalid', 'Closed ' + name + ' contract rejected');
  }
  private hit(stage: string): void {
    this.fault?.(stage);
  }
  private guard<T>(write: boolean, action: () => T): T {
    if (this.closed || this.lockFD === undefined) fail('closed', 'Store owner is closed');
    if (write && this.unknown) throw new CommitUnknown();
    if (this.busy) fail('reentrant_operation', 'Journal callbacks may not reenter the owner');
    this.busy = true;
    try {
      return action();
    } finally {
      this.busy = false;
    }
  }
  close(): void {
    if (this.busy) fail('reentrant_operation', 'Cannot close an active owner');
    if (this.lockFD !== undefined) {
      fs.closeSync(this.lockFD);
      this.lockFD = undefined;
    }
    this.closed = true;
  }
  get meta(): Wire {
    return copy(this.metadata);
  }
  get watermark(): string {
    return this.guard(false, () => String(this.accepted.length));
  }

  private checkPath(target: string, directory = false, allowLinks = false): void {
    const relative = path.relative(this.root, target);
    if (relative.startsWith('..') && this.root !== target && !this.root.startsWith(target + '/'))
      fail('unsafe_path', 'Path escaped store boundary');
    const parts: string[] = [];
    for (let p = target; ; p = path.dirname(p)) {
      parts.unshift(p);
      if (path.dirname(p) === p) break;
    }
    for (const p of parts) {
      let info: fs.Stats;
      try {
        info = fs.lstatSync(p);
      } catch (error) {
        if (code(error) === 'ENOENT') continue;
        throw error;
      }
      if (info.isSymbolicLink()) fail('unsafe_path', 'Symlinks are forbidden');
      if (p === target && directory && !info.isDirectory())
        fail('unsafe_path', 'Expected directory');
      if (p === this.root || p.startsWith(this.root + '/')) {
        if (info.uid !== process.geteuid!() || info.mode & 0o077)
          fail('unsafe_permissions', 'Store assets must be private');
        if (!info.isDirectory() && (!info.isFile() || (!allowLinks && info.nlink !== 1)))
          fail('unsafe_path', 'Expected single-link regular file');
      }
    }
  }
  private mkdir(target: string): void {
    this.checkPath(target, true);
    if (fs.existsSync(target)) return;
    if (!fs.existsSync(path.dirname(target))) this.mkdir(path.dirname(target));
    try {
      fs.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      this.checkPath(target, true);
      return;
    }
    this.hit('directory.created');
    this.syncDir(path.dirname(target));
    this.hit('directory.synced');
  }
  private syncDir(target: string): void {
    this.checkPath(target, true);
    if (this.durability !== 'strict') return;
    const fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      this.ops.sync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  private confirm(target: string): void {
    this.checkPath(target);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      this.ops.sync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.syncDir(path.dirname(target));
    if (path.dirname(target) !== this.root) this.syncDir(path.dirname(path.dirname(target)));
  }
  private readBytes(target: string): Buffer {
    this.checkPath(target);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1)
        fail('unsafe_path', 'Expected single-link regular file');
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  private readJSON(target: string): Wire {
    const raw = this.readBytes(target);
    try {
      const value = copy(decodeJSON(raw));
      if (!equalRaw(value, raw)) fail('corruption', 'Noncanonical asset');
      return value;
    } catch {
      fail('corruption', 'Invalid canonical JSON object');
    }
  }
  private publish(final: string, raw: Uint8Array, kind: string): void {
    this.mkdir(path.dirname(final));
    this.syncDir(path.dirname(path.dirname(final)));
    this.checkPath(final);
    const temp = path.join(this.root, 'tmp', randomUUID() + '.tmp');
    this.checkPath(temp);
    const fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    let attempted = false;
    try {
      try {
        let offset = 0;
        while (offset < raw.length) {
          const n = this.ops.write(fd, raw.subarray(offset));
          if (!Number.isInteger(n) || n <= 0 || n > raw.length - offset)
            fail('write_failed', 'Short write made no progress');
          offset += n;
        }
        this.hit(kind + '.temp_written');
        this.ops.sync(fd);
        this.hit(kind + '.file_synced');
      } finally {
        fs.closeSync(fd);
      }
      if (fs.existsSync(final)) fail('corruption', 'Immutable destination exists');
      this.hit(kind + '.before_rename');
      attempted = true;
      this.ops.publish(temp, final);
      this.hit(kind + '.renamed');
      this.syncDir(path.dirname(final));
      this.syncDir(path.dirname(temp));
      this.hit(kind + '.directory_synced');
    } catch (error) {
      if (attempted) {
        this.unknown = true;
        if (kind === 'record') throw new CommitUnknown();
      }
      throw error;
    }
  }
  private walk(directory: string): string[] {
    const all: string[] = [];
    this.checkPath(directory, true, true);
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      this.checkPath(target, false, true);
      all.push(target);
      if (fs.lstatSync(target).isDirectory()) all.push(...this.walk(target));
    }
    return all;
  }
  private recoverPublicationLinks(): void {
    const temps = fs
      .readdirSync(path.join(this.root, 'tmp'))
      .map((n) => path.join(this.root, 'tmp', n));
    const assets = this.walk(this.root).filter(
      (p) => !p.startsWith(path.join(this.root, 'tmp') + '/'),
    );
    for (const temp of temps) {
      this.checkPath(temp, false, true);
      const info = fs.lstatSync(temp);
      if (!info.isFile()) fail('corruption', 'Unexpected temporary directory');
      if (info.nlink === 1) continue;
      const matches = assets.filter((p) => {
        const other = fs.lstatSync(p);
        return other.isFile() && other.dev === info.dev && other.ino === info.ino;
      });
      if (info.nlink !== 2 || matches.length !== 1 || !this.isImmutableAsset(matches[0]!))
        fail('unsafe_path', 'Unrecognized hard link');
      // Record the recovery action durably before unlinking the publication temp.
      const evidence = {
        schema: 'contexture.quarantine/v1',
        source: path.basename(temp),
        artifact: path.relative(this.root, matches[0]!),
        digest: bytesDigest(fs.readFileSync(temp)),
        action: 'published-temp-link',
      };
      this.publish(
        path.join(this.root, 'quarantine', randomUUID() + '.json'),
        canonicalJSON(evidence),
        'recovery',
      );
      fs.unlinkSync(temp);
      this.syncDir(path.dirname(temp));
      this.confirm(matches[0]!);
      this.recoveryActions.push(evidence);
    }
  }
  private isImmutableAsset(target: string): boolean {
    const rel = path.relative(this.root, target);
    return (
      rel === 'META.json' ||
      /^records\/[0-9]{20}\/[0-9]{20}\.json$/u.test(rel) ||
      /^blobs\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.blob$/u.test(rel) ||
      /^checkpoints\/[0-9]{20}\/[0-9a-f]{64}\.json$/u.test(rel) ||
      /^quarantine\/[0-9a-f-]{36}\.json$/u.test(rel)
    );
  }
  private recordPath(sequence: bigint): string {
    if (sequence < 1n || sequence > MAX_COUNTER)
      fail('limit_exceeded', 'Journal counter exhausted');
    return path.join(
      this.root,
      'records',
      String((sequence - 1n) / 10000n).padStart(20, '0'),
      String(sequence).padStart(20, '0') + '.json',
    );
  }
  private blobPath(digest: unknown): string {
    if (typeof digest !== 'string' || !digest.startsWith('sha256:') || !HEX.test(digest.slice(7)))
      fail('unsafe_path', 'Invalid blob selector');
    return path.join(this.root, 'blobs', 'sha256', digest.slice(7, 9), digest.slice(7) + '.blob');
  }
  private blobRefs(value: unknown): Wire[] {
    if (Array.isArray(value)) return value.flatMap((v: unknown) => this.blobRefs(v));
    if (!value || typeof value !== 'object') return [];
    const v = object(value);
    if (v.schema === 'contexture.journal-record/v1')
      return [
        ...this.blobRefs(v.command_receipt),
        ...entries(v.events)
          .filter((e) => e.type === 'RecoveryActionRecorded')
          .map((e) => object(e.evidence)),
      ];
    if (v.schema === 'contexture.command-receipt/v1') {
      const result = object(v.operation_result);
      return Object.hasOwn(result, 'blob') ? [object(result.blob)] : [];
    }
    if (v.schema === 'contexture.checkpoint/v1')
      return [...entries(v.blob_refs), ...this.blobRefs(v.receipts_index)];
    return [];
  }
  putBlob(data: Uint8Array, mediaType = 'application/octet-stream'): Wire {
    return this.guard(true, () => this.storeBlob(data, mediaType));
  }
  private storeBlob(data: Uint8Array, mediaType: string): Wire {
    if (!(data instanceof Uint8Array)) fail('schema_invalid', 'Blob input must be bytes');
    const raw = Buffer.from(data);
    if (mediaType === 'application/json' && !equalRaw(decodeJSON(raw), raw))
      fail('schema_invalid', 'JSON blob must be canonical');
    const ref = { digest: bytesDigest(raw), size: String(raw.length), media_type: mediaType };
    this.validate('BlobRef', ref);
    const target = this.blobPath(ref.digest);
    if (fs.existsSync(target)) {
      if (!this.loadBlob(ref).equals(raw)) fail('corruption', 'Blob conflict');
      this.confirm(target);
    } else this.publish(target, raw, 'blob');
    return copy(ref);
  }
  getBlob(ref: unknown): Buffer {
    return this.guard(false, () => this.loadBlob(copy(ref)));
  }
  private loadBlob(ref: Wire): Buffer {
    this.validate('BlobRef', ref);
    let raw: Buffer;
    try {
      raw = this.readBytes(this.blobPath(ref.digest));
    } catch (error) {
      if (code(error) === 'ENOENT') fail('history_unavailable', 'Required blob missing');
      throw error;
    }
    if (String(raw.length) !== ref.size || bytesDigest(raw) !== ref.digest)
      fail('corruption', 'Blob digest or size mismatch');
    if (ref.media_type === 'application/json' && !equalRaw(decodeJSON(raw), raw))
      fail('corruption', 'Noncanonical JSON blob');
    return raw;
  }

  private verifyRecord(record: Wire, sequence: bigint, previous: unknown): void {
    this.validate('CommitRecord', record);
    if (
      record.store_id !== this.metadata.store_id ||
      record.journal_seq !== String(sequence) ||
      record.prev_record_hash !== previous
    )
      fail('corruption', 'Record identity, sequence or previous hash mismatch');
    const { record_hash: hash, ...subject } = record;
    const payload: Wire = { events: record.events };
    if (Object.hasOwn(record, 'command_receipt')) payload.command_receipt = record.command_receipt;
    if (
      record.payload_digest !== canonicalDigest(payload, JOURNAL_PAYLOAD_DOMAIN) ||
      hash !== canonicalDigest(subject, JOURNAL_RECORD_DOMAIN)
    )
      fail('corruption', 'Record or payload digest mismatch');
    if (record.command_receipt !== undefined) {
      const r = object(record.command_receipt);
      if (
        r.journal_seq !== String(sequence) ||
        r.actor_ref !== record.actor_ref ||
        r.durability !== this.durability
      )
        fail('corruption', 'Receipt actor, sequence or durability mismatch');
      const event = entries(record.events)
        .filter((e) => ['GraphChangeCommitted', 'CommandCompleted'].includes(String(e.type)))
        .at(-1);
      if (
        event &&
        (r.graph_id !== event.graph_id ||
          r.revision !== (event.result_revision ?? event.revision) ||
          r.request_digest !== event.command_digest ||
          r.status !== (event.type === 'CommandCompleted' ? 'noop' : 'committed'))
      )
        fail('corruption', 'Receipt differs from accepted graph event');
    }
    for (const ref of this.blobRefs(record)) this.loadBlob(ref);
  }
  private recover(): void {
    for (const target of this.walk(this.root))
      this.checkPath(target, fs.lstatSync(target).isDirectory());
    if (this.metadata.restored_from !== undefined)
      this.loadBlob(object(this.metadata.restored_from));
    const paths: { sequence: bigint; target: string }[] = [];
    for (const bucket of fs.readdirSync(path.join(this.root, 'records'))) {
      const dir = path.join(this.root, 'records', bucket);
      if (!PAD.test(bucket) || !fs.lstatSync(dir).isDirectory())
        fail('corruption', 'Unexpected record bucket');
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json') || !PAD.test(name.slice(0, -5)))
          fail('corruption', 'Unexpected record filename');
        const sequence = BigInt(name.slice(0, -5)),
          target = path.join(dir, name);
        if (target !== this.recordPath(sequence)) fail('corruption', 'Wrong deterministic bucket');
        paths.push({ sequence, target });
      }
    }
    paths.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
    let previous: unknown = null;
    const batches = new Set<unknown>();
    for (const [index, { sequence, target }] of paths.entries()) {
      if (sequence !== BigInt(index + 1))
        fail('corruption', 'Missing or duplicate committed record');
      const record = this.readJSON(target);
      this.verifyRecord(record, sequence, previous);
      if (batches.has(record.event_batch_id)) fail('corruption', 'Duplicate event batch');
      batches.add(record.event_batch_id);
      if (record.command_receipt !== undefined) {
        const receipt = object(record.command_receipt),
          key = receiptKey(receipt.actor_ref, receipt.idempotency_key);
        if (this.receipts.has(key)) fail('corruption', 'Duplicate accepted receipt key');
        this.receipts.set(key, receipt);
      }
      this.confirm(target);
      this.accepted.push(record);
      previous = record.record_hash;
    }
    for (const name of fs.readdirSync(path.join(this.root, 'tmp')).sort()) {
      const source = path.join(this.root, 'tmp', name),
        target = path.join(this.root, 'quarantine', randomUUID() + '.artifact');
      const evidence = {
        schema: 'contexture.quarantine/v1',
        source: name,
        artifact: path.basename(target),
        digest: bytesDigest(this.readBytes(source)),
        action: 'unpublished-temp',
      };
      this.publish(target.slice(0, -9) + '.json', canonicalJSON(evidence), 'recovery');
      // Private owner namespace and fresh UUID; never replace any prior artifact.
      this.ops.publish(source, target);
      this.syncDir(path.dirname(target));
      this.syncDir(path.dirname(source));
      this.recoveryActions.push(evidence);
    }
  }
  records(after = '0'): Wire[] {
    return this.guard(false, () => {
      const n = parseCounter(after);
      if (n > BigInt(this.accepted.length))
        fail('schema_invalid', 'Cursor exceeds durable watermark');
      return this.accepted.slice(Number(n)).map(copy);
    });
  }
  getReceipt(actorRef: string, key: string): Wire | null {
    return this.guard(false, () => {
      const r = this.receipts.get(receiptKey(actorRef, key));
      return r ? copy(r) : null;
    });
  }
  append(events: unknown, options: AppendOptions): Wire {
    return this.guard(true, () => {
      const sequence = BigInt(this.accepted.length) + 1n;
      const receipt =
        options.command_receipt === undefined ? undefined : copy(options.command_receipt);
      if (receipt) {
        this.validate('CommandReceipt', receipt);
        if (receipt.actor_ref !== options.actor_ref)
          fail('schema_invalid', 'Receipt and record actor must agree');
        const prior = this.receipts.get(receiptKey(receipt.actor_ref, receipt.idempotency_key));
        if (prior) {
          if (prior.request_digest !== receipt.request_digest)
            fail('idempotency_conflict', 'Actor/key accepted another request');
          return copy(this.accepted[Number(parseCounter(prior.journal_seq)) - 1]);
        }
      }
      const record: Wire = {
        schema: 'contexture.journal-record/v1',
        store_id: this.metadata.store_id,
        journal_seq: String(sequence),
        event_batch_id: options.event_batch_id ?? randomUUID(),
        prev_record_hash: this.accepted.at(-1)?.record_hash ?? null,
        events: thawJSON(events),
        written_at: options.written_at ?? new Date().toISOString(),
        actor_ref: options.actor_ref,
        correlation_id: options.correlation_id ?? randomUUID(),
      };
      if (receipt) record.command_receipt = receipt;
      const payload: Wire = { events: record.events };
      if (receipt) payload.command_receipt = receipt;
      record.payload_digest = canonicalDigest(payload, JOURNAL_PAYLOAD_DOMAIN);
      record.record_hash = canonicalDigest(record, JOURNAL_RECORD_DOMAIN);
      this.verifyRecord(record, sequence, record.prev_record_hash);
      if (this.accepted.some((r) => r.event_batch_id === record.event_batch_id))
        fail('schema_invalid', 'Batch already accepted');
      for (const ref of this.blobRefs(record)) this.confirm(this.blobPath(ref.digest));
      this.publish(this.recordPath(sequence), canonicalJSON(record), 'record');
      try {
        const next = [...this.accepted, record],
          receipts = new Map(this.receipts);
        if (receipt) receipts.set(receiptKey(receipt.actor_ref, receipt.idempotency_key), receipt);
        this.receipts = receipts;
        this.accepted = next;
      } catch {
        this.unknown = true;
        throw new CommitUnknown();
      }
      return copy(record);
    });
  }
  private project(records: readonly Wire[]): Wire {
    if (!this.projector)
      fail('projection_required', 'Independent complete application projection port required');
    try {
      const value = copy(this.projector(records.map(copy)));
      if (
        Object.keys(value).length !== PROJECTIONS.length ||
        PROJECTIONS.some((k) => !Object.hasOwn(value, k))
      )
        fail('projection_invalid', 'Projection port must return every complete projection');
      return value;
    } catch (error) {
      this.unknown = true;
      throw error;
    }
  }
  projections(): Wire {
    return this.guard(false, () => this.project(this.accepted));
  }
  private checkCheckpoint(value: Wire): void {
    this.validate('Checkpoint', value);
    const { checkpoint_digest: digest, ...subject } = value;
    const count = parseCounter(value.last_seq);
    if (digest !== canonicalDigest(subject, CHECKPOINT_DOMAIN))
      fail('checkpoint_invalid', 'Checkpoint digest mismatch');
    if (
      value.store_id !== this.metadata.store_id ||
      count < 1n ||
      count > BigInt(this.accepted.length) ||
      value.last_record_hash !== this.accepted[Number(count) - 1]!.record_hash
    )
      fail('checkpoint_invalid', 'Checkpoint anchor mismatch');
    const projections = Object.fromEntries(PROJECTIONS.map((k) => [k, value[k]]));
    const ordered = (items: unknown, selector: (item: Wire) => string[]) => {
      const keys = entries(items).map(selector);
      for (let i = 1; i < keys.length; i++)
        if (tupleOrder(keys[i - 1]!, keys[i]!) >= 0)
          fail('checkpoint_invalid', 'Checkpoint ordering or uniqueness violation');
    };
    ordered(value.graphs, (g) => [String(object(g.definition).graph_id)]);
    for (const graph of entries(value.graphs)) {
      ordered(graph.tombstones, (t) => [String(t.node_id)]);
      if (graph.definition_digest !== canonicalDigest(graph.definition, 'contexture.graph/v1'))
        fail('checkpoint_invalid', 'Graph digest mismatch');
    }
    ordered(value.desired_releases, (r) => [
      String(object(r.request).graph_id),
      String(object(r.request).target_id),
    ]);
    ordered(value.receipts_index, (r) => [String(r.actor_ref), String(r.idempotency_key)]);
    ordered(value.blob_refs, (r) => [String(r.digest), String(r.media_type)]);
    const prefix = this.accepted.slice(0, Number(count));
    const receipts = prefix
      .filter((r) => r.command_receipt !== undefined)
      .map((r) => object(r.command_receipt))
      .sort((a, b) =>
        tupleOrder(
          [String(a.actor_ref), String(a.idempotency_key)],
          [String(b.actor_ref), String(b.idempotency_key)],
        ),
      );
    if (!equal(value.receipts_index, receipts))
      fail('checkpoint_invalid', 'Checkpoint lost accepted receipt results');
    if (!equal(projections, this.project(prefix)))
      fail('checkpoint_invalid', 'Projections differ from complete replay');
    const refs = new Map(this.blobRefs(prefix).map((r) => [receiptKey(r.digest, r.media_type), r]));
    for (const ref of entries(value.blob_refs)) {
      this.loadBlob(ref);
      refs.delete(receiptKey(ref.digest, ref.media_type));
    }
    if (refs.size) fail('checkpoint_invalid', 'Checkpoint omitted blob closure');
  }
  checkpoint(): Wire {
    return this.guard(true, () => this.makeCheckpoint());
  }
  private makeCheckpoint(): Wire {
    if (!this.accepted.length) fail('checkpoint_invalid', 'Checkpoint requires positive watermark');
    const subject = {
      schema: 'contexture.checkpoint/v1',
      store_id: this.metadata.store_id,
      last_seq: String(this.accepted.length),
      last_record_hash: this.accepted.at(-1)!.record_hash,
      ...this.project(this.accepted),
    };
    const value = { ...subject, checkpoint_digest: canonicalDigest(subject, CHECKPOINT_DOMAIN) };
    this.checkCheckpoint(value);
    const target = path.join(
      this.root,
      'checkpoints',
      String(this.accepted.length).padStart(20, '0'),
      value.checkpoint_digest.slice(7) + '.json',
    );
    if (fs.existsSync(target)) {
      if (!equal(this.readJSON(target), value)) fail('corruption', 'Checkpoint conflict');
      this.confirm(target);
    } else this.publish(target, canonicalJSON(value), 'checkpoint');
    return copy(value);
  }
  readCheckpoint(): Wire | null {
    return this.guard(false, () => this.findCheckpoint());
  }
  private findCheckpoint(): Wire | null {
    const candidates: { count: bigint; target: string; digest: string }[] = [];
    for (const bucket of fs.readdirSync(path.join(this.root, 'checkpoints'))) {
      const dir = path.join(this.root, 'checkpoints', bucket);
      this.checkPath(dir, true);
      if (!PAD.test(bucket)) continue;
      for (const name of fs.readdirSync(dir))
        if (name.endsWith('.json') && HEX.test(name.slice(0, -5)))
          candidates.push({
            count: BigInt(bucket),
            target: path.join(dir, name),
            digest: 'sha256:' + name.slice(0, -5),
          });
    }
    candidates.sort((a, b) =>
      a.count > b.count ? -1 : a.count < b.count ? 1 : b.target.localeCompare(a.target),
    );
    for (const { count, target, digest } of candidates) {
      let value: Wire;
      try {
        value = this.readJSON(target);
      } catch (error) {
        if (
          !(error instanceof JournalError) ||
          !['schema_invalid', 'corruption'].includes(error.code)
        )
          throw error;
        continue;
      }
      if (value.last_seq !== String(count) || value.checkpoint_digest !== digest) continue;
      try {
        this.checkCheckpoint(value);
      } catch (error) {
        if (
          !(error instanceof JournalError) ||
          !['checkpoint_invalid', 'schema_invalid'].includes(error.code)
        )
          throw error;
        continue;
      }
      return copy(value);
    }
    return null;
  }
  exportSnapshot(): Uint8Array {
    return this.guard(true, () => {
      const refs = this.blobRefs(this.accepted);
      if (this.metadata.restored_from !== undefined) refs.push(object(this.metadata.restored_from));
      const checkpoint = this.projector ? this.findCheckpoint() : null;
      if (checkpoint) refs.push(...this.blobRefs(checkpoint));
      const blobs = Object.fromEntries(
        refs.map((ref) => [String(ref.digest), this.loadBlob(ref).toString('hex')]),
      );
      const subject = {
        schema: 'contexture.file-journal-backup/v1',
        meta: this.meta,
        records: this.accepted.map(copy),
        blobs,
        checkpoint,
      };
      return canonicalJSON({
        ...subject,
        backup_digest: canonicalDigest(subject, JOURNAL_BACKUP_DOMAIN),
      });
    });
  }
  static restoreSnapshot(root: string, snapshot: Uint8Array, options: JournalOptions): FileJournal {
    const value = copy(decodeJSON(snapshot));
    const required = ['schema', 'meta', 'records', 'blobs', 'checkpoint', 'backup_digest'];
    if (
      Object.keys(value).length !== required.length ||
      required.some((k) => !Object.hasOwn(value, k)) ||
      value.schema !== 'contexture.file-journal-backup/v1' ||
      !equalRaw(value, snapshot)
    )
      fail('backup_invalid', 'Invalid closed canonical backup envelope');
    const { backup_digest: digest, ...subject } = value;
    if (digest !== canonicalDigest(subject, JOURNAL_BACKUP_DOMAIN))
      fail('backup_invalid', 'Backup digest mismatch');
    if (fs.existsSync(path.resolve(root)))
      fail('restore_conflict', 'Restore destination must not exist');
    // Detached verifier does no destination I/O; it uses actual byte validation.
    const verifier = new FileJournal(root, options);
    verifier.metadata = copy(value.meta);
    verifier.validate('FileJournalMeta', verifier.metadata);
    if (verifier.metadata.durability !== verifier.durability)
      fail('durability_unsupported', 'Restore cannot relabel durability');
    const blobs = new Map<string, Buffer>();
    for (const [digest, encoded] of Object.entries(object(value.blobs))) {
      if (typeof encoded !== 'string' || !/^(?:[0-9a-f]{2})*$/u.test(encoded))
        fail('backup_invalid', 'Invalid blob encoding');
      const raw = Buffer.from(encoded, 'hex');
      if (bytesDigest(raw) !== digest) fail('backup_invalid', 'Backup blob hash mismatch');
      blobs.set(digest, raw);
    }
    verifier.loadBlob = (ref: Wire): Buffer => {
      verifier.validate('BlobRef', ref);
      const raw = blobs.get(String(ref.digest));
      if (!raw || String(raw.length) !== ref.size)
        fail('backup_invalid', 'Backup lacks required blob bytes');
      if (ref.media_type === 'application/json' && !equalRaw(decodeJSON(raw), raw))
        fail('backup_invalid', 'Noncanonical backup blob');
      return raw;
    };
    const records = entries(value.records);
    let previous: unknown = null;
    const keys = new Set<string>(),
      batches = new Set<unknown>();
    for (const [index, record] of records.entries()) {
      verifier.verifyRecord(record, BigInt(index + 1), previous);
      if (batches.has(record.event_batch_id))
        fail('backup_invalid', 'Duplicate backup event batch');
      batches.add(record.event_batch_id);
      if (record.command_receipt !== undefined) {
        const r = object(record.command_receipt),
          key = receiptKey(r.actor_ref, r.idempotency_key);
        if (keys.has(key)) fail('backup_invalid', 'Duplicate backup receipt');
        keys.add(key);
      }
      previous = record.record_hash;
    }
    if (verifier.metadata.restored_from !== undefined)
      verifier.loadBlob(object(verifier.metadata.restored_from));
    verifier.accepted = records;
    if (value.checkpoint !== null) verifier.checkCheckpoint(copy(value.checkpoint));
    const owner = FileJournal.initialize(root, options, snapshot);
    try {
      for (const raw of blobs.values()) owner.putBlob(raw);
      for (const record of records)
        owner.append(record.events, {
          actor_ref: String(record.actor_ref),
          command_receipt: record.command_receipt,
          correlation_id: String(record.correlation_id),
          event_batch_id: String(record.event_batch_id),
          written_at: String(record.written_at),
        });
      owner.verifyRestoreOrigin();
      if (options.projector && records.length) owner.checkpoint();
      return owner;
    } catch (error) {
      owner.close();
      throw error;
    }
  }
  private verifyRestoreOrigin(): void {
    if (this.metadata.restored_from === undefined) return;
    const original = copy(decodeJSON(this.loadBlob(object(this.metadata.restored_from))));
    if (original.schema !== 'contexture.file-journal-backup/v1')
      fail('corruption', 'Restore provenance is not backup');
    const source = entries(original.records);
    if (this.accepted.length < source.length)
      fail('restore_incomplete', 'Interrupted restore must remain isolated');
    for (const [index, record] of source.entries()) {
      for (const key of [
        'events',
        'command_receipt',
        'event_batch_id',
        'actor_ref',
        'written_at',
        'correlation_id',
        'journal_seq',
      ]) {
        const actual = this.accepted[index]!;
        if (
          Object.hasOwn(record, key) !== Object.hasOwn(actual, key) ||
          (Object.hasOwn(record, key) && !equal(record[key], actual[key]))
        )
          fail('corruption', 'Restore differs from backup provenance');
      }
    }
  }
}
function equalRaw(value: unknown, raw: Uint8Array): boolean {
  return Buffer.from(canonicalJSON(value)).equals(raw);
}
function receiptKey(a: unknown, b: unknown): string {
  return JSON.stringify([a, b]);
}
function tupleOrder(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = Array.from(a[i]!, (c) => c.codePointAt(0)!),
      y = Array.from(b[i]!, (c) => c.codePointAt(0)!);
    for (let j = 0; j < Math.min(x.length, y.length); j++) if (x[j] !== y[j]) return x[j]! - y[j]!;
    if (x.length !== y.length) return x.length - y.length;
  }
  return a.length - b.length;
}
