/** ROUTE metadata only. Deliberately independent of legacy Node Catalog v1. */
import { GraphError } from './canonical.js';
import type { GraphIndex } from './index.js';
import { placements } from './model.js';
import type { JSONObject, NodeSpec } from './model.js';
import type { MaterialBudget } from './paging.js';

export type CatalogKind = NodeSpec['kind'];
export interface CatalogMaterial {
  readonly nodes: readonly JSONObject[];
  readonly containment: readonly JSONObject[];
  readonly uses: readonly JSONObject[];
}

export function metadataCatalog(
  index: GraphIndex,
  visible: ReadonlySet<string>,
  kinds: readonly CatalogKind[],
  budget: MaterialBudget,
  card?: (id: string) => JSONObject,
): CatalogMaterial {
  const selected = new Set(
    index.preorder.filter((id) => visible.has(id) && kinds.includes(index.get(id).kind)),
  );
  const nodes: JSONObject[] = [];
  const containment: JSONObject[] = [];
  const uses: JSONObject[] = [];
  const emit = (stream: JSONObject[], item: JSONObject): void => {
    budget.add(item);
    stream.push(item);
  };
  for (const id of index.preorder) {
    if (!selected.has(id)) continue;
    const node = index.get(id);
    emit(nodes, {
      ...(card?.(id) ?? { kind: node.kind, name: node.name, description: node.description }),
      node_id: id,
      projected_root: !selected.has(index.locations[id]!.parent_id ?? ''),
    });
    if (node.kind === 'role')
      for (const [slot, , target] of placements(node.members))
        if (selected.has(target)) emit(containment, { source_id: id, slot, target_id: target });
    for (const target of node.uses)
      if (selected.has(target)) emit(uses, { source_id: id, target_id: target });
  }
  return { nodes, containment, uses };
}

export function selectedIDs(index: GraphIndex, anchors?: readonly string[]): ReadonlySet<string> {
  if (anchors === undefined) return new Set(index.preorder);
  const ids = new Set<string>();
  for (const anchor of anchors) {
    if (!Object.hasOwn(index.locations, anchor))
      throw new GraphError('resync_required', 'Requested view unavailable; resync required');
    for (const node of index.subtree(anchor)) ids.add(node.node_id);
  }
  return ids;
}
