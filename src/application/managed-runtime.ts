/** SDK-neutral request pinning. Context and authority ports are trusted Host inputs. */
import { GraphError, freezeJSON, thawJSON, validateID } from '../core/graph/canonical.js';
import type { FrozenJSON } from '../core/graph/canonical.js';
import type { ManagedIdentity } from '../core/graph/bindings.js';
import type { GraphIndex } from '../core/graph/index.js';
import type { JSONObject } from '../core/graph/model.js';
import { placements } from '../core/graph/model.js';
import type { Publication } from '../core/graph/model.js';
import { ManagedReference, parseReference } from '../core/graph/references.js';
import type { RetainedGeneration } from './managed-generation.js';
import { LocalServingCoordinator } from './managed-serving.js';
import type { ServingGeneration, ServingLease } from './managed-serving.js';

export interface RequestAuthorization {
  readonly identity: ManagedIdentity;
  readonly currentIndex: GraphIndex;
  readonly operation: string;
  readonly requestedIDs: readonly string[];
}

export interface RequestAuthority {
  /** Attests CURRENT policy for these stable IDs at return, not a cached grant. */
  verify(request: RequestAuthorization): Promise<readonly string[]>;
}

export interface ManagedRequestOptions {
  /** Stable subtree anchors, expanded once in the pinned graph; not business arguments. */
  readonly selection?: readonly string[];
  /** Explicit trusted publication-plane anchors; never inferred from caller JSON. */
  readonly publicationSelection?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ManagedRunPin extends ServingGeneration {
  readonly identity: ManagedIdentity;
  readonly anchors: readonly string[];
  readonly publicationAnchors?: readonly string[];
  readonly ceiling: readonly string[];
  readonly keeper: RetainedGeneration;
}

function denied(): never {
  throw new GraphError('permission_denied', 'Current request authority is unavailable');
}

function sameIdentity(left: ManagedIdentity, right: ManagedIdentity): boolean {
  return left.actor_id === right.actor_id && left.tenant_id === right.tenant_id;
}

function sameContext(left: ManagedIdentity, right: ManagedIdentity): boolean {
  return sameIdentity(left, right) && left.authority_revision === right.authority_revision;
}

export class ManagedRuntime {
  readonly #context: () => ManagedIdentity;
  readonly #verify: RequestAuthority['verify'];
  constructor(
    readonly coordinator: LocalServingCoordinator,
    contexts: { current(): ManagedIdentity },
    authority: RequestAuthority,
  ) {
    this.#context = contexts.current.bind(contexts);
    this.#verify = authority.verify.bind(authority);
    Object.freeze(this);
  }

  currentIdentity(): ManagedIdentity {
    const identity = this.#context();
    return Object.freeze({
      actor_id: validateID(identity.actor_id),
      tenant_id: validateID(identity.tenant_id),
      authority_revision: validateID(identity.authority_revision),
    });
  }

  async authorize(
    identity: ManagedIdentity,
    operation: string,
    requested: readonly string[],
  ): Promise<readonly string[]> {
    return this.withAuthorization(identity, operation, requested, (allowed) => allowed);
  }

  async withAuthorization<T>(
    identity: ManagedIdentity,
    operation: string,
    requested: readonly string[],
    dispatch: (allowed: readonly string[], context: ManagedIdentity) => T | Promise<T>,
  ): Promise<T> {
    const before = this.currentIdentity();
    if (!sameIdentity(identity, before)) denied();
    const active = this.coordinator.current;
    if (this.coordinator.closed || active === undefined)
      throw new GraphError('not_ready', 'No current generation for policy verification');
    const ids = Object.freeze([...new Set(requested)]);
    const allowed = await this.#verify(
      Object.freeze({
        identity: before,
        currentIndex: active.generation.plan.index,
        operation,
        requestedIDs: ids,
      }),
    );
    // Fail closed on any context/pointer movement across external authorization awaits.
    if (
      this.coordinator.closed ||
      this.coordinator.current !== active ||
      !sameContext(before, this.currentIdentity())
    )
      denied();
    if (!Array.isArray(allowed) || allowed.some((id) => typeof id !== 'string')) denied();
    const accepted = new Set(allowed);
    const filtered = Object.freeze(
      ids.filter(
        (id) => accepted.has(id) && Object.hasOwn(active.generation.plan.definition.nodes, id),
      ),
    );
    // Dispatch synchronously at the authority return fence, before any other await.
    return dispatch(filtered, before);
  }

