/** Opaque boot-local run pins, not credentials, approvals, Tasks or a wire token ABI. */
import { randomBytes } from 'node:crypto';
import { GraphError } from '../core/graph/canonical.js';
import { ManagedRuntime } from './managed-runtime.js';
import type { ManagedRequest, ManagedRequestOptions, ManagedRunPin } from './managed-runtime.js';

interface Run {
  pin: ManagedRunPin;
  expires: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const handles = new WeakMap<
  RunLeaseContext,
  Readonly<{ service: RunLeaseService; token: string }>
>();

export class RunLeaseContext {
  private constructor() {
    Object.freeze(this);
  }
  static issue(service: RunLeaseService, token: string): RunLeaseContext {
    const envelope = new RunLeaseContext();
    handles.set(envelope, Object.freeze({ service, token }));
    return envelope;
  }
  toJSON(): never {
    throw new TypeError('Run lease contexts cannot be serialized');
  }
}

export class RunLeaseService {
  readonly #runs = new Map<string, Run>();
  readonly #runtime: ManagedRuntime;
  readonly #maxRuns: number;
  readonly #maxTTL: number;
  readonly #clock: () => number;
  readonly #automaticExpiry: boolean;
  #pending = 0;
  #closed = false;
  #shutdown: Promise<void> | undefined;
  readonly #operations = new Set<Promise<unknown>>();

