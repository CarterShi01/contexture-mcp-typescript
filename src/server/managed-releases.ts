/** Physical FileJournal release owner. No native filesystem dependency enters ./managed. */
import { GraphError, freezeJSON, parseCounter, validateID } from '../core/graph/canonical.js';
import type { FrozenJSON } from '../core/graph/canonical.js';
import { ExecutionManifest, contractDigest } from '../core/graph/bindings.js';
import type { ManagedIdentity } from '../core/graph/bindings.js';
import { StructuralPlan } from '../core/graph/compiler.js';
import { RevisionState, equalJSON, scalarOrder } from '../core/graph/events.js';
import type { JSONObject } from '../core/graph/model.js';
import {
  ReleaseRequest,
  attemptIdentity,
  reduceReleaseEvent,
  releaseIdentity,
  releaseReceipt,
  replayReleases,
} from '../core/graph/releases.js';
import type { ReleaseState } from '../core/graph/releases.js';
import { ReadyGeneration } from '../application/managed-generation.js';
import type {
  CapturedRelease,
  ReleaseAuthority,
  ServingAttempt,
  ServingObservationPort,
  ServingPreparationProvider,
} from '../application/managed-serving.js';
import { FileJournal, CommitUnknown } from './managed-journal.js';
import type { ProjectionPort } from './managed-journal.js';
export { FileJournal, CommitUnknown };
export { JournalError, LinuxFileOps } from './managed-journal.js';
export type {
  JournalOptions,
  Durability,
  AppendOptions,
  ProjectionPort,
} from './managed-journal.js';

export interface JournalHistoryView {
  readonly storeID: string;
  readonly watermark: string;
  readonly records: readonly JSONObject[];
}
export interface VerifiedReleaseHistory {
  readonly snapshot: RevisionState;
  readonly storeID: string;
  readonly journalSeq: string;
  readonly recordHash: string;
}
export interface ReleaseHistoryReader {
  /** Attest full graph replay at the exact revision, anchored in this accepted journal. */
  read(graphID: string, revision: string, view: JournalHistoryView): VerifiedReleaseHistory;
}
export interface ReleaseHostContext {
  readonly actor_ref: string;
  readonly identity: ManagedIdentity;
}
export interface ReleaseAdmission {
  readonly context: ReleaseHostContext;
  readonly operation:
    'release.request' | 'release.prepare' | 'release.swap' | 'release.observe' | 'release.status';
  readonly request: ReleaseRequest;
  readonly requestDigest: string;
  readonly history: VerifiedReleaseHistory;
  readonly compilation:
    | Readonly<{ kind: 'verified'; manifest: ExecutionManifest }>
    | Readonly<{ kind: 'terminal_failure'; manifestDigest: string }>;
}
export interface ReleaseReceiptAdmission {
  readonly context: ReleaseHostContext;
  readonly operation: 'release.status';
  readonly request: ReleaseRequest;
  readonly requestDigest: string;
  readonly compilation: Readonly<{ kind: 'receipt_read'; receipt: JSONObject }>;
}
export type ReleaseHostAdmission = ReleaseAdmission | ReleaseReceiptAdmission;
export interface ReleaseHostPort {
  current(): ReleaseHostContext;
  verifyApproval(admission: ReleaseHostAdmission): unknown;
  admit(admission: ReleaseHostAdmission, approval: unknown): void;
  /**
   * Current identity/admission/approval fence, shared with the graph authoring owner.
   * All proof ports are synchronous and I/O-free. Call action once synchronously,
   * while holding that authority/authoring serialization. Never retain action.
   */
  fence<T>(admission: ReleaseHostAdmission, approval: unknown, action: () => T): T;
}
export interface ReleaseCompilePort {
  /** Independently compile exact verified history against CURRENT trusted registry.
   * Pure synchronous proof: no I/O, native handlers, resource preparation or replay authority.
   */
  verify(
    request: ReleaseRequest,
    history: VerifiedReleaseHistory,
    context: ReleaseHostContext,
  ): StructuralPlan;
}
export interface ReleaseGraphProjection {
  readonly graphs: FrozenJSON;
  readonly projection_versions: FrozenJSON;
  readonly blob_refs: FrozenJSON;
}
export type ReleaseGraphProjector = (records: readonly JSONObject[]) => ReleaseGraphProjection;