  private selection(
    lease: ServingGeneration,
    anchors?: readonly string[],
    publicationAnchors: readonly string[] = [],
  ): readonly string[] {
    const index = lease.generation.plan.index;
    const selected = new Set<string>();
    for (const id of anchors ??
      index.definition.roots
        .filter((r) => r.plane === 'model' && index.modelMayOpen(r.node_id))
        .map((r) => r.node_id)) {
      validateID(id);
      if (!index.modelMayOpen(id)) denied();
      for (const node of index.subtree(id))
        if (index.modelMayOpen(node.node_id)) selected.add(node.node_id);
    }
    for (const id of publicationAnchors) {
      validateID(id);
      for (const node of index.subtree(id)) selected.add(node.node_id);
    }
    return Object.freeze(index.preorder.filter((id) => selected.has(id)));
  }

  async createPin(options: ManagedRequestOptions = {}): Promise<ManagedRunPin> {
    const signal = options.signal;
    const lease = this.coordinator.lease();
    let keeper: RetainedGeneration | undefined;
    try {
      signal?.throwIfAborted();
      const identity = this.currentIdentity();
      const anchors = Object.freeze([
        ...(options.selection ??
          lease.generation.plan.definition.roots
            .filter(
              (r) => r.plane === 'model' && lease.generation.plan.index.modelMayOpen(r.node_id),
            )
            .map((r) => r.node_id)),
      ]);
      const publicationAnchors = Object.freeze([...(options.publicationSelection ?? [])]);
      const selected = this.selection(lease, anchors, publicationAnchors);
      keeper = lease.generation.retain();
      const ceiling = await this.authorize(identity, 'run.create', selected);
      signal?.throwIfAborted();
      return Object.freeze({
        generation: lease.generation,
        attempt: lease.attempt,
        identity,
        anchors,
        publicationAnchors,
        ceiling,
        keeper,
      });
    } catch (error) {
      keeper?.close();
      throw error;
    } finally {
      lease.resources.close();
    }
  }

  async request<T>(
    action: (request: ManagedRequest) => T | Promise<T>,
    options: ManagedRequestOptions = {},
  ): Promise<T> {
    const signal = options.signal;
    const lease = this.coordinator.lease();
    try {
      signal?.throwIfAborted();
      const identity = this.currentIdentity();
      const ceiling = await this.authorize(
        identity,
        'request',
        this.selection(lease, options.selection, options.publicationSelection),
      );
      signal?.throwIfAborted();
      return await this.execute(lease, identity, ceiling, action, signal);
    } finally {
      lease.resources.close();
    }
  }

  async pinnedRequest<T>(
    pin: ManagedRunPin,
    action: (request: ManagedRequest) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (
      this.coordinator.closed ||
      pin.attempt.boot_id !== this.coordinator.bootID ||
      pin.attempt.release.graph_id !== this.coordinator.graphID ||
      pin.attempt.release.target_id !== this.coordinator.targetID ||
      !sameIdentity(pin.identity, this.currentIdentity())
    )
      denied();
    const resources = pin.keeper.lease();
    try {
      signal?.throwIfAborted();
      const ceiling = await this.authorize(pin.identity, 'request', pin.ceiling);
      signal?.throwIfAborted();
      return await this.execute(
        { generation: pin.generation, attempt: pin.attempt, resources },
        pin.identity,
        ceiling,
        action,
        signal,
      );
    } finally {
      resources.close();
    }
  }