  constructor(
    runtime: ManagedRuntime,
    options: {
      maxRuns?: number;
      maxTTL?: number;
      /** Monotonic milliseconds. Custom clocks require explicit sweep(). */
      clock?: () => number;
    } = {},
  ) {
    this.#runtime = runtime;
    this.#maxRuns = options.maxRuns ?? 128;
    this.#maxTTL = options.maxTTL ?? 300_000;
    if (
      !Number.isSafeInteger(this.#maxRuns) ||
      this.#maxRuns < 1 ||
      !Number.isFinite(this.#maxTTL) ||
      this.#maxTTL <= 0 ||
      this.#maxTTL > 2_147_483_647
    )
      throw new RangeError('Positive bounded run capacity and maximum TTL are required');
    this.#clock = options.clock ?? (() => performance.now());
    this.#automaticExpiry = options.clock === undefined;
  }

  get counts(): Readonly<{ runs: number; pending: number }> {
    return Object.freeze({ runs: this.#runs.size, pending: this.#pending });
  }
  get requiresExplicitSweep(): boolean {
    return !this.#automaticExpiry;
  }
  isFor(runtime: ManagedRuntime): boolean {
    return this.#runtime === runtime;
  }

  private duration(ttl: number): number {
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > this.#maxTTL)
      throw new RangeError('Run TTL outside configured bounds');
    return ttl;
  }

  private drop(token: string): void {
    const run = this.#runs.get(token);
    if (run === undefined) return;
    this.#runs.delete(token);
    if (run.timer !== undefined) clearTimeout(run.timer);
    run.pin.keeper.close();
  }

  sweep(): number {
    let count = 0;
    for (const [token, run] of this.#runs)
      if (this.#clock() >= run.expires) {
        this.drop(token);
        count++;
      }
    return count;
  }

  private arm(token: string, run: Run): void {
    if (run.timer !== undefined) clearTimeout(run.timer);
    if (!this.#automaticExpiry) return;
    run.timer = setTimeout(
      () => {
        if (this.#runs.get(token) !== run) return;
        if (this.#clock() >= run.expires) this.drop(token);
        else this.arm(token, run);
      },
      Math.max(1, run.expires - this.#clock()),
    );
    run.timer.unref();
  }

  private validate(envelope: RunLeaseContext): Readonly<{ token: string; run: Run }> {
    const data = handles.get(envelope);
    const run = data?.service === this ? this.#runs.get(data.token) : undefined;
    const identity = this.#runtime.currentIdentity();
    if (
      run === undefined ||
      data === undefined ||
      this.#closed ||
      this.#runtime.coordinator.closed ||
      identity.actor_id !== run.pin.identity.actor_id ||
      identity.tenant_id !== run.pin.identity.tenant_id
    )
      throw new GraphError('permission_denied', 'Run lease unavailable');
    if (this.#clock() >= run.expires) {
      this.drop(data.token);
      throw new GraphError('permission_denied', 'Run lease unavailable');
    }
    return { token: data.token, run };
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    let resolve: (value: T) => void = () => {
      throw new Error('Operation not initialized');
    };
    let reject: (error: unknown) => void = () => {
      throw new Error('Operation not initialized');
    };
    const task = new Promise<T>((success, failure) => {
      resolve = success;
      reject = failure;
    });
    this.#operations.add(task);
    void task.then(
      () => this.#operations.delete(task),
      () => this.#operations.delete(task),
    );
    try {
      void operation().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return task;
  }

  create(ttl: number, options: ManagedRequestOptions = {}): Promise<RunLeaseContext> {
    const duration = this.duration(ttl);
    this.sweep();
    if (this.#closed || this.#runs.size + this.#pending >= this.#maxRuns)
      throw new GraphError('resource_busy', 'Run lease capacity unavailable');
    this.#pending++;
    return this.track(async () => {
      let pin: ManagedRunPin | undefined;
      try {
        pin = await this.#runtime.createPin(options);
        if (this.#closed || this.#runtime.coordinator.closed)
          throw new GraphError('permission_denied', 'Run lease service is closed');
        let token = randomBytes(32).toString('base64url');
        while (this.#runs.has(token)) token = randomBytes(32).toString('base64url');
        const run: Run = { pin, expires: this.#clock() + duration, timer: undefined };
        this.#runs.set(token, run);
        this.arm(token, run);
        pin = undefined;
        return RunLeaseContext.issue(this, token);
      } finally {
        pin?.keeper.close();
        this.#pending--;
      }
    });
  }

  renew(envelope: RunLeaseContext, ttl: number): Promise<RunLeaseContext> {
    const duration = this.duration(ttl);
    const { token, run } = this.validate(envelope);
    const original = run.pin;
    return this.track(async () => {
      const ceiling = await this.#runtime.authorize(
        original.identity,
        'run.renew',
        original.ceiling,
      );
      if (this.validate(envelope).run !== run || run.pin !== original)
        throw new GraphError('permission_denied', 'Run lease changed during renewal');
      run.pin = Object.freeze({
        ...run.pin,
        ceiling: Object.freeze(run.pin.ceiling.filter((id) => ceiling.includes(id))),
      });
      run.expires = this.#clock() + duration;
      this.arm(token, run);
      return envelope;
    });
  }

  /** Upgrade is explicit and atomic for future children; entered requests keep the old pin. */
  upgrade(envelope: RunLeaseContext, ttl: number, signal?: AbortSignal): Promise<RunLeaseContext> {
    const duration = this.duration(ttl);
    const { token, run } = this.validate(envelope);
    const original = run.pin;
    return this.track(async () => {
      const candidate = await this.#runtime.createPin({
        selection: original.anchors,
        ...(original.publicationAnchors === undefined
          ? {}
          : { publicationSelection: original.publicationAnchors }),
        ...(signal === undefined ? {} : { signal }),
      });
      let adopted = false;
      try {
        if (this.validate(envelope).run !== run || run.pin !== original)
          throw new GraphError('permission_denied', 'Run lease changed during upgrade');
        const ceiling = Object.freeze(
          candidate.ceiling.filter((id) => original.ceiling.includes(id)),
        );
        run.pin = Object.freeze({ ...candidate, ceiling });
        run.expires = this.#clock() + duration;
        this.arm(token, run);
        adopted = true;
        original.keeper.close();
        return envelope;
      } finally {
        if (!adopted) candidate.keeper.close();
      }
    });
  }

  request<T>(
    envelope: RunLeaseContext,
    action: (request: ManagedRequest) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const { run } = this.validate(envelope);
    return this.track(() => this.#runtime.pinnedRequest(run.pin, action, signal));
  }

  release(envelope: RunLeaseContext): void {
    const { token } = this.validate(envelope);
    this.drop(token);
  }

  shutdown(): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#closed = true;
    for (const token of this.#runs.keys()) this.drop(token);
    this.#shutdown = Promise.allSettled([...this.#operations]).then(() => undefined);
    return this.#shutdown;
  }
}