/** Compose full checkpoint sections; the graph projector is mandatory, never an empty default. */
export function releaseJournalProjector(graphs: ReleaseGraphProjector): ProjectionPort {
  return (records) => {
    const accepted = freezeJSON(records) as readonly JSONObject[];
    const base = graphs(accepted);
    const releases = replayReleases(accepted);
    const receipts = accepted.flatMap((record) =>
      record.command_receipt === undefined ? [] : [record.command_receipt as JSONObject],
    );
    receipts.sort(
      (a, b) =>
        scalarOrder(String(a.actor_ref), String(b.actor_ref)) ||
        scalarOrder(String(a.idempotency_key), String(b.idempotency_key)),
    );
    return {
      graphs: base.graphs,
      ...releases,
      receipts_index: receipts,
      projection_versions: base.projection_versions,
      blob_refs: base.blob_refs,
    };
  };
}

function identity(attempt: ServingAttempt): JSONObject {
  return freezeJSON(
    attemptIdentity({
      release: {
        graph_id: attempt.release.graph_id,
        target_id: attempt.release.target_id,
        release_epoch: attempt.release.release_epoch,
      },
      instance_id: attempt.instance_id,
      boot_id: attempt.boot_id,
      attempt_id: attempt.attempt_id,
    }),
  ) as JSONObject;
}
function context(value: ReleaseHostContext): ReleaseHostContext {
  return Object.freeze({
    actor_ref: validateID(value.actor_ref),
    identity: Object.freeze({
      actor_id: validateID(value.identity.actor_id),
      tenant_id: validateID(value.identity.tenant_id),
      authority_revision: validateID(value.identity.authority_revision),
    }),
  });
}

export class FileJournalReleaseOwner implements ReleaseAuthority, ServingObservationPort {
  readonly graphID: string;
  readonly targetID: string;
  readonly #host: ReleaseHostPort;
  readonly #history: ReleaseHistoryReader;
  readonly #compile: ReleaseCompilePort;
  readonly #storeID: string;
  #journal: FileJournal;
  #busy = false;
  #frozen = false;
  #confirmedSequence = '0';
  #confirmedHash: FrozenJSON = null;
  readonly #ready = new WeakMap<ServingAttempt, ReadyGeneration>();
  readonly #adopted = new WeakSet<ServingAttempt>();

