/** Trusted local administration. No application loading, admission, or serving authority. */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  CANONICAL_PROFILE,
  GraphError,
  canonicalJSON,
  decodeJSON,
  parseCounter,
  validateID,
} from '../core/graph/canonical.js';
import { RELEASE_EVENT_TYPES } from '../core/graph/releases.js';
import { PACKAGE_VERSION } from '../core/foundation/vocabulary.js';
import { projectGraphJournal } from '../core/graph/journal-projection.js';
import { FileJournal, JournalError, LinuxFileOps } from './managed-journal.js';
import type { JournalOptions, OfflineJournalBudget } from './managed-journal.js';

type ObjectValue = Record<string, unknown>;
export type StoreOperation = 'doctor' | 'backup' | 'restore' | 'compatibility';
export interface StoreResult {
  readonly operation: StoreOperation;
  readonly code: string;
  readonly storage_verified: boolean;
  readonly definition_loaded: false;
  readonly desired_prepared: false;
  readonly serving_ready: false;
  readonly write_enabled: false;
  readonly isolated_restore_verified: boolean;
}
export interface SoftwareCompatibility {
  readonly reader_build: string;
  readonly writer_build: string;
  readonly store_formats: readonly string[];
  readonly record_formats: readonly string[];
  readonly event_types: readonly string[];
  readonly canonical_profiles: readonly string[];
  readonly semantic_versions: readonly string[];
  readonly durability_profiles: readonly string[];
}
export const REGISTERED_MANAGED_SCHEMA_DIGEST =
  'sha256:98c677c0b9cc2b51d3de8fd09a0eb8f4bfdb38e332234e1956a92cee5e48313a';
