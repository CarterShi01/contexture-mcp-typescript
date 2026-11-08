/** Local resource ownership, not authorization or a wire resource factory ABI. */
import { GraphError, parseCounter, validateID } from '../core/graph/canonical.js';
import type { ResolvedBinding } from '../core/graph/bindings.js';
import { StructuralPlan } from '../core/graph/compiler.js';
import { ManagedReference } from '../core/graph/references.js';

export interface PreparationContext {
  readonly graph_id: string;
  readonly revision: string;
  readonly generation_uuid: string;
}

export interface PreparedResource {
  readonly handle: unknown;
  dispose(): void | Promise<void>;
}

export interface PreparationAdapterRegistration {
  readonly binding_id: string;
  readonly version: string;
  readonly abi: string;
  readonly contract_digest: string;
  /** Acquisition must unwind its own partial failure. Resources are generation-exclusive. */
  acquire(
    binding: ResolvedBinding,
    nodeID: string,
    context: PreparationContext,
  ): PreparedResource | Promise<PreparedResource>;
}

function invalid(message: string): never {
  throw new GraphError('resource_preparation_invalid', message);
}

function aborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

const lifetimeToken = Symbol('generation lifetime');

class Resources {
  state: 'prepared' | 'draining' | 'retired' | 'cleanup_failed' = 'prepared';
  readonly handles = new Map<string, unknown>();
  readonly disposers: (() => void | Promise<void>)[] = [];
  leases = 0;
  retirement: Promise<void> | undefined;
  private idle: (() => void) | undefined;

  acquire(): ResourceLease {
    this.leases++;
    return new ResourceLease(lifetimeToken, this, () => {
      if (--this.leases === 0) this.idle?.();
    });
  }

  retire(): Promise<void> {
    if (this.retirement !== undefined) return this.retirement;
    this.state = 'draining';
    this.retirement = this.close();
    return this.retirement;
  }

  private async close(): Promise<void> {
    // Retirement changes admission synchronously, but disposal never runs in its gate.
    await Promise.resolve();
    if (this.leases !== 0)
      await new Promise<void>((resolve) => {
        this.idle = resolve;
      });
    const errors: unknown[] = [];
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.handles.clear();
    this.state = errors.length ? 'cleanup_failed' : 'retired';
    if (errors.length) throw new AggregateError(errors, 'Generation resource cleanup failed');
  }
}

/** Entered lease; release only after all resource-using work has actually settled. */
export class ResourceLease {
  #closed = false;
  readonly #resources: Resources;
  readonly #release: () => void;
  constructor(token: symbol, resources: Resources, release: () => void) {
    if (token !== lifetimeToken) invalid('Use generation lease admission');
    this.#resources = resources;
    this.#release = release;
    Object.freeze(this);
  }
  handle(nodeID: string): unknown {
    if (this.#closed || !this.#resources.handles.has(nodeID)) invalid('Resource lease unavailable');
    return this.#resources.handles.get(nodeID);
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#release();
    }
  }
}

/** Retention is lifetime routing only; children still require current authorization. */
export class RetainedGeneration {
  #closed = false;
  readonly #keeper: ResourceLease;
  readonly #resources: Resources;
  constructor(token: symbol, resources: Resources) {
    if (token !== lifetimeToken) invalid('Use generation retention admission');
    this.#resources = resources;
    this.#keeper = resources.acquire();
    Object.freeze(this);
  }
  lease(): ResourceLease {
    if (this.#closed || !['prepared', 'draining'].includes(this.#resources.state))
      invalid('Retention capability is closed');
    return this.#resources.acquire();
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#keeper.close();
    }
  }
}

const readyToken = Symbol('prepared generation');
const readyGenerations = new WeakSet<ReadyGeneration>();

export class ReadyGeneration {
  readonly #resources: Resources;
  private constructor(
    token: symbol,
    readonly plan: StructuralPlan,
    readonly context: PreparationContext,
    resources: Resources,
  ) {
    if (token !== readyToken) invalid('Use prepareGeneration');
    this.#resources = resources;
    readyGenerations.add(this);
    Object.freeze(this);
  }

  static isReady(value: unknown): value is ReadyGeneration {
    return (
      typeof value === 'object' && value !== null && readyGenerations.has(value as ReadyGeneration)
    );
  }

  static async prepare(
    plan: StructuralPlan,
    context: PreparationContext,
    adapters: Readonly<Record<string, PreparationAdapterRegistration>>,
    signal?: AbortSignal,
  ): Promise<ReadyGeneration> {
    if (!StructuralPlan.isCompiled(plan)) invalid('Expected a compiled structural plan');
    const pinned = Object.freeze({
      graph_id: validateID(context.graph_id),
      revision: context.revision,
      generation_uuid: new ManagedReference(context.graph_id, context.generation_uuid, 'probe')
        .generationUUID,
    });
    parseCounter(pinned.revision);
    if (pinned.graph_id !== plan.definition.graph_id)
      invalid('Preparation graph identity mismatch');
    const order = plan.index.preorder.filter((id) => Object.hasOwn(plan.bindings, id));
    if (
      Object.keys(adapters).length !== order.length ||
      Object.keys(adapters).some((id) => !Object.hasOwn(plan.bindings, id))
    )
      invalid('Preparation adapters must match resolved binding nodes exactly');
    // Capture every method and attestation before the first effect or await.
    const captured = order.map((id) => {
      const adapter = adapters[id];
      const binding = plan.bindings[id]!;
      const descriptor = binding.registration.descriptor;
      if (
        adapter === undefined ||
        adapter.binding_id !== descriptor.binding_id ||
        adapter.version !== descriptor.version ||
        adapter.abi !== binding.entry.abi ||
        adapter.contract_digest !== binding.entry.contract_digest ||
        typeof adapter.acquire !== 'function'
      )
        invalid('Preparation adapter does not support the exact pinned ABI/contract');
      return { id, binding, acquire: adapter.acquire.bind(adapter) };
    });
    const resources = new Resources();
    try {
      for (const { id, binding, acquire } of captured) {
        aborted(signal);
        // Never race acquisition against cancellation: success transfers ownership first.
        const resource = await acquire(binding, id, pinned);
        if (
          resource === null ||
          typeof resource !== 'object' ||
          typeof resource.dispose !== 'function'
        )
          invalid('Preparation must return an owned resource with an explicit disposer');
        const dispose = resource.dispose.bind(resource);
        resources.disposers.push(dispose);
        resources.handles.set(id, resource.handle);
        aborted(signal);
      }
      aborted(signal);
      return new ReadyGeneration(readyToken, plan, pinned, resources);
    } catch (original) {
      try {
        await resources.retire();
      } catch (cleanup) {
        throw new AggregateError([original, cleanup], 'Preparation and cleanup failed', {
          cause: cleanup,
        });
      }
      throw original;
    }
  }

  get resourceState(): Resources['state'] {
    return this.#resources.state;
  }
  lease(): ResourceLease {
    if (this.#resources.state !== 'prepared') invalid('Generation is draining or retired');
    return this.#resources.acquire();
  }
  retain(): RetainedGeneration {
    if (this.#resources.state !== 'prepared') invalid('Generation is draining or retired');
    return new RetainedGeneration(lifetimeToken, this.#resources);
  }
  retire(): Promise<void> {
    return this.#resources.retire();
  }
}

export const prepareGeneration = ReadyGeneration.prepare;