  constructor(
    journal: FileJournal,
    options: {
      graphID: string;
      targetID: string;
      host: ReleaseHostPort;
      history: ReleaseHistoryReader;
      compilation: ReleaseCompilePort;
    },
  ) {
    this.graphID = validateID(options.graphID);
    this.targetID = validateID(options.targetID);
    this.#journal = journal;
    this.#storeID = validateID(journal.meta.store_id);
    this.#host = Object.freeze({
      current: options.host.current.bind(options.host),
      verifyApproval: options.host.verifyApproval.bind(options.host),
      admit: options.host.admit.bind(options.host),
      fence: options.host.fence.bind(options.host),
    });
    this.#history = Object.freeze({ read: options.history.read.bind(options.history) });
    this.#compile = Object.freeze({ verify: options.compilation.verify.bind(options.compilation) });
    this.read();
    Object.freeze(this);
  }
  get swapsFrozen(): boolean {
    return this.#frozen;
  }

  private boundary<T>(action: () => T, recovery = false): T {
    if (this.#busy) throw new GraphError('resource_busy', 'Release owner reentry refused');
    if (this.#frozen && !recovery)
      throw new GraphError('resource_busy', 'Release owner requires journal recovery');
    if (!recovery) {
      try {
        this.#journal.assertWritable();
      } catch (error) {
        this.#frozen = true;
        throw error;
      }
    }
    this.#busy = true;
    try {
      return action();
    } catch (error) {
      if (error instanceof CommitUnknown) this.#frozen = true;
      throw error;
    } finally {
      this.#busy = false;
    }
  }
  private read(): Readonly<{ view: JournalHistoryView; state: ReleaseState }> {
    const records = freezeJSON(this.#journal.records()) as readonly JSONObject[];
    const state = replayReleases(records);
    const watermark = this.#journal.watermark;
    this.#confirmedSequence = watermark;
    this.#confirmedHash = records.at(-1)?.record_hash ?? null;
    return Object.freeze({
      state,
      view: Object.freeze({ storeID: this.#storeID, watermark, records }),
    });
  }
  private desired(state: ReleaseState): JSONObject | undefined {
    return state.desired_releases.find((item) => {
      const request = ReleaseRequest.fromJSON(item.request);
      return request.graphID === this.graphID && request.targetID === this.targetID;
    });
  }
  private scope(request: ReleaseRequest): void {
    if (request.graphID !== this.graphID || request.targetID !== this.targetID)
      throw new GraphError('permission_denied', 'Release owner scope differs');
  }
  private authorize<T>(
    operation: ReleaseAdmission['operation'],
    request: ReleaseRequest,
    view: JournalHistoryView,
    action: (admission: ReleaseAdmission) => T,
    terminalFailure = false,
  ): T {
    this.scope(request);
    const current = context(this.#host.current());
    const supplied = this.#history.read(request.graphID, request.revision, view);
    if (parseCounter(supplied.journalSeq) === 0n)
      throw new GraphError('contract_mismatch', 'Historical anchor must be positive');
    contractDigest(supplied.recordHash);
    const anchor = view.records.find((record) => record.journal_seq === supplied.journalSeq);
    if (
      !(supplied.snapshot instanceof RevisionState) ||
      anchor === undefined ||
      supplied.storeID !== this.#storeID ||
      anchor?.record_hash !== supplied.recordHash ||
      supplied.snapshot.definition.graph_id !== request.graphID ||
      supplied.snapshot.revision !== request.revision ||
      supplied.snapshot.definitionDigest !== request.definitionDigest
    )
      throw new GraphError('contract_mismatch', 'Verified historical provenance differs');
    const history = Object.freeze({ ...supplied });
    let compilation: ReleaseAdmission['compilation'];
    if (terminalFailure) {
      compilation = Object.freeze({
        kind: 'terminal_failure',
        manifestDigest: request.manifestDigest,
      });
    } else {
      const plan = this.#compile.verify(request, history, current);
      if (
        !StructuralPlan.isCompiled(plan) ||
        plan.definitionDigest !== request.definitionDigest ||
        plan.definition.graph_id !== request.graphID ||
        plan.manifest.manifestDigest !== request.manifestDigest
      )
        throw new GraphError('contract_mismatch', 'Current independent compile evidence differs');
      compilation = Object.freeze({ kind: 'verified', manifest: plan.manifest });
    }
    const admission: ReleaseAdmission = Object.freeze({
      context: current,
      operation,
      request,
      requestDigest: request.digest(),
      history,
      compilation,
    });
    const proof = this.#host.verifyApproval(admission);
    if (proof instanceof Promise) {
      void proof.catch(() => undefined);
      throw new GraphError('permission_denied', 'Approval verification must be synchronous');
    }
    const admitted: unknown = this.#host.admit(admission, proof);
    if (admitted !== undefined) {
      if (admitted instanceof Promise) void admitted.catch(() => undefined);
      throw new GraphError('permission_denied', 'Admission must complete synchronously');
    }
    let open = true,
      entered = false;
    try {
      const result = this.#host.fence(admission, proof, () => {
        if (!open || entered)
          throw new GraphError('permission_denied', 'Authority fence capability closed');
        entered = true;
        if (
          !equalJSON(context(this.#host.current()), current) ||
          this.#journal.watermark !== view.watermark
        )
          throw new GraphError(
            'permission_denied',
            'Authority or journal changed during verification',
          );
        if (!terminalFailure) {
          const checked = this.#compile.verify(request, history, current);
          if (
            !StructuralPlan.isCompiled(checked) ||
            checked.definitionDigest !== request.definitionDigest ||
            checked.definition.graph_id !== request.graphID ||
            checked.manifest.manifestDigest !== request.manifestDigest
          )
            throw new GraphError('contract_mismatch', 'Compile authority changed at final fence');
        }
        if (
          !equalJSON(context(this.#host.current()), current) ||
          this.#journal.watermark !== view.watermark
        )
          throw new GraphError('permission_denied', 'Final authority or journal fence changed');
        this.#journal.assertWritable();
        return action(admission);
      });
      if (!entered || result instanceof Promise) {
        if (result instanceof Promise) void result.catch(() => undefined);
        throw new GraphError('permission_denied', 'Authority fence must complete synchronously');
      }
      return result;
    } finally {
      open = false;
    }
  }
  private append(
    state: ReleaseState,
    events: readonly JSONObject[],
    actor: string,
    receipt?: JSONObject,
  ): void {
    const next = String(parseCounter(this.#journal.watermark) + 1n);
    const speculative = {
      journal_seq: next,
      actor_ref: actor,
      events,
      ...(receipt === undefined ? {} : { command_receipt: receipt }),
    };
    let candidate = state;
    for (const event of events) candidate = reduceReleaseEvent(candidate, event, speculative);
    try {
      const accepted = this.#journal.append(events, {
        actor_ref: actor,
        ...(receipt === undefined ? {} : { command_receipt: receipt }),
      });
      if (accepted.journal_seq !== next) throw new CommitUnknown();
      this.read();
    } catch (error) {
      this.#frozen = true;
      throw error;
    }
  }

  private receiptRead(
    request: ReleaseRequest,
    receipt: JSONObject,
    expected: ReleaseHostContext,
    view: JournalHistoryView,
  ): JSONObject {
    const current = context(this.#host.current());
    if (!equalJSON(current, expected))
      throw new GraphError('permission_denied', 'Receipt identity changed');
    const admission: ReleaseReceiptAdmission = Object.freeze({
      context: current,
      operation: 'release.status',
      request,
      requestDigest: request.digest(),
      compilation: Object.freeze({ kind: 'receipt_read', receipt }),
    });
    const proof = this.#host.verifyApproval(admission);
    if (proof instanceof Promise) {
      void proof.catch(() => undefined);
      throw new GraphError('permission_denied', 'Receipt proof must be synchronous');
    }
    const admitted: unknown = this.#host.admit(admission, proof);
    if (admitted !== undefined) {
      if (admitted instanceof Promise) void admitted.catch(() => undefined);
      throw new GraphError('permission_denied', 'Receipt admission must be synchronous');
    }
    let open = true,
      entered = false;
    try {
      const result = this.#host.fence(admission, proof, () => {
        if (
          !open ||
          entered ||
          !equalJSON(context(this.#host.current()), current) ||
          this.#journal.watermark !== view.watermark
        )
          throw new GraphError('permission_denied', 'Receipt fence changed');
        entered = true;
        this.#journal.assertWritable();
        return receipt;
      });
      if (!entered || result instanceof Promise || !equalJSON(result, receipt)) {
        if (result instanceof Promise) void result.catch(() => undefined);
        throw new GraphError('permission_denied', 'Receipt fence must return the original receipt');
      }
      return result;
    } finally {
      open = false;
    }
  }

  request(value: unknown): JSONObject {
    return this.boundary(() => {
      const request = ReleaseRequest.fromJSON(value);
      this.scope(request);
      const host = context(this.#host.current()),
        prior = this.#journal.getReceipt(host.actor_ref, request.idempotencyKey);
      const { state, view } = this.read();
      if (prior !== null) {
        if (prior.request_digest !== request.digest() || prior.graph_id !== request.graphID)
          throw new GraphError('idempotency_conflict', 'Actor/key accepted another operation');
        const result = releaseReceipt((prior.operation_result as JSONObject).inline);
        const id = releaseIdentity(result.release);
        if (
          id.graph_id !== request.graphID ||
          id.target_id !== request.targetID ||
          result.request_digest !== request.digest()
        )
          throw new GraphError('idempotency_conflict', 'Actor/key belongs to another operation');
        if (
          prior.status !== 'committed' ||
          prior.journal_seq !== result.journal_seq ||
          !state.release_operations.some(
            (operation) =>
              operation.status === 'requested' &&
              equalJSON(operation.release, result.release) &&
              operation.journal_seq === result.journal_seq &&
              operation.request_digest === request.digest(),
          )
        )
          throw new GraphError('journal_corrupt', 'Receipt has no matching durable release fact');
        return this.receiptRead(request, result, host, view);
      }
      const previous = this.desired(state),
        expected = previous?.release_epoch ?? '0';
      if (request.expectedDesiredEpoch !== expected)
        throw new GraphError('revision_conflict', 'Desired release epoch changed');
      const epoch = String(parseCounter(expected) + 1n);
      parseCounter(epoch);
      return this.authorize('release.request', request, view, (admission) => {
        if (!equalJSON(host, admission.context))
          throw new GraphError('permission_denied', 'Request identity changed');
        const release = { graph_id: this.graphID, target_id: this.targetID, release_epoch: epoch };
        const result = releaseReceipt({
          schema: 'contexture.release-receipt/v1',
          release,
          journal_seq: String(parseCounter(view.watermark) + 1n),
          request_digest: request.digest(),
          status: 'requested',
        });
        const events: JSONObject[] = [];
        if (previous !== undefined)
          events.push(
            freezeJSON({
              type: 'ReleaseSuperseded',
              release: { ...release, release_epoch: previous.release_epoch },
              superseded_by: epoch,
            }) as JSONObject,
          );
        events.push(
          freezeJSON({
            type: 'ReleaseRequested',
            request: request.asJSON(),
            release_epoch: epoch,
          }) as JSONObject,
        );
        const receipt = freezeJSON({
          schema: 'contexture.command-receipt/v1',
          graph_id: this.graphID,
          actor_ref: admission.context.actor_ref,
          idempotency_key: request.idempotencyKey,
          request_digest: request.digest(),
          revision: request.revision,
          journal_seq: result.journal_seq,
          status: 'committed',
          durability: this.#journal.durability,
          operation_result: { inline: result },
        }) as JSONObject;
        this.append(state, events, admission.context.actor_ref, receipt);
        return result;
      });
    });
  }

  capture(): CapturedRelease | undefined {
    return this.boundary(() => {
      const { state, view } = this.read(),
        desired = this.desired(state);
      if (desired === undefined) return undefined;
      const request = ReleaseRequest.fromJSON(desired.request);
      return this.authorize('release.status', request, view, (admission) => {
        const operation = state.release_operations.find(
          (op) =>
            op.status === 'requested' &&
            equalJSON(op.release, {
              graph_id: this.graphID,
              target_id: this.targetID,
              release_epoch: desired.release_epoch,
            }),
        );
        if (operation === undefined)
          throw new GraphError('journal_corrupt', 'Desired receipt absent');
        return Object.freeze({
          graph_id: this.graphID,
          target_id: this.targetID,
          release_epoch: desired.release_epoch as string,
          journal_seq: operation.journal_seq as string,
          snapshot: admission.history.snapshot,
          manifest_digest: request.manifestDigest,
        });
      });
    });
  }

  private requestFor(attempt: ServingAttempt, view: JournalHistoryView): ReleaseRequest {
    for (const record of view.records)
      for (const event of record.events as readonly JSONObject[]) {
        if (
          event.type !== 'ReleaseRequested' ||
          event.release_epoch !== attempt.release.release_epoch
        )
          continue;
        const request = ReleaseRequest.fromJSON(event.request);
        if (
          request.graphID === attempt.release.graph_id &&
          request.targetID === attempt.release.target_id
        ) {
          this.scope(request);
          if (
            record.journal_seq !== attempt.release.journal_seq ||
            request.revision !== attempt.release.snapshot.revision ||
            request.definitionDigest !== attempt.release.snapshot.definitionDigest ||
            request.manifestDigest !== attempt.release.manifest_digest
          )
            throw new GraphError(
              'contract_mismatch',
              'Captured release differs from journal facts',
            );
          return request;
        }
      }
    throw new GraphError('contract_mismatch', 'Captured release is not journaled');
  }
  private terminal(state: ReleaseState, attempt: ServingAttempt): JSONObject | undefined {
    const marker = identity(attempt);
    return state.prepare_attempt_history.find((item) => equalJSON(item.identity, marker));
  }

  servingProvider(provider: ServingPreparationProvider): ServingPreparationProvider {
    const prepare = provider.prepare.bind(provider);
    return Object.freeze({
      prepare: async (attempt: ServingAttempt, signal: AbortSignal | undefined) => {
        let ready: ReadyGeneration | undefined;
        try {
          this.boundary(() => {
            const { view } = this.read();
            this.authorize(
              'release.prepare',
              this.requestFor(attempt, view),
              view,
              () => undefined,
            );
          });
          ready = await prepare(attempt, signal);
          if (
            !ReadyGeneration.isReady(ready) ||
            ready.context.generation_uuid !== attempt.generation_uuid
          ) {
            ready = undefined;
            throw new GraphError(
              'contract_mismatch',
              'Provider returned a generation it does not own',
            );
          }
          signal?.throwIfAborted();
          const candidate = ready;
          this.boundary(() => {
            const { state, view } = this.read(),
              request = this.requestFor(attempt, view);
            this.authorize('release.prepare', request, view, (admission) => {
              if (
                candidate.context.graph_id !== this.graphID ||
                candidate.context.revision !== request.revision ||
                candidate.plan.definitionDigest !== request.definitionDigest ||
                candidate.plan.manifest.manifestDigest !== request.manifestDigest ||
                candidate.resourceState !== 'prepared'
              )
                throw new GraphError(
                  'contract_mismatch',
                  'Prepared generation differs from accepted intent',
                );
              this.append(
                state,
                [
                  freezeJSON({
                    type: 'ReleasePreparationSucceeded',
                    attempt: identity(attempt),
                    generation_id: attempt.generation_uuid,
                    manifest_digest: request.manifestDigest,
                  }) as JSONObject,
                ],
                admission.context.actor_ref,
              );
            });
          });
          this.#ready.set(attempt, candidate);
          return candidate;
        } catch (original) {
          const errors: unknown[] = [original];
          if (!this.#frozen) {
            try {
              this.boundary(() => {
                const { state, view } = this.read();
                if (this.terminal(state, attempt) !== undefined) return;
                this.authorize(
                  'release.prepare',
                  this.requestFor(attempt, view),
                  view,
                  (admission) => {
                    this.append(
                      state,
                      [
                        freezeJSON({
                          type: 'ReleasePreparationFailed',
                          attempt: identity(attempt),
                          diagnostics: [
                            {
                              code: 'preparation_failed',
                              location: '',
                              message: 'Local preparation did not publish',
                            },
                          ],
                        }) as JSONObject,
                      ],
                      admission.context.actor_ref,
                    );
                  },
                  true,
                );
              });
            } catch (factError) {
              errors.push(factError);
            }
          }
          if (ready !== undefined) {
            try {
              await ready.retire();
            } catch (cleanup) {
              errors.push(cleanup);
            }
          }
          if (errors.length > 1)
            throw new AggregateError(errors, 'Preparation and durable cleanup failed', {
              cause: original,
            });
          throw original;
        }
      },
    });
  }

  fence(attempt: ServingAttempt, ready: ReadyGeneration, adopt: () => void): boolean {
    return this.boundary(() => {
      const { state, view } = this.read(),
        request = this.requestFor(attempt, view),
        desired = this.desired(state);
      const terminal = this.terminal(state, attempt);
      if (
        this.#ready.get(attempt) !== ready ||
        ready.resourceState !== 'prepared' ||
        terminal?.status !== 'ready' ||
        terminal.generation_id !== attempt.generation_uuid ||
        ready.context.generation_uuid !== attempt.generation_uuid
      )
        throw new GraphError('contract_mismatch', 'Durable ready provenance absent');
      if (
        desired?.release_epoch !== attempt.release.release_epoch ||
        !equalJSON(desired.request, request.asJSON())
      )
        return false;
      return this.authorize('release.swap', request, view, () => {
        adopt();
        this.#adopted.add(attempt);
        return true;
      });
    });
  }

  observe(attempt: ServingAttempt): void {
    this.boundary(() => {
      if (!this.#adopted.has(attempt) || this.#ready.get(attempt)?.resourceState !== 'prepared')
        throw new GraphError('permission_denied', 'No real local adoption for this observation');
      const { state, view } = this.read(),
        request = this.requestFor(attempt, view),
        terminal = this.terminal(state, attempt);
      if (terminal?.status !== 'ready' || terminal.generation_id !== attempt.generation_uuid)
        throw new GraphError('contract_mismatch', 'Observation has no durable ready provenance');
      this.authorize('release.observe', request, view, (admission) => {
        if (this.#ready.get(attempt)?.resourceState !== 'prepared')
          throw new GraphError('permission_denied', 'Local generation is no longer serving');
        const observation = freezeJSON({
          release: identity(attempt).release,
          instance_id: attempt.instance_id,
          boot_id: attempt.boot_id,
          generation_id: attempt.generation_uuid,
          revision: request.revision,
          definition_digest: request.definitionDigest,
          manifest_digest: request.manifestDigest,
        }) as JSONObject;
        if (
          state.observations_history.some((item) =>
            Object.entries(observation).every(([key, value]) => equalJSON(item[key], value)),
          )
        )
          return;
        this.append(
          state,
          [
            freezeJSON({
              type: 'ReplicaObserved',
              observation: { ...observation, observed_at: new Date().toISOString() },
            }) as JSONObject,
          ],
          admission.context.actor_ref,
        );
      });
    });
  }

  /** Rebind only a recovered same-store journal extending the confirmed hash prefix.
   * Caller closes/reopens physical custody first. This never reconstructs a serving pointer.
   */
  recover(journal: FileJournal): void {
    this.boundary(() => {
      journal.assertWritable();
      const records = journal.records();
      if (
        journal.meta.store_id !== this.#storeID ||
        parseCounter(journal.watermark) < parseCounter(this.#confirmedSequence) ||
        (this.#confirmedSequence !== '0' &&
          records[Number(parseCounter(this.#confirmedSequence)) - 1]?.record_hash !==
            this.#confirmedHash)
      )
        throw new GraphError(
          'contract_mismatch',
          'Recovered store origin or confirmed prefix differs',
        );
      replayReleases(freezeJSON(records) as readonly JSONObject[]);
      this.#journal = journal;
      this.read();
      this.#frozen = false;
    }, true);
  }
}
