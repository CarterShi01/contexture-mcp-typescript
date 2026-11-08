/** Trusted read capabilities. No default authentication or fabricated durable authority. */
import { GraphError, parseCounter, validateID } from '../core/graph/canonical.js';
import type { ManagedIdentity } from '../core/graph/bindings.js';
import { selectedIDs } from '../core/graph/catalog.js';
import { GraphIndex } from '../core/graph/index.js';
import type { JSONObject } from '../core/graph/model.js';
import type { StructuralPlan } from '../core/graph/compiler.js';
import type { ManagedRuntime } from './managed-runtime.js';
import type { ServingGeneration } from './managed-serving.js';
import { identity, resync, same } from './managed-read-state.js';

export type CatalogSource = 'head' | 'revision' | 'serving';
export interface DefinitionReadRequest {
  readonly graph_id: string;
  readonly source: 'head' | 'revision';
  readonly revision?: string;
}
export interface DefinitionReadView {
  readonly identity: ManagedIdentity;
  readonly store_origin: string;
  readonly index: GraphIndex;
  readonly current_index: GraphIndex;
  readonly revision: string;
  readonly scope_ids: readonly string[];
}
export interface DefinitionReadPort {
  /**
   * Capture retained verified definition + CURRENT graph.catalog admission under
   * one owner lock/fence. Invoke dispatch synchronously at that fence, exactly once.
   * A historical grant is not admission. Failure/retention errors must propagate.
   */
  read<T>(request: DefinitionReadRequest, dispatch: (view: DefinitionReadView) => T): Promise<T>;
}
export interface ServingReadPort {
  readonly runtime: ManagedRuntime;
  /** CURRENT durable store incarnation; supplied by the same trusted Host as runtime. */
  storeOrigin(): string;
}
export function origin(value: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096)
    throw new GraphError('contract_mismatch', 'Trusted read origin unavailable');
  return value;
}
export function selection(value?: readonly string[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new GraphError('schema_invalid', 'Invalid read selection');
  return Object.freeze([...new Set(value.map((id) => validateID(id)))].sort());
}
export function definitionView(view: DefinitionReadView, graphID: string): void {
  identity(view.identity);
  origin(view.store_origin);
  parseCounter(view.revision);
  if (
    !(view.index instanceof GraphIndex) ||
    !(view.current_index instanceof GraphIndex) ||
    view.index.definition.graph_id !== graphID ||
    view.current_index.definition.graph_id !== graphID ||
    !Array.isArray(view.scope_ids) ||
    view.scope_ids.some((id) => typeof id !== 'string')
  )
    throw new GraphError('contract_mismatch', 'Trusted definition read coordinates differ');
}
export function visibleDefinition(
  view: DefinitionReadView,
  pinned: GraphIndex,
  anchors?: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set(view.scope_ids);
  return new Set(
    [...selectedIDs(pinned, anchors)].filter(
      (id) => allowed.has(id) && Object.hasOwn(view.current_index.definition.nodes, id),
    ),
  );
}

export interface ServingReadSnapshot {
  readonly serving: ServingGeneration;
  readonly plan: StructuralPlan;
  readonly visible: ReadonlySet<string>;
  readonly identity: ManagedIdentity;
  readonly coordinates: JSONObject;
  readonly dispose: () => void;
  readonly authorize: (dispatch: () => JSONObject) => Promise<JSONObject>;
}

export async function captureServing(
  port: ServingReadPort,
  anchors: readonly string[] | undefined,
  openable: boolean,
  dispatch: (snapshot: ServingReadSnapshot) => JSONObject,
): Promise<JSONObject> {
  const runtime = port.runtime;
  const c = runtime.coordinator;
  const coordinates = (): JSONObject => ({
    store_origin: origin(port.storeOrigin()),
    graph_id: c.graphID,
    target_id: c.targetID,
    instance_id: c.instanceID,
    boot_id: c.bootID,
  });
  const capturedCoordinates = coordinates();
  const capturedIdentity = runtime.currentIdentity();
  const lease = c.lease();
  const plan = lease.generation.plan;
  const keeper = lease.generation.retain();
  let adopted = false;
  const operation = openable ? 'open' : 'route';
  const fresh = (): void => {
    if (
      c.closed ||
      !same(capturedCoordinates, coordinates()) ||
      !same(capturedIdentity, runtime.currentIdentity())
    )
      resync();
  };
  try {
    const requested = [...selectedIDs(plan.index, anchors)].filter((id) =>
      openable ? plan.index.modelMayOpen(id) : plan.index.locations[id]!.plane === 'model',
    );
    const result = await runtime.withAuthorization(
      capturedIdentity,
      operation,
      requested,
      (allowed) => {
        fresh();
        const ceiling = Object.freeze([...allowed]);
        const authorize = async (render: () => JSONObject): Promise<JSONObject> => {
          fresh();
          const resources = keeper.lease();
          try {
            return await runtime.withAuthorization(
              capturedIdentity,
              operation,
              requested,
              (current) => {
                fresh();
                if (!same(ceiling, current)) resync();
                return render();
              },
            );
          } finally {
            resources.close();
          }
        };
        const value = dispatch({
          serving: lease,
          plan,
          visible: new Set(ceiling),
          identity: capturedIdentity,
          coordinates: capturedCoordinates,
          dispose: () => keeper.close(),
          authorize,
        });
        adopted = true;
        return value;
      },
    );
    return result;
  } finally {
    lease.resources.close();
    if (!adopted) keeper.close();
  }
}