  private async execute<T>(
    lease: ServingLease,
    identity: ManagedIdentity,
    ceiling: readonly string[],
    action: (request: ManagedRequest) => T | Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const request = new ManagedRequest(this, lease, identity, ceiling, signal);
    let result: T;
    try {
      result = await action(request);
    } catch (original) {
      try {
        await request.finish();
      } catch (cleanup) {
        throw new AggregateError([original, cleanup], 'Request and pending operations failed', {
          cause: cleanup,
        });
      }
      throw original;
    }
    await request.finish();
    return result;
  }
}

/** All schema, disclosure and dispatch for this scope use exactly one generation. */
export class ManagedRequest {
  #open = true;
  #ceiling: Set<string>;
  readonly #pending = new Set<Promise<unknown>>();
  #finished: Promise<void> | undefined;
  readonly #runtime: ManagedRuntime;
  readonly #lease: ServingLease;
  readonly #identity: ManagedIdentity;
  readonly #signal: AbortSignal | undefined;

  constructor(
    runtime: ManagedRuntime,
    lease: ServingLease,
    identity: ManagedIdentity,
    ceiling: readonly string[],
    signal: AbortSignal | undefined,
  ) {
    this.#runtime = runtime;
    this.#lease = lease;
    this.#identity = identity;
    this.#signal = signal;
    this.#ceiling = new Set(ceiling);
    Object.freeze(this);
  }

  get generationUUID(): string {
    return this.#lease.generation.context.generation_uuid;
  }

  get coordinates(): JSONObject {
    this.check();
    const attempt = this.#lease.attempt;
    return Object.freeze({
      source: 'serving',
      graph_id: this.#lease.generation.context.graph_id,
      revision: attempt.release.snapshot.revision,
      generation_uuid: this.generationUUID,
      target_id: attempt.release.target_id,
      instance_id: attempt.instance_id,
      boot_id: attempt.boot_id,
      locale: this.#lease.generation.plan.selectedLocale,
    });
  }

  /** CURRENT trusted Host scope can only attenuate a retained run's ceiling. */
  attenuate(options: ManagedRequestOptions): void {
    this.check();
    const index = this.#lease.generation.plan.index;
    const allowed = new Set<string>();
    for (const id of options.selection ??
      index.definition.roots
        .filter((r) => r.plane === 'model' && index.modelMayOpen(r.node_id))
        .map((r) => r.node_id)) {
      validateID(id);
      if (!index.modelMayOpen(id)) denied();
      for (const node of index.subtree(id))
        if (index.modelMayOpen(node.node_id)) allowed.add(node.node_id);
    }
    for (const id of options.publicationSelection ?? []) {
      validateID(id);
      for (const node of index.subtree(id)) allowed.add(node.node_id);
    }
    this.#ceiling = new Set([...this.#ceiling].filter((id) => allowed.has(id)));
  }

  private check(): void {
    if (!this.#open) denied();
    this.#signal?.throwIfAborted();
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    const task = operation();
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => {
        this.#pending.delete(task);
      },
    );
    return task;
  }

