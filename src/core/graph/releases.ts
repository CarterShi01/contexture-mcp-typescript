/** Existing managed candidate release facts. Replay grants neither authority nor serving state. */
import {
  GraphError,
  canonicalDigest,
  canonicalJSON,
  decodeJSON,
  freezeJSON,
  parseCounter,
  validateID,
} from './canonical.js';
import type { FrozenJSON } from './canonical.js';
import { contractDigest, contractText } from './bindings.js';
import type { JSONObject } from './model.js';

export const RELEASE_EVENT_TYPES = Object.freeze([
  'ReleaseRequested',
  'ReleasePreparationSucceeded',
  'ReleasePreparationFailed',
  'ReleaseSuperseded',
  'ReplicaObserved',
] as const);

export interface ReleaseIdentity {
  readonly graph_id: string;
  readonly target_id: string;
  readonly release_epoch: string;
}
export interface AttemptIdentity {
  readonly release: ReleaseIdentity;
  readonly instance_id: string;
  readonly boot_id: string;
  readonly attempt_id: string;
}
export interface ReleaseState {
  readonly desired_releases: readonly JSONObject[];
  readonly release_operations: readonly JSONObject[];
  readonly prepare_attempt_history: readonly JSONObject[];
  readonly observations_history: readonly JSONObject[];
}

