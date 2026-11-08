/** Single-process serving. Durable intent acceptance belongs to the owner/journal port. */
import { randomUUID } from 'node:crypto';
import { GraphError, parseCounter, validateID } from '../core/graph/canonical.js';
import { contractDigest } from '../core/graph/bindings.js';
import { RevisionState } from '../core/graph/events.js';
import { ReadyGeneration } from './managed-generation.js';
import type { ResourceLease } from './managed-generation.js';

export interface CapturedRelease {
  readonly graph_id: string;
  readonly target_id: string;
  readonly release_epoch: string;
  readonly journal_seq: string;
  readonly snapshot: RevisionState;
  readonly manifest_digest: string;
}

export interface ServingAttempt {
  readonly release: CapturedRelease;
  readonly instance_id: string;
  readonly boot_id: string;
  readonly attempt_id: string;
  readonly generation_uuid: string;
}

export interface ReleaseAuthority {
  /** Return ONLY a committed desired watermark and retained verified historical state. */
  capture(): CapturedRelease | undefined;
  /**
   * Synchronously recheck current admission, approvals, registry/manifest and desired
   * epoch under the SAME owner boundary as adopt(). No await, I/O or business effects.
   * Must not call adopt if any proof is stale. Return false for superseded intent.
   */
  fence(attempt: ServingAttempt, ready: ReadyGeneration, adopt: () => void): boolean;
}

export interface ServingPreparationProvider {
  /** Compile exact captured history against current trusted registry, then prepare. */
  prepare(attempt: ServingAttempt, signal: AbortSignal | undefined): Promise<ReadyGeneration>;
}

export interface ServingObservationPort {
  /** Outside the pointer gate. Return only after a durable matching observation. */
  observe(attempt: ServingAttempt): void | Promise<void>;
}

export interface ServingGeneration {
  readonly generation: ReadyGeneration;
  readonly attempt: ServingAttempt;
}

export interface ServingLease extends ServingGeneration {
  readonly resources: ResourceLease;
}

export interface LocalServingResult {
  readonly attempt: ServingAttempt;
  readonly status: 'serving' | 'local_observed' | 'serving_unobserved' | 'superseded' | 'failed';
  readonly error?: unknown;
}

const claimedGenerations = new WeakSet<ReadyGeneration>();

export class LocalServingCoordinator {
  readonly graphID: string;
  readonly targetID: string;
  readonly instanceID: string;
  readonly bootID = randomUUID();
  readonly #authority: ReleaseAuthority;
  readonly #provider: ServingPreparationProvider;
  readonly #observation: ServingObservationPort | undefined;
  readonly #maxPreparations: number;
  readonly #maxRetirements: number;
  readonly #preparing = new Set<Promise<LocalServingResult>>();
  readonly #retiring = new Set<Promise<void>>();
  readonly #errors: unknown[] = [];
  #active: ServingGeneration | undefined;
  #highestEpoch = 0n;
  #highestSequence = 0n;
  #watermark: CapturedRelease | undefined;
  #closed = false;
  #shutdown: Promise<void> | undefined;
  #pendingObservation: ServingAttempt | undefined;
  #observing: Promise<LocalServingResult> | undefined;