export const NATIVE_JOURNAL_SOFTWARE_SUPPORT: SoftwareCompatibility = Object.freeze({
  reader_build: PACKAGE_VERSION,
  writer_build: PACKAGE_VERSION,
  store_formats: Object.freeze(['contexture.file-journal/v1']),
  record_formats: Object.freeze(['contexture.journal-record/v1']),
  event_types: Object.freeze([
    'GraphChangeCommitted',
    'CommandCompleted',
    'RecoveryActionRecorded',
    ...RELEASE_EVENT_TYPES,
  ]),
  canonical_profiles: Object.freeze([CANONICAL_PROFILE]),
  semantic_versions: Object.freeze(['1']),
  durability_profiles: Object.freeze(['strict', 'process_crash']),
});
export interface TrustedStoreOperator {
  readonly operator_id: string;
  readonly permissions: readonly Exclude<StoreOperation, 'compatibility'>[];
  readonly software: SoftwareCompatibility;
}
export interface StoreAnchor {
  readonly store_id: string;
  readonly journal_seq: string;
  readonly record_hash: string | null;
}
export interface BackupArtifact {
  /** Privileged full history, not diagnostic output. */
  readonly snapshot: Uint8Array;
  readonly manifest: StoreAnchor & {
    readonly backup_digest: string;
    readonly restored_store_id: string;
  };
  readonly result: StoreResult;
}
export const DEFAULT_STORE_BUDGET: OfflineJournalBudget = Object.freeze({
  maxFiles: 100000,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxSnapshotBytes: 160 * 1024 * 1024,
});
function fail(code: string): never {
  throw new JournalError(code, 'Offline store operation refused');
}
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('schema_invalid');
  return value as ObjectValue;
}
function closed(value: unknown, keys: readonly string[]): ObjectValue {
  const obj = object(value);
  if (Object.keys(obj).length !== keys.length || keys.some((key) => !Object.hasOwn(obj, key)))
    fail('schema_invalid');
  return obj;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) fail('schema_invalid');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') fail('schema_invalid');
  return value;
}
function fingerprint(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJSON(value)).digest('hex');
}
function result(operation: StoreOperation, code: string, isolated = false): StoreResult {
  return Object.freeze({
    operation,
    code,
    storage_verified: code === 'ok' && operation !== 'compatibility',
    definition_loaded: false,
    desired_prepared: false,
    serving_ready: false,
    write_enabled: false,
    isolated_restore_verified: code === 'ok' && isolated,
  });
}
const SAFE_CODES = new Set([
  'unsafe_path',
  'unsafe_permissions',
  'durability_unsupported',
  'store_in_use',
  'closed',
  'corruption',
  'schema_invalid',
  'backup_invalid',
  'history_unavailable',
  'restore_conflict',
  'restore_incomplete',
  'projection_required',
  'projection_invalid',
  'checkpoint_invalid',
  'commit_unknown',
  'limit_exceeded',
  'recovery_required',
  'format_unsupported',
  'semantic_unsupported',
  'store_missing',
  'permission_denied',
  'confirmation_required',
  'artifact_exists',
  'reentrant_operation',
]);
/** Explicit public failures only. Programmer errors propagate instead of silently succeeding. */
export function storeFailure(operation: StoreOperation, error: unknown): StoreResult {
  if (error instanceof JournalError)
    return result(operation, SAFE_CODES.has(error.code) ? error.code : 'storage_error');
  if (error instanceof GraphError)
    return result(
      operation,
      error.code === 'unsupported_contract' ? 'format_unsupported' : 'corruption',
    );
  const value = object(error);
  const code = value.code;
  if (typeof code !== 'string') throw error;
  const codes: Readonly<Record<string, string>> = {
    ENOSPC: 'disk_full',
    EROFS: 'read_only',
    EACCES: 'permission_denied',
    EPERM: 'permission_denied',
    ENOENT: 'history_unavailable',
    EEXIST: 'artifact_exists',
    ELOOP: 'unsafe_path',
    ENOTDIR: 'unsafe_path',
    EIO: 'storage_error',
    EMFILE: 'storage_error',
    ENFILE: 'storage_error',
    EFBIG: 'limit_exceeded',
    ENOTSUP: 'durability_unsupported',
    EOPNOTSUPP: 'durability_unsupported',
    ENOSYS: 'durability_unsupported',
    EINVAL: 'storage_error',
    EBADF: 'storage_error',
    EBUSY: 'storage_error',
    ENXIO: 'storage_error',
    ENODEV: 'storage_error',
    ESTALE: 'storage_error',
    ENAMETOOLONG: 'unsafe_path',
  };
  if (!Object.hasOwn(codes, code)) throw error;
  return result(operation, codes[code]!);
}
function support(value: unknown): SoftwareCompatibility {
  const reference = object(NATIVE_JOURNAL_SOFTWARE_SUPPORT);
  const obj = closed(value, Object.keys(reference));
  if (obj.reader_build !== PACKAGE_VERSION || obj.writer_build !== PACKAGE_VERSION)
    fail('format_unsupported');
  for (const key of Object.keys(reference).filter((key) => !key.endsWith('_build'))) {
    const actual = array(obj[key]);
    if (
      !actual.length ||
      new Set(actual).size !== actual.length ||
      actual.some((entry) => typeof entry !== 'string' || !array(reference[key]).includes(entry))
    )
      fail('format_unsupported');
  }
  return Object.freeze({
    reader_build: string(obj.reader_build),
    writer_build: string(obj.writer_build),
    store_formats: Object.freeze(array(obj.store_formats).map(string)),
    record_formats: Object.freeze(array(obj.record_formats).map(string)),
    event_types: Object.freeze(array(obj.event_types).map(string)),
    canonical_profiles: Object.freeze(array(obj.canonical_profiles).map(string)),
    semantic_versions: Object.freeze(array(obj.semantic_versions).map(string)),
    durability_profiles: Object.freeze(array(obj.durability_profiles).map(string)),
  });
}
/** Load a closed inert administrator configuration, never an application/authority module. */
export function trustedStoreOperator(value: unknown): TrustedStoreOperator {
  const obj = closed(value, ['operator_id', 'permissions', 'software']);
  const permissions = array(obj.permissions);
  if (
    !permissions.length ||
    new Set(permissions).size !== permissions.length ||
    permissions.some((permission) => !['doctor', 'backup', 'restore'].includes(string(permission)))
  )
    fail('permission_denied');
  return Object.freeze({
    operator_id: validateID(obj.operator_id),
    permissions: Object.freeze(
      permissions.map((permission) => {
        if (permission !== 'doctor' && permission !== 'backup' && permission !== 'restore')
          fail('permission_denied');
        return permission;
      }),
    ),
    software: support(obj.software),
  });
}
/** Exact schema/profile/event support; neither integrity nor serving readiness. */
export function checkSoftwareCompatibility(
  snapshot: Uint8Array,
  declared: SoftwareCompatibility,
): StoreResult {
  const accepted = support(declared);
  const value = object(decodeJSON(snapshot)),
    meta = object(value.meta);
  if (
    !accepted.store_formats.includes(string(meta.schema)) ||
    !accepted.canonical_profiles.includes(string(meta.canonical_profile)) ||
    !accepted.durability_profiles.includes(string(meta.durability))
  )
    return result('compatibility', 'format_unsupported');
  for (const recordValue of array(value.records)) {
    const record = object(recordValue);
    if (!accepted.record_formats.includes(string(record.schema)))
      return result('compatibility', 'format_unsupported');
    const events = array(record.events);
    if (!events.length) fail('backup_invalid');
    for (const eventValue of events) {
      const event = object(eventValue);
      if (!accepted.event_types.includes(string(event.type)))
        return result('compatibility', 'format_unsupported');
      if (
        event.semantic_version !== undefined &&
        !accepted.semantic_versions.includes(string(event.semantic_version))
      )
        return result('compatibility', 'semantic_unsupported');
      if (event.type === 'GraphChangeCommitted')
        for (const factValue of array(event.resolved_facts)) {
          const fact = object(factValue);
          if (
            fact.type === 'GraphSeeded' &&
            !accepted.semantic_versions.includes(string(object(fact.after).semantic_version))
          )
            return result('compatibility', 'semantic_unsupported');
        }
    }
  }
  return result('compatibility', 'ok');
}