function corrupt(message = 'Invalid release fact or projection'): never {
  throw new GraphError('journal_corrupt', message);
}
function object(value: unknown, required: string, optional = ''): JSONObject {
  const obj = freezeJSON(value);
  const keys = new Set(`${required} ${optional}`.split(' ').filter(Boolean));
  if (
    obj === null ||
    typeof obj !== 'object' ||
    Array.isArray(obj) ||
    required
      .split(' ')
      .filter(Boolean)
      .some((k) => !Object.hasOwn(obj, k)) ||
    Object.keys(obj).some((k) => !keys.has(k))
  )
    corrupt();
  return obj as JSONObject;
}
function array(value: unknown): readonly FrozenJSON[] {
  if (!Array.isArray(value)) corrupt();
  return value as readonly FrozenJSON[];
}
function counter(value: unknown, positive = true): string {
  const n = parseCounter(value);
  if (positive && n === 0n) corrupt();
  return value as string;
}
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)
  )
    corrupt();
  return value;
}
function equal(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJSON(left)).equals(Buffer.from(canonicalJSON(right)));
}
function frozen(value: unknown): JSONObject {
  return freezeJSON(value) as JSONObject;
}
function scalarOrder(left: string, right: string): number {
  const a = Array.from(left, (c) => c.codePointAt(0)!);
  const b = Array.from(right, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export class ReleaseRequest {
  readonly value: JSONObject;
  private constructor(value: JSONObject) {
    this.value = value;
    Object.freeze(this);
  }
  static fromJSON(value: unknown): ReleaseRequest {
    const obj = object(
      value instanceof Uint8Array ? decodeJSON(value) : value,
      'schema graph_id target_id revision definition_digest manifest_digest expected_desired_epoch idempotency_key policy reason',
      'approval_ref',
    );
    if (
      obj.schema !== 'contexture.release-request/v1' ||
      !['exact', 'latest'].includes(String(obj.policy))
    )
      corrupt();
    for (const key of ['graph_id', 'target_id', 'idempotency_key', 'approval_ref'])
      if (Object.hasOwn(obj, key)) validateID(obj[key]);
    counter(obj.revision);
    counter(obj.expected_desired_epoch, false);
    contractDigest(obj.definition_digest);
    contractDigest(obj.manifest_digest);
    contractText(obj.reason);
    return new ReleaseRequest(obj);
  }
  get graphID(): string {
    return this.value.graph_id as string;
  }
  get targetID(): string {
    return this.value.target_id as string;
  }
  get revision(): string {
    return this.value.revision as string;
  }
  get definitionDigest(): string {
    return this.value.definition_digest as string;
  }
  get manifestDigest(): string {
    return this.value.manifest_digest as string;
  }
  get expectedDesiredEpoch(): string {
    return this.value.expected_desired_epoch as string;
  }
  get idempotencyKey(): string {
    return this.value.idempotency_key as string;
  }
  get approvalRef(): string | undefined {
    return this.value.approval_ref as string | undefined;
  }
  subject(): JSONObject {
    return frozen(
      Object.fromEntries(
        Object.entries(this.value).filter(
          ([key]) => key !== 'idempotency_key' && key !== 'approval_ref',
        ),
      ),
    );
  }
  digest(): string {
    return canonicalDigest(this.subject(), 'contexture.command/v1');
  }
  asJSON(): JSONObject {
    return this.value;
  }
}

export function releaseIdentity(value: unknown): ReleaseIdentity {
  const obj = object(value, 'graph_id target_id release_epoch');
  return Object.freeze({
    graph_id: validateID(obj.graph_id),
    target_id: validateID(obj.target_id),
    release_epoch: counter(obj.release_epoch),
  });
}
export function attemptIdentity(value: unknown): AttemptIdentity {
  const obj = object(value, 'release instance_id boot_id attempt_id');
  return Object.freeze({
    release: releaseIdentity(obj.release),
    instance_id: validateID(obj.instance_id),
    boot_id: uuid(obj.boot_id),
    attempt_id: validateID(obj.attempt_id),
  });
}
export function releaseReceipt(value: unknown): JSONObject {
  const obj = object(value, 'schema release journal_seq request_digest status', 'superseded_by');
  const identity = releaseIdentity(obj.release);
  if (
    obj.schema !== 'contexture.release-receipt/v1' ||
    !['requested', 'superseded'].includes(String(obj.status)) ||
    (obj.status === 'superseded') !== Object.hasOwn(obj, 'superseded_by')
  )
    corrupt();
  counter(obj.journal_seq);
  contractDigest(obj.request_digest);
  if (
    obj.status === 'superseded' &&
    parseCounter(counter(obj.superseded_by)) <= parseCounter(identity.release_epoch)
  )
    corrupt();
  return obj;
}
function observation(value: unknown): JSONObject {
  const obj = object(
    value,
    'release instance_id boot_id generation_id revision definition_digest manifest_digest observed_at',
  );
  releaseIdentity(obj.release);
  validateID(obj.instance_id);
  uuid(obj.boot_id);
  uuid(obj.generation_id);
  counter(obj.revision);
  contractDigest(obj.definition_digest);
  contractDigest(obj.manifest_digest);
  if (
    typeof obj.observed_at !== 'string' ||
    !obj.observed_at.endsWith('Z') ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u.test(
      obj.observed_at,
    ) ||
    !Number.isFinite(Date.parse(obj.observed_at))
  )
    corrupt();
  if (
    obj.observed_at.startsWith('0000-') ||
    new Date(obj.observed_at).toISOString().slice(0, 19) !== obj.observed_at.slice(0, 19)
  )
    corrupt();
  return obj;
}
function diagnostics(value: unknown): void {
  const entries = array(value);
  if (!entries.length) corrupt();
  for (const item of entries) {
    const obj = object(item, 'code location message', 'node_id publication_id');
    contractText(obj.code);
    if (
      typeof obj.location !== 'string' ||
      (obj.location !== '' && !obj.location.startsWith('/')) ||
      /~(?![01])/u.test(obj.location) ||
      typeof obj.message !== 'string'
    )
      corrupt();
    for (const key of ['node_id', 'publication_id'])
      if (Object.hasOwn(obj, key)) validateID(obj[key]);
  }
}
function terminal(value: unknown): JSONObject {
  const obj = object(value, 'identity status', 'generation_id diagnostics');
  attemptIdentity(obj.identity);
  if (obj.status === 'ready') {
    object(obj, 'identity status generation_id');
    uuid(obj.generation_id);
  } else if (obj.status === 'failed') {
    object(obj, 'identity status diagnostics');
    diagnostics(obj.diagnostics);
  } else corrupt('Candidate facts cannot reconstruct nonterminal attempts');
  return obj;
}
function key(value: unknown): string {
  const r = releaseIdentity(value);
  return JSON.stringify([r.graph_id, r.target_id, r.release_epoch]);
}
function targetKey(value: unknown): string {
  const r = releaseIdentity(value);
  return JSON.stringify([r.graph_id, r.target_id]);
}
function identity(request: ReleaseRequest, epoch: string): ReleaseIdentity {
  return releaseIdentity({
    graph_id: request.graphID,
    target_id: request.targetID,
    release_epoch: epoch,
  });
}
function matchCurrent(
  desired: JSONObject | undefined,
  id: ReleaseIdentity,
  value: JSONObject,
): void {
  if (desired?.release_epoch !== id.release_epoch) return;
  const request = ReleaseRequest.fromJSON(desired.request);
  for (const field of ['revision', 'definition_digest', 'manifest_digest'])
    if (Object.hasOwn(value, field) && value[field] !== request.value[field])
      throw new GraphError('contract_mismatch', 'Current release metadata differs');
}
export function emptyReleaseState(): ReleaseState {
  return Object.freeze({
    desired_releases: Object.freeze([]),
    release_operations: Object.freeze([]),
    prepare_attempt_history: Object.freeze([]),
    observations_history: Object.freeze([]),
  });
}
export function importReleaseState(value: unknown): ReleaseState {
  const obj = object(
    value,
    'desired_releases release_operations prepare_attempt_history observations_history',
  );
  const operations = new Map<string, JSONObject>(),
    epochs = new Map<string, bigint>();
  const superseded = new Set<string>();
  let sequence = 0n;
  const releaseOperations = array(obj.release_operations).map((raw) => {
    const op = releaseReceipt(raw),
      id = releaseIdentity(op.release),
      marker = key(id);
    const seq = parseCounter(op.journal_seq);
    if (seq < sequence) corrupt();
    sequence = seq;
    if (op.status === 'requested') {
      if (
        operations.has(marker) ||
        parseCounter(id.release_epoch) !== (epochs.get(targetKey(id)) ?? 0n) + 1n
      )
        throw new GraphError('revision_conflict', 'Release epoch sequence differs');
      operations.set(marker, op);
      epochs.set(targetKey(id), parseCounter(id.release_epoch));
    } else {
      if (
        !operations.has(marker) ||
        superseded.has(marker) ||
        operations.get(marker)!.request_digest !== op.request_digest ||
        parseCounter(op.superseded_by) > epochs.get(targetKey(id))! + 1n
      )
        corrupt();
      superseded.add(marker);
    }
    return op;
  });
  const desired = new Map<string, JSONObject>();
  for (const raw of array(obj.desired_releases)) {
    const item = object(raw, 'request release_epoch'),
      request = ReleaseRequest.fromJSON(item.request);
    const id = identity(request, counter(item.release_epoch)),
      marker = targetKey(id);
    if (
      parseCounter(id.release_epoch) !== parseCounter(request.expectedDesiredEpoch) + 1n ||
      desired.has(marker) ||
      epochs.get(marker) !== parseCounter(id.release_epoch) ||
      operations.get(key(id))?.request_digest !== request.digest()
    )
      corrupt();
    desired.set(marker, item);
  }
  if (desired.size !== epochs.size) corrupt();
  const attempts = new Set<string>();
  const prepareAttempts = array(obj.prepare_attempt_history).map((raw) => {
    const item = terminal(raw),
      attempt = attemptIdentity(item.identity);
    const marker = Buffer.from(canonicalJSON(attempt)).toString('utf8');
    if (!operations.has(key(attempt.release)) || attempts.has(marker)) corrupt();
    attempts.add(marker);
    return item;
  });
  const observations = array(obj.observations_history).map((raw) => {
    const item = observation(raw),
      id = releaseIdentity(item.release);
    if (!operations.has(key(id))) corrupt();
    matchCurrent(desired.get(targetKey(id)), id, item);
    return item;
  });
  const desiredReleases = [...desired.values()].sort((a, b) => {
    const x = ReleaseRequest.fromJSON(a.request),
      y = ReleaseRequest.fromJSON(b.request);
    return scalarOrder(x.graphID, y.graphID) || scalarOrder(x.targetID, y.targetID);
  });
  return Object.freeze({
    desired_releases: Object.freeze(desiredReleases),
    release_operations: Object.freeze(releaseOperations),
    prepare_attempt_history: Object.freeze(prepareAttempts),
    observations_history: Object.freeze(observations),
  });
}

export function reduceReleaseEvent(
  state: ReleaseState,
  raw: unknown,
  recordValue: unknown,
): ReleaseState {
  const current = importReleaseState(state);
  const tag = object(
    raw,
    'type',
    'request release_epoch attempt generation_id manifest_digest diagnostics release superseded_by observation',
  ).type;
  const fields: Record<string, string> = {
    ReleaseRequested: 'type request release_epoch',
    ReleasePreparationSucceeded: 'type attempt generation_id manifest_digest',
    ReleasePreparationFailed: 'type attempt diagnostics',
    ReleaseSuperseded: 'type release superseded_by',
    ReplicaObserved: 'type observation',
  };
  if (typeof tag !== 'string' || !Object.hasOwn(fields, tag)) corrupt('Unsupported release event');
  const event = object(raw, fields[tag]!);
  const nativeRecord = freezeJSON(recordValue);
  if (nativeRecord === null || typeof nativeRecord !== 'object' || Array.isArray(nativeRecord))
    corrupt();
  const record = nativeRecord as JSONObject;
  const seq = counter(record.journal_seq),
    actor = validateID(record.actor_ref);
  if (record.events !== undefined && !array(record.events).some((item) => equal(item, event)))
    corrupt();
  if (record.record_hash !== undefined) {
    contractDigest(record.record_hash);
    contractDigest(record.payload_digest);
    const payload = {
      events: record.events,
      ...(record.command_receipt === undefined ? {} : { command_receipt: record.command_receipt }),
    };
    if (
      canonicalDigest(payload, 'contexture.journal-payload/v1') !== record.payload_digest ||
      canonicalDigest(
        Object.fromEntries(Object.entries(record).filter(([k]) => k !== 'record_hash')),
        'contexture.journal-record/v1',
      ) !== record.record_hash
    )
      corrupt();
  }
  const desired = [...current.desired_releases],
    operations = [...current.release_operations];
  const attempts = [...current.prepare_attempt_history],
    observations = [...current.observations_history];
  if (operations.length && parseCounter(seq) < parseCounter(operations.at(-1)!.journal_seq))
    corrupt();
  if (tag === 'ReleaseRequested') {
    const request = ReleaseRequest.fromJSON(event.request),
      epoch = counter(event.release_epoch);
    const prior = desired.find((d) => {
      const r = ReleaseRequest.fromJSON(d.request);
      return r.graphID === request.graphID && r.targetID === request.targetID;
    });
    const expected = prior?.release_epoch ?? '0';
    if (
      request.expectedDesiredEpoch !== expected ||
      parseCounter(epoch) !== parseCounter(expected) + 1n
    )
      throw new GraphError('revision_conflict', 'Desired release epoch differs');
    const receipt = releaseReceipt({
      schema: 'contexture.release-receipt/v1',
      release: identity(request, epoch),
      journal_seq: seq,
      request_digest: request.digest(),
      status: 'requested',
    });
    if (record.command_receipt !== undefined) {
      const supplied = object(
        record.command_receipt,
        'schema graph_id actor_ref idempotency_key request_digest revision journal_seq status durability operation_result',
      );
      const result = object(supplied.operation_result, 'inline');
      counter(supplied.revision, false);
      if (
        supplied.schema !== 'contexture.command-receipt/v1' ||
        supplied.status !== 'committed' ||
        !['strict', 'process_crash'].includes(String(supplied.durability)) ||
        supplied.actor_ref !== actor ||
        supplied.graph_id !== request.graphID ||
        supplied.idempotency_key !== request.idempotencyKey ||
        supplied.request_digest !== request.digest() ||
        supplied.journal_seq !== seq ||
        !equal(releaseReceipt(result.inline), receipt)
      )
        corrupt();
    }
    if (prior !== undefined) desired.splice(desired.indexOf(prior), 1);
    desired.push(frozen({ request: request.asJSON(), release_epoch: epoch }));
    operations.push(receipt);
  } else {
    const id =
      tag === 'ReplicaObserved'
        ? releaseIdentity(observation(event.observation).release)
        : tag === 'ReleaseSuperseded'
          ? releaseIdentity(event.release)
          : attemptIdentity(event.attempt).release;
    const prior = operations.find((op) => key(op.release) === key(id) && op.status === 'requested');
    if (prior === undefined) corrupt();
    const target = desired.find((d) => {
      const request = ReleaseRequest.fromJSON(d.request);
      return targetKey(identity(request, d.release_epoch as string)) === targetKey(id);
    });
    if (tag === 'ReleaseSuperseded') {
      if (operations.some((op) => key(op.release) === key(id) && op.status === 'superseded'))
        throw new GraphError('identity_conflict', 'Release was already superseded');
      operations.push(
        releaseReceipt({
          schema: 'contexture.release-receipt/v1',
          release: id,
          journal_seq: seq,
          request_digest: prior.request_digest,
          status: 'superseded',
          superseded_by: counter(event.superseded_by),
        }),
      );
    } else if (tag === 'ReplicaObserved') {
      const item = observation(event.observation);
      matchCurrent(target, id, item);
      observations.push(item);
    } else {
      const attempt = attemptIdentity(event.attempt);
      if (attempts.some((item) => equal(item.identity, attempt)))
        throw new GraphError('identity_conflict', 'Attempt already has a terminal fact');
      const success = tag === 'ReleasePreparationSucceeded';
      if (success) {
        contractDigest(event.manifest_digest);
        matchCurrent(target, id, event);
      } else diagnostics(event.diagnostics);
      attempts.push(
        terminal({
          identity: attempt,
          status: success ? 'ready' : 'failed',
          ...(success
            ? { generation_id: uuid(event.generation_id) }
            : { diagnostics: event.diagnostics }),
        }),
      );
    }
  }
  return importReleaseState({
    desired_releases: desired,
    release_operations: operations,
    prepare_attempt_history: attempts,
    observations_history: observations,
  });
}

export function replayReleases(records: readonly JSONObject[]): ReleaseState {
  let state = emptyReleaseState();
  for (const record of records)
    for (const event of array(record.events)) {
      if (
        event !== null &&
        typeof event === 'object' &&
        !Array.isArray(event) &&
        RELEASE_EVENT_TYPES.includes(
          (event as JSONObject).type as (typeof RELEASE_EVENT_TYPES)[number],
        )
      )
        state = reduceReleaseEvent(state, event, record);
    }
  return state;
}
