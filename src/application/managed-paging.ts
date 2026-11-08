/** Optional native model paging. No Host tool registration or legacy open changes. */
import { GraphError } from '../core/graph/canonical.js';
import type { JSONObject } from '../core/graph/model.js';
import { placements } from '../core/graph/model.js';
import type { MaterialBudget } from '../core/graph/paging.js';
import { ManagedReference, parseReference } from '../core/graph/references.js';
import { captureServing, selection } from './managed-read-authority.js';
import type { ServingReadPort, ServingReadSnapshot } from './managed-read-authority.js';
import { PageProfile, resync, SnapshotPages } from './managed-read-state.js';
import type { PageStoreOptions } from './managed-read-state.js';

export { CursorSigner, PageProfile } from './managed-read-state.js';
export type PageOperation = 'routes' | 'members' | 'uses' | 'open';
export type PageRelation = 'routes' | 'members' | 'uses';
export interface PagingRequest {
  readonly operation: PageOperation;
  readonly reference?: string;
  readonly selection?: readonly string[];
  readonly profile?: PageProfile;
}

function binding(value: PagingRequest): JSONObject {
  if (
    !['routes', 'members', 'uses', 'open'].includes(value.operation) ||
    (value.operation === 'routes') !== (value.reference === undefined) ||
    (value.profile !== undefined && !(value.profile instanceof PageProfile))
  )
    throw new GraphError('schema_invalid', 'Invalid native paging request');
  if (value.reference !== undefined) parseReference(value.reference);
  return {
    operation: value.operation,
    reference: value.reference ?? null,
    selection: selection(value.selection) ?? null,
    profile: (value.profile ?? new PageProfile()).asJSON(),
  };
}

function material(
  s: ServingReadSnapshot,
  value: PagingRequest,
  profile: PageProfile,
  budget: MaterialBudget,
) {
  const index = s.plan.index;
  const generation = s.serving.generation.context.generation_uuid;
  const ref = (id: string): string =>
    new ManagedReference(index.definition.graph_id, generation, id).toString();
  const requireVisible = (id: string): void => {
    if (!s.visible.has(id)) throw new GraphError('permission_denied', 'Paged target unavailable');
  };
  const card = (id: string): JSONObject => {
    requireVisible(id);
    const node = index.get(id);
    return {
      ref: ref(id),
      kind: node.kind,
      name: node.name,
      description: s.plan.presentations[id]!.description,
      ...(index.presentation(id, s.plan.selectedLocale) === undefined
        ? {}
        : { title: s.plan.presentations[id]!.title }),
    };
  };
  let nodeID: string | undefined;
  if (value.reference !== undefined) {
    const parsed = parseReference(value.reference);
    if (parsed.graphID !== index.definition.graph_id || parsed.generationUUID !== generation)
      resync();
    nodeID = parsed.nodeID;
    requireVisible(nodeID);
  }
  let active: JSONObject = {};
  const processes: JSONObject[] = [];
  if (value.operation === 'open') {
    if (nodeID === undefined || index.get(nodeID).kind !== 'role')
      throw new GraphError('schema_invalid', 'Native paged open is Role-only');
    // Programs are atomic ACTIVE material. Never include a hidden template target.
    const instructions = s.plan
      .resolveInstructions(nodeID, generation)
      .map((part) => {
        if ('text' in part) return part.text;
        requireVisible(part.reference.nodeID);
        return part.reference.toString();
      })
      .join('');
    const designations: Record<string, string> = {};
    for (const designation of ['pre_process', 'post_process'] as const) {
      const target = s.plan.processes[nodeID]![designation];
      if (target === undefined) continue;
      requireVisible(target);
      processes.push({ designation, card: card(target) });
      designations[designation] = ref(target);
    }
    active = { card: card(nodeID), instructions, ...designations };
  }
  budget.add({ owner_active: active, process_cards: processes }, false);
  const streams: Record<string, readonly JSONObject[]> = {};
  for (const relation of value.operation === 'open'
    ? (['members', 'uses'] as const)
    : [value.operation]) {
    let ids: readonly string[];
    if (relation === 'routes') {
      ids = index.preorder.filter(
        (id) => s.visible.has(id) && !s.visible.has(index.locations[id]!.parent_id ?? ''),
      );
    } else {
      const node = index.get(nodeID!);
      ids =
        relation === 'members'
          ? node.kind === 'role'
            ? placements(node.members).map((p) => p[2])
            : []
          : node.uses;
    }
    const cards: JSONObject[] = [];
    for (const id of ids) {
      if (!s.visible.has(id) || !profile.kinds.includes(index.get(id).kind)) continue;
      const value = card(id);
      budget.add(value);
      cards.push(value);
    }
    streams[relation] = cards;
  }
  return {
    streams,
    envelope: {
      source: 'serving',
      graph_id: index.definition.graph_id,
      revision: s.serving.attempt.release.snapshot.revision,
      generation_uuid: generation,
      target_id: s.serving.attempt.release.target_id,
      instance_id: s.serving.attempt.instance_id,
      boot_id: s.serving.attempt.boot_id,
      locale: s.plan.selectedLocale,
      ...(value.operation === 'open' ? { owner_active: active, process_cards: processes } : {}),
    },
  };
}

export class ManagedPagingService {
  readonly #port: ServingReadPort;
  readonly #pages: SnapshotPages;
  constructor(options: PageStoreOptions & { serving: ServingReadPort }) {
    this.#port = {
      runtime: options.serving.runtime,
      storeOrigin: options.serving.storeOrigin.bind(options.serving),
    };
    this.#pages = new SnapshotPages(options);
  }
  get counts() {
    return this.#pages.counts;
  }
  get requiresExplicitSweep(): boolean {
    return this.#pages.requiresExplicitSweep;
  }
  sweep(): number {
    return this.#pages.sweep();
  }
  shutdown(): void {
    this.#pages.shutdown();
  }
  async start(value: PagingRequest, ttl = 30000): Promise<JSONObject> {
    const captured = binding(value);
    const capturedRequest: PagingRequest = {
      operation: value.operation,
      ...(value.reference === undefined ? {} : { reference: value.reference }),
    };
    const profile = value.profile ?? new PageProfile();
    const anchors = selection(value.selection);
    const pending = this.#pages.begin(ttl);
    try {
      return await captureServing(this.#port, anchors, true, (s) =>
        this.#pages.create({
          binding: captured,
          ...material(s, capturedRequest, profile, this.#pages.materialBudget()),
          profile,
          ...pending,
          relationPages: true,
          authorize: s.authorize,
          dispose: s.dispose,
        }),
      );
    } finally {
      pending.finish();
    }
  }
  continuation(
    token: string,
    value: PagingRequest & { relation: PageRelation },
  ): Promise<JSONObject> {
    return this.#pages.page(token, value.relation, binding(value));
  }
}