export class StoreOperations {
  readonly #operator: TrustedStoreOperator;
  readonly #options: JournalOptions;
  readonly #budget: OfflineJournalBudget;
  constructor(options: {
    readonly schema: unknown;
    readonly operator: TrustedStoreOperator;
    readonly durability?: 'strict' | 'process_crash';
    readonly budget?: OfflineJournalBudget;
  }) {
    if (fingerprint(options.schema) !== REGISTERED_MANAGED_SCHEMA_DIGEST) fail('schema_invalid');
    this.#operator = trustedStoreOperator(options.operator);
    this.#budget = Object.freeze({ ...(options.budget ?? DEFAULT_STORE_BUDGET) });
    if (
      Object.keys(this.#budget).length !== Object.keys(DEFAULT_STORE_BUDGET).length ||
      Object.keys(DEFAULT_STORE_BUDGET).some((key) => {
        const n = object(this.#budget)[key];
        return typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0;
      })
    )
      fail('schema_invalid');
    const durability = options.durability ?? 'strict';
    if (!this.#operator.software.durability_profiles.includes(durability))
      fail('format_unsupported');
    this.#options = Object.freeze({
      schema: decodeJSON(canonicalJSON(options.schema)),
      durability,
      projector: projectGraphJournal,
    });
  }
  private authorize(operation: Exclude<StoreOperation, 'compatibility'>): void {
    if (!this.#operator.permissions.includes(operation)) fail('permission_denied');
  }
  private verify(
    snapshot: Uint8Array,
    expected?: StoreAnchor,
  ): StoreAnchor & { backup_digest: string } {
    if (snapshot.length > this.#budget.maxSnapshotBytes) fail('limit_exceeded');
    const compatibility = checkSoftwareCompatibility(snapshot, this.#operator.software);
    if (compatibility.code !== 'ok') fail(compatibility.code);
    FileJournal.verifySnapshot(snapshot, this.#options);
    const value = object(decodeJSON(snapshot)),
      records = array(value.records);
    const hash = records.length ? string(object(records.at(-1)).record_hash) : null;
    const anchor = {
      store_id: validateID(object(value.meta).store_id),
      journal_seq: String(records.length),
      record_hash: hash,
    };
    if (expected !== undefined) {
      closed(expected, ['store_id', 'journal_seq', 'record_hash']);
      parseCounter(expected.journal_seq);
      if (fingerprint(expected) !== fingerprint(anchor)) fail('history_unavailable');
    }
    return Object.freeze({ ...anchor, backup_digest: string(value.backup_digest) });
  }
  /** Source-only detached verification: no owner creation, writes, or recovery, even on failure. */
  doctor(root: string, expectedAnchor?: StoreAnchor): StoreResult {
    try {
      this.authorize('doctor');
      FileJournal.withOfflineSnapshot(root, this.#options, this.#budget, (snapshot) => {
        this.verify(snapshot, expectedAnchor);
      });
      return result('doctor', 'ok');
    } catch (error) {
      return storeFailure('doctor', error);
    }
  }
  /** Source owner must be stopped; retain its lock until a real isolated restore is verified.
   * verificationRoot must be fresh. The verified clone remains private and closed, not serving.
   */
  backup(root: string, verificationRoot: string, expectedAnchor?: StoreAnchor): BackupArtifact {
    this.authorize('backup');
    this.freshDestination(verificationRoot);
    const source = path.resolve(root),
      destination = path.resolve(verificationRoot);
    if (
      source === destination ||
      destination.startsWith(source + path.sep) ||
      source.startsWith(destination + path.sep)
    )
      fail('restore_conflict');
    return FileJournal.withOfflineSnapshot(root, this.#options, this.#budget, (snapshot) => {
      const anchor = this.verify(snapshot, expectedAnchor);
      const restored = FileJournal.restoreSnapshot(verificationRoot, snapshot, this.#options);
      try {
        restored.projections();
        if (
          restored.watermark !== anchor.journal_seq ||
          restored.meta.store_id === anchor.store_id ||
          restored.meta.restored_from === undefined
        )
          fail('backup_invalid');
        return Object.freeze({
          snapshot,
          manifest: Object.freeze({
            ...anchor,
            restored_store_id: validateID(restored.meta.store_id),
          }),
          result: result('backup', 'ok', true),
        });
      } finally {
        restored.close();
      }
    });
  }
  private freshDestination(root: string): void {
    if (root.split(/[\\/]/u).includes('..')) fail('unsafe_path');
    FileJournal.checkLocation(path.dirname(path.resolve(root)), this.#options);
    try {
      fs.lstatSync(path.resolve(root));
    } catch (error) {
      if (object(error).code === 'ENOENT') return;
      throw error;
    }
    fail('restore_conflict');
  }
  restore(
    root: string,
    snapshot: Uint8Array,
    confirmation: { readonly allowWrite: boolean },
  ): StoreResult {
    this.authorize('restore');
    if (object(confirmation).allowWrite !== true || Object.keys(confirmation).length !== 1)
      fail('confirmation_required');
    this.freshDestination(root);
    const anchor = this.verify(snapshot);
    const restored = FileJournal.restoreSnapshot(root, snapshot, this.#options);
    try {
      restored.projections();
      if (
        restored.watermark !== anchor.journal_seq ||
        restored.meta.store_id === anchor.store_id ||
        restored.meta.restored_from === undefined
      )
        fail('backup_invalid');
      return result('restore', 'ok', true);
    } finally {
      restored.close();
    }
  }
  /** Private no-overwrite artifact publication. Full validation precedes durable publication. */
  publishBackup(destination: string, artifact: BackupArtifact): void {
    this.authorize('backup');
    const anchor = this.verify(artifact.snapshot);
    const manifest = closed(artifact.manifest, [
      'store_id',
      'journal_seq',
      'record_hash',
      'backup_digest',
      'restored_store_id',
    ]);
    validateID(manifest.restored_store_id);
    if (
      Object.entries(anchor).some(([key, value]) => manifest[key] !== value) ||
      manifest.restored_store_id === anchor.store_id ||
      artifact.result.operation !== 'backup' ||
      artifact.result.code !== 'ok' ||
      !artifact.result.isolated_restore_verified
    )
      fail('backup_invalid');
    if (destination.split(/[\\/]/u).includes('..')) fail('unsafe_path');
    const parent = FileJournal.checkLocation(
      path.dirname(path.resolve(destination)),
      this.#options,
    );
    const target = path.join(parent, path.basename(destination));
    const temporary = path.join(parent, '.contexture-backup-' + randomUUID());
    const ops = new LinuxFileOps();
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    let published = false;
    try {
      let offset = 0;
      while (offset < artifact.snapshot.length) {
        const count = ops.write(fd, artifact.snapshot.subarray(offset));
        if (!Number.isInteger(count) || count <= 0 || count > artifact.snapshot.length - offset)
          fail('storage_error');
        offset += count;
      }
      ops.sync(fd);
      fs.linkSync(temporary, target);
      published = true;
      fs.unlinkSync(temporary);
      if (this.#options.durability === 'strict') {
        const dirFD = fs.openSync(
          parent,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        try {
          ops.sync(dirFD);
        } finally {
          fs.closeSync(dirFD);
        }
      }
    } catch (error) {
      if (published) fail('commit_unknown');
      throw error;
    } finally {
      fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

/** Read only owner-private inert files with bounded size; never follow path aliases. */
export function readStoreFile(filename: string, maxBytes: number, privateFile = true): Uint8Array {
  if (filename.split(/[\\/]/u).includes('..')) fail('unsafe_path');
  const resolved = path.resolve(filename);
  for (let ancestor = resolved; ; ancestor = path.dirname(ancestor)) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) fail('unsafe_path');
    if (path.dirname(ancestor) === ancestor) break;
  }
  const before = fs.lstatSync(resolved);
  if (!before.isFile() || before.nlink !== 1) fail('unsafe_path');
  if (privateFile && (before.mode & 0o077 || (process.geteuid && before.uid !== process.geteuid())))
    fail('unsafe_permissions');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || before.size > maxBytes)
    fail('limit_exceeded');
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const start = fs.fstatSync(fd);
    if (start.dev !== before.dev || start.ino !== before.ino) fail('unsafe_path');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail('corruption');
      offset += count;
    }
    const end = fs.fstatSync(fd),
      current = fs.lstatSync(resolved);
    if (
      end.size !== before.size ||
      end.mtimeMs !== before.mtimeMs ||
      end.ctimeMs !== before.ctimeMs ||
      current.dev !== start.dev ||
      current.ino !== start.ino
    )
      fail('corruption');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