  constructor(options: {
    graphID: string;
    targetID: string;
    instanceID: string;
    authority: ReleaseAuthority;
    provider: ServingPreparationProvider;
    observation?: ServingObservationPort;
    maxPreparations?: number;
    maxRetirements?: number;
  }) {
    this.graphID = validateID(options.graphID);
    this.targetID = validateID(options.targetID);
    this.instanceID = validateID(options.instanceID);
    this.#authority = Object.freeze({
      capture: options.authority.capture.bind(options.authority),
      fence: options.authority.fence.bind(options.authority),
    });
    this.#provider = Object.freeze({
      prepare: options.provider.prepare.bind(options.provider),
    });
    this.#observation =
      options.observation === undefined
        ? undefined
        : Object.freeze({
            observe: options.observation.observe.bind(options.observation),
          });
    this.#maxPreparations = options.maxPreparations ?? 2;
    this.#maxRetirements = options.maxRetirements ?? 8;
    if (
      [this.#maxPreparations, this.#maxRetirements].some((n) => !Number.isSafeInteger(n) || n < 1)
    )
      throw new RangeError('Positive preparation and retirement capacities are required');
    Object.freeze(this);
  }

  get closed(): boolean {
    return this.#closed;
  }
  get current(): ServingGeneration | undefined {
    return this.#active;
  }
  get cleanupErrors(): readonly unknown[] {
    return Object.freeze([...this.#errors]);
  }
  get counts(): Readonly<{ preparing: number; retiring: number; active: number }> {
    return Object.freeze({
      preparing: this.#preparing.size,
      retiring: this.#retiring.size,
      active: Number(this.#active !== undefined),
    });
  }

  private capture(): CapturedRelease {
    const value = this.#authority.capture();
    if (value === undefined) throw new GraphError('not_ready', 'No committed desired release');
    if (
      value.graph_id !== this.graphID ||
      value.target_id !== this.targetID ||
      !(value.snapshot instanceof RevisionState) ||
      value.snapshot.definition.graph_id !== this.graphID
    )
      throw new GraphError('contract_mismatch', 'Desired release coordinates differ');
    const epoch = parseCounter(value.release_epoch);
    const sequence = parseCounter(value.journal_seq);
    if (
      epoch === 0n ||
      sequence === 0n ||
      epoch < this.#highestEpoch ||
      sequence < this.#highestSequence
    )
      throw new GraphError('contract_mismatch', 'Desired release watermark regressed');
    if (
      epoch === this.#highestEpoch &&
      this.#watermark !== undefined &&
      !sameRelease(value, this.#watermark)
    )
      throw new GraphError('contract_mismatch', 'Committed desired epoch was rewritten');
    contractDigest(value.manifest_digest);
    this.#highestEpoch = epoch;
    this.#highestSequence = sequence;
    this.#watermark = Object.freeze({
      graph_id: value.graph_id,
      target_id: value.target_id,
      release_epoch: value.release_epoch,
      journal_seq: value.journal_seq,
      snapshot: value.snapshot,
      manifest_digest: value.manifest_digest,
    });
    return this.#watermark;
  }

  prepare(signal?: AbortSignal): Promise<LocalServingResult> {
    if (
      this.#closed ||
      this.#pendingObservation !== undefined ||
      this.#errors.length > 0 ||
      this.#preparing.size >= this.#maxPreparations ||
      this.#retiring.size + this.#preparing.size >= this.#maxRetirements
    )
      throw new GraphError('resource_busy', 'Serving preparation capacity unavailable');
    signal?.throwIfAborted();
    const release = this.capture();
    if (this.#closed) throw new GraphError('resource_busy', 'Serving coordinator is closed');
    const attempt = Object.freeze({
      release,
      instance_id: this.instanceID,
      boot_id: this.bootID,
      attempt_id: randomUUID(),
      generation_uuid: randomUUID(),
    });
    // Defer provider code until the preparation has been registered for shutdown.
    const task = Promise.resolve().then(() => this.run(attempt, signal));
    this.#preparing.add(task);
    void task.then(
      () => this.#preparing.delete(task),
      () => this.#preparing.delete(task),
    );
    return task;
  }

  private retire(generation: ReadyGeneration): void {
    const cleanup = generation.retire();
    this.#retiring.add(cleanup);
    void cleanup.then(
      () => this.#retiring.delete(cleanup),
      (error) => {
        this.#errors.push(error);
        this.#retiring.delete(cleanup);
      },
    );
  }

  private async run(
    attempt: ServingAttempt,
    signal: AbortSignal | undefined,
  ): Promise<LocalServingResult> {
    let ready: ReadyGeneration | undefined;
    let adopted = false;
    try {
      ready = await this.#provider.prepare(attempt, signal);
      if (!ReadyGeneration.isReady(ready) || claimedGenerations.has(ready)) {
        ready = undefined;
        throw new GraphError(
          'contract_mismatch',
          'Preparation must return a fresh owned generation',
        );
      }
      claimedGenerations.add(ready);
      signal?.throwIfAborted();
      const release = attempt.release;
      if (
        ready.resourceState !== 'prepared' ||
        ready.context.graph_id !== this.graphID ||
        ready.context.revision !== release.snapshot.revision ||
        ready.context.generation_uuid !== attempt.generation_uuid ||
        ready.plan.definitionDigest !== release.snapshot.definitionDigest ||
        ready.plan.manifest.manifestDigest !== release.manifest_digest
      )
        throw new GraphError(
          'contract_mismatch',
          'Prepared generation does not match captured release',
        );
      if (this.#closed) return Object.freeze({ attempt, status: 'superseded' });
      const latest = this.capture();
      if (!sameRelease(latest, release)) return Object.freeze({ attempt, status: 'superseded' });
      const candidate = ready;
      let gateOpen = true;
      let accepted: unknown;
      try {
        accepted = this.#authority.fence(attempt, ready, () => {
          if (!gateOpen || adopted)
            throw new GraphError('contract_mismatch', 'Release adoption capability is closed');
          // No await, I/O, resource acquisition or cleanup in the pointer/lease gate.
          signal?.throwIfAborted();
          if (
            this.#closed ||
            this.#pendingObservation !== undefined ||
            this.#highestEpoch > parseCounter(release.release_epoch)
          )
            throw new GraphError('contract_mismatch', 'Desired release changed at adoption');
          const old = this.#active;
          this.#active = Object.freeze({ generation: candidate, attempt });
          adopted = true;
          if (this.#observation !== undefined) this.#pendingObservation = attempt;
          if (old !== undefined) this.retire(old.generation);
        });
      } finally {
        gateOpen = false;
      }
      if (typeof accepted !== 'boolean') {
        if (accepted instanceof Promise) void accepted.catch(() => undefined);
        throw new GraphError('contract_mismatch', 'Release fence must complete synchronously');
      }
      if (!accepted && adopted)
        throw new GraphError('contract_mismatch', 'Release fence violated adoption contract');
      if (adopted && this.#observation !== undefined) return await this.retryObservation();
      return Object.freeze({ attempt, status: adopted ? 'serving' : 'superseded' });
    } catch (error) {
      // An already swapped pointer must never be reported as a failed preparation.
      if (adopted)
        return Object.freeze({
          attempt,
          status: this.#observation === undefined ? 'serving' : 'serving_unobserved',
          error,
        });
      return Object.freeze({ attempt, status: 'failed', error });
    } finally {
      if (ready !== undefined && !adopted) this.retire(ready);
    }
  }

  /** Retry only a real local pointer's pending observation; never reconstruct from replay. */
  retryObservation(): Promise<LocalServingResult> {
    if (this.#observing !== undefined) return this.#observing;
    if (this.#closed) throw new GraphError('not_ready', 'Serving coordinator is closed');
    const attempt = this.#pendingObservation;
    if (attempt === undefined) {
      if (this.#active === undefined)
        throw new GraphError('not_ready', 'No local serving generation');
      return Promise.resolve(
        Object.freeze({
          attempt: this.#active.attempt,
          status: this.#observation === undefined ? 'serving' : 'local_observed',
        }),
      );
    }
    const observation = this.#observation;
    if (observation === undefined)
      throw new GraphError('contract_mismatch', 'Observation port absent');
    const task = Promise.resolve().then(async (): Promise<LocalServingResult> => {
      try {
        await observation.observe(attempt);
        if (this.#pendingObservation === attempt) this.#pendingObservation = undefined;
        return Object.freeze({ attempt, status: 'local_observed' });
      } catch (error) {
        return Object.freeze({ attempt, status: 'serving_unobserved', error });
      }
    });
    this.#observing = task;
    void task.then(() => {
      if (this.#observing === task) this.#observing = undefined;
    });
    return task;
  }

  lease(): ServingLease {
    if (this.#closed || this.#active === undefined)
      throw new GraphError('not_ready', 'No local serving generation');
    const active = this.#active;
    return Object.freeze({ ...active, resources: active.generation.lease() });
  }

  /** Stops new admission synchronously, then joins real preparations and retirement. */
  shutdown(): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#closed = true;
    const active = this.#active;
    this.#active = undefined;
    if (active !== undefined) this.retire(active.generation);
    this.#shutdown = (async () => {
      await Promise.allSettled([...this.#preparing]);
      if (this.#observing !== undefined) await this.#observing;
      while (this.#retiring.size) await Promise.allSettled([...this.#retiring]);
      if (this.#errors.length)
        throw new AggregateError(this.#errors, 'Serving shutdown cleanup failed');
    })();
    return this.#shutdown;
  }
}

function sameRelease(left: CapturedRelease, right: CapturedRelease): boolean {
  return (
    left.graph_id === right.graph_id &&
    left.target_id === right.target_id &&
    left.release_epoch === right.release_epoch &&
    left.journal_seq === right.journal_seq &&
    left.snapshot.revision === right.snapshot.revision &&
    left.snapshot.definitionDigest === right.snapshot.definitionDigest &&
    left.manifest_digest === right.manifest_digest
  );
}