  private authorized<T>(
    operation: string,
    nodeID: string,
    dispatch: (context: ManagedIdentity) => T | Promise<T>,
  ): Promise<T> {
    this.check();
    if (!this.#ceiling.has(nodeID)) denied();
    return this.#runtime.withAuthorization(
      this.#identity,
      operation,
      [...this.#ceiling],
      (current, context) => {
        const allowed = new Set(current);
        this.#ceiling = new Set([...this.#ceiling].filter((id) => allowed.has(id)));
        this.check();
        if (!this.#ceiling.has(nodeID)) denied();
        return dispatch(context);
      },
    );
  }

  private node(reference: string, model = true): string {
    const parsed = parseReference(reference);
    if (
      parsed.graphID !== this.#lease.generation.context.graph_id ||
      parsed.generationUUID !== this.generationUUID
    )
      denied();
    if (model && !this.#lease.generation.plan.index.modelMayOpen(parsed.nodeID)) denied();
    return parsed.nodeID;
  }

  private refresh<T>(
    operation: string,
    dispatch: (context: ManagedIdentity) => T | Promise<T>,
  ): Promise<T> {
    this.check();
    return this.#runtime.withAuthorization(
      this.#identity,
      operation,
      [...this.#ceiling],
      (current, context) => {
        this.#ceiling = new Set([...this.#ceiling].filter((id) => current.includes(id)));
        this.check();
        return dispatch(context);
      },
    );
  }

  /** Last current-authority fence after asynchronous business/publication work. */
  validateReturn(): Promise<void> {
    const required = [...this.#ceiling];
    return this.refresh('response', () => {
      if (required.some((id) => !this.#ceiling.has(id))) denied();
    });
  }

  private card(id: string): JSONObject {
    if (!this.#ceiling.has(id)) denied();
    const plan = this.#lease.generation.plan;
    const node = plan.index.get(id);
    return Object.freeze({
      ref: this.reference(id),
      kind: node.kind,
      name: node.name,
      ...plan.presentations[id],
    });
  }

  routes(): Promise<readonly JSONObject[]> {
    return this.track(() =>
      this.refresh('routes', () => {
        const index = this.#lease.generation.plan.index;
        return Object.freeze(
          index.preorder
            .filter(
              (id) =>
                this.#ceiling.has(id) &&
                index.modelMayOpen(id) &&
                !this.#ceiling.has(index.locations[id]!.parent_id ?? ''),
            )
            .map((id) => this.card(id)),
        );
      }),
    );
  }

  relation(reference: string, relation: 'members' | 'uses'): Promise<readonly JSONObject[]> {
    if (relation !== 'members' && relation !== 'uses') denied();
    return this.track(() => {
      const id = this.node(reference);
      return this.authorized(relation, id, () => {
        const index = this.#lease.generation.plan.index;
        const node = index.get(id);
        const ids =
          relation === 'uses'
            ? node.uses
            : node.kind === 'role'
              ? placements(node.members).map((p) => p[2])
              : [];
        return Object.freeze(
          ids
            .filter((target) => this.#ceiling.has(target) && index.modelMayOpen(target))
            .map((target) => this.card(target)),
        );
      });
    });
  }

  private program(id: string): JSONObject {
    const plan = this.#lease.generation.plan;
    const node = plan.index.get(id);
    if (node.kind === 'tool') denied();
    const instructions = plan
      .resolveInstructions(id, this.generationUUID)
      .map((part) => {
        if ('text' in part) return part.text;
        if (!this.#ceiling.has(part.reference.nodeID)) denied();
        return part.reference.toString();
      })
      .join('');
    const processCards: JSONObject[] = [];
    if (node.kind === 'role')
      for (const designation of ['pre_process', 'post_process'] as const) {
        const target = plan.processes[id]![designation];
        if (target !== undefined) processCards.push({ designation, active: this.program(target) });
      }
    return Object.freeze({
      card: this.card(id),
      instructions,
      process_cards: Object.freeze(processCards),
    });
  }

  open(reference: string): Promise<JSONObject> {
    return this.track(() => {
      const id = this.node(reference);
      return this.authorized('open', id, () => this.program(id));
    });
  }

  listPublications(kind: Publication['kind']): Promise<readonly JSONObject[]> {
    if (!['prompt', 'resource', 'route'].includes(kind)) denied();
    return this.track(() =>
      this.refresh(`${kind}.list`, () =>
        Object.freeze(
          this.#lease.generation.plan.definition.publications
            .filter((p) => p.kind === kind && this.#ceiling.has(p.opens_id))
            .map((p) => Object.freeze({ ...p, ref: this.reference(p.opens_id) })),
        ),
      ),
    );
  }

  /** Trusted Host mount validation against this exact serving definition. */
  assertHostMount(path: string): void {
    this.check();
    if (
      this.#lease.generation.plan.definition.publications.some(
        (p) => p.kind === 'route' && p.path === path,
      )
    )
      throw new GraphError('contract_mismatch', 'Host mount conflicts with a published route');
  }

  private publication(kind: Publication['kind'], key: string, reference: string): Publication {
    const id = this.node(reference, false);
    const publication = this.#lease.generation.plan.definition.publications.find(
      (p) =>
        p.kind === kind &&
        p.opens_id === id &&
        (p.kind === 'resource'
          ? p.uri === key
          : p.kind === 'route'
            ? `${p.method} ${p.path}` === key
            : p.name === key),
    );
    if (publication === undefined) denied();
    return publication;
  }

  prompt(name: string, reference: string): Promise<JSONObject> {
    return this.track(() => {
      const p = this.publication('prompt', name, reference);
      return this.authorized('prompt.get', p.opens_id, () => this.program(p.opens_id));
    });
  }

  readResource(uri: string, reference: string): Promise<string> {
    return this.track(async () => {
      const p = this.publication('resource', uri, reference);
      const result = await this.callPublication(p, {}, true);
      if (typeof result !== 'string')
        throw new GraphError('contract_mismatch', 'Resource handler must return text');
      return result;
    });
  }

  route(method: string, path: string, reference: string, input: unknown): Promise<FrozenJSON> {
    const captured = freezeJSON(input);
    return this.track(() => {
      const p = this.publication('route', `${method} ${path}`, reference);
      return this.callPublication(p, captured, method === 'GET' || method === 'HEAD');
    });
  }

  private callPublication(p: Publication, input: unknown, readOnly: boolean): Promise<FrozenJSON> {
    return this.authorized(`${p.kind}.execute`, p.opens_id, async (context) => {
      const binding = this.#lease.generation.plan.bindings[p.opens_id];
      if (binding === undefined || (readOnly && binding.entry.effect !== 'read_only')) denied();
      const result = await binding.registration.call(input, {
        identity: context,
        resource: this.#lease.resources.handle(p.opens_id),
        signal: this.#signal,
      });
      this.#signal?.throwIfAborted();
      return freezeJSON(thawJSON(result));
    });
  }

  /** Only stable IDs supplied by trusted callers; returned references are generation-scoped. */
  reference(nodeID: string): string {
    this.check();
    if (!this.#ceiling.has(nodeID)) denied();
    return new ManagedReference(
      this.#lease.generation.context.graph_id,
      this.generationUUID,
      nodeID,
    ).toString();
  }

  inspect(reference: string): Promise<JSONObject> {
    return this.track(async () => {
      const nodeID = this.node(reference);
      return this.authorized('inspect', nodeID, () => {
        const plan = this.#lease.generation.plan;
        const node = plan.index.get(nodeID);
        const binding = plan.bindings[nodeID];
        return freezeJSON({
          reference,
          kind: node.kind,
          name: node.name,
          ...plan.presentations[nodeID],
          ...(binding === undefined
            ? {}
            : { input_schema: binding.entry.input_schema, effect: binding.entry.effect }),
        }) as JSONObject;
      });
    });
  }

  invoke(
    reference: string,
    arguments_: unknown,
    options: { readOnly?: boolean } = {},
  ): Promise<FrozenJSON> {
    this.check();
    const readOnly = options.readOnly === true;
    if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') denied();
    // Copy raw JSON before any await, not a live alias of caller-owned arguments.
    const captured = freezeJSON(arguments_);
    return this.track(async () => {
      const nodeID = this.node(reference);
      const result = await this.authorized(
        readOnly ? 'invoke_read_only' : 'invoke',
        nodeID,
        (context) => {
          const binding = this.#lease.generation.plan.bindings[nodeID];
          if (binding === undefined)
            throw new GraphError('binding_contract_required', 'Node is not executable');
          if (readOnly && binding.entry.effect !== 'read_only') denied();
          return binding.registration.call(captured, {
            identity: context,
            resource: this.#lease.resources.handle(nodeID),
            signal: this.#signal,
          });
        },
      );
      this.#signal?.throwIfAborted();
      return freezeJSON(thawJSON(result));
    });
  }

  finish(): Promise<void> {
    if (this.#finished !== undefined) return this.#finished;
    // Stop escaped/new calls, but let already dispatched handlers settle before release.
    this.#open = false;
    this.#finished = Promise.allSettled([...this.#pending]).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, 'Pending managed request operations failed');
    });
    return this.#finished;
  }
}
