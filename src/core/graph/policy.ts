/** Candidate ordinary endpoint protection only; NOT Host admission or authorization. */
import { canonicalJSON, GraphError } from './canonical.js';
import { GraphIndex } from './index.js';
import { placements } from './model.js';
import type { GraphDefinition, PublicationContracts } from './model.js';

export interface ProtectionReport {
  readonly impact: readonly string[];
  readonly reference_targets: readonly string[];
  readonly roots_changed: boolean;
}

function equal(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJSON(a)).equals(Buffer.from(canonicalJSON(b)));
}

/** Python-compatible Unicode scalar ordering, not JCS object-key ordering. */
function order(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

function deny(message: string): never {
  throw new GraphError('mutation_protected', message);
}

/** Both endpoints of inversions; insertion/deletion ordinal shifts are not moves. */
function reordered(before: readonly string[], after: readonly string[]): Set<string> {
  const ranks = new Map(after.map((id, i) => [id, i]));
  const common = before.filter((id) => ranks.has(id));
  const result = new Set<string>();
  let maximum = -1;
  for (const id of common) {
    const rank = ranks.get(id)!;
    if (rank < maximum) result.add(id);
    maximum = Math.max(maximum, rank);
  }
  let minimum = after.length;
  for (const id of common.reverse()) {
    const rank = ranks.get(id)!;
    if (rank > minimum) result.add(id);
    minimum = Math.min(minimum, rank);
  }
  return result;
}

function sequence(index: GraphIndex, parent: string | null): readonly string[] {
  if (parent === null) return index.definition.roots.map((root) => root.node_id);
  const node = index.definition.nodes[parent]!;
  return node.kind === 'role' ? placements(node.members).map((entry) => entry[2]) : [];
}

function surface(index: GraphIndex, id: string): unknown {
  const graph = index.definition;
  const node = graph.nodes[id]!;
  const refs = [...node.uses];
  if (node.kind === 'role') refs.push(...placements(node.members).map((entry) => entry[2]));
  if (node.kind !== 'tool' && node.instruction_template)
    for (const part of node.instruction_template.parts)
      if (part.kind === 'NodeRef') refs.push(part.target_id);
  return {
    node,
    path: index.path(id),
    plane: index.locations[id]!.plane,
    default_locale: graph.presentations.default_locale,
    mode: graph.mode,
    graph_extensions: graph.extensions,
    cards: refs.map((target) => {
      const value = graph.nodes[target]!;
      return {
        node_id: target,
        name: value.name,
        path: index.path(target),
        plane: index.locations[target]!.plane,
        description: value.description,
        kind: value.kind,
      };
    }),
    publications: graph.publications.filter((pub) => pub.opens_id === id),
    presentations: graph.presentations.catalogs.flatMap((catalog) =>
      catalog.entries
        .filter((entry) => entry.node_id === id)
        .map((entry) => ({ locale: catalog.locale, entry })),
    ),
  };
}

/** Final-diff static creation policy; no permission bypass flag or registry resolution. */
export function protectChange(
  before: GraphDefinition,
  candidate: GraphDefinition,
  contracts?: PublicationContracts,
): ProtectionReport {
  if (before.graph_id !== candidate.graph_id)
    throw new GraphError('identity_conflict', 'Ordinary change cannot cross graphs');
  const old = GraphIndex.build(before, contracts);
  const next = GraphIndex.build(candidate, contracts);
  const a = before.nodes;
  const b = candidate.nodes;
  const locked = new Set(Object.keys(a).filter((id) => !old.locations[id]!.effective_mutable));
  const impact = new Set<string>();
  const refs = new Set<string>();
  const checkOrder = (left: readonly string[], right: readonly string[], barriers: Set<string>) => {
    const changes = reordered(left, right);
    if ([...changes].some((id) => barriers.has(id)))
      deny('Existing member crossed a locked member');
    return changes;
  };
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!x || !y) {
      impact.add(id);
      if (!y && locked.has(id)) deny('Deletion closure contains locked objects');
      if (!x) {
        const parent = next.locations[id]!.parent_id;
        if (parent !== null && !next.locations[parent]!.effective_mutable)
          deny('Creation requires a mutable parent, including false barriers');
      }
      continue;
    }
    if (
      x.kind !== y.kind ||
      x.mutable !== y.mutable ||
      (x.kind === 'role' ? x.role_variant : null) !== (y.kind === 'role' ? y.role_variant : null)
    )
      throw new GraphError(
        'identity_conflict',
        'Identity kind, variant and creation policy are immutable',
      );
    const p = old.locations[id]!;
    const q = next.locations[id]!;
    const moved = p.parent_id !== q.parent_id || p.slot !== q.slot;
    const changed =
      !equal(x, y) || moved || p.plane !== q.plane || !equal(surface(old, id), surface(next, id));
    if (changed) impact.add(id);
    if (changed && locked.has(id)) deny('Change alters a locked object, path, plane or surface');
    if (moved) {
      for (const [index, parent] of [
        [old, p.parent_id],
        [next, q.parent_id],
      ] as const)
        if (parent !== null && !index.locations[parent]!.effective_mutable)
          deny('Move requires mutable source and destination parents');
    }
    if (!equal(x.uses, y.uses)) for (const target of [...x.uses, ...y.uses]) refs.add(target);
  }
  for (const parent of [null, ...Object.keys(a)]) {
    if (parent !== null && !Object.hasOwn(b, parent)) continue;
    for (const id of checkOrder(sequence(old, parent), sequence(next, parent), locked))
      impact.add(id);
  }
  const oldPubs = new Map(before.publications.map((p) => [p.publication_id, p.opens_id]));
  const newPubs = new Map(candidate.publications.map((p) => [p.publication_id, p.opens_id]));
  const lockedPubs = new Set([...oldPubs].filter(([, id]) => locked.has(id)).map(([id]) => id));
  for (const id of checkOrder([...oldPubs.keys()], [...newPubs.keys()], lockedPubs)) {
    impact.add(oldPubs.get(id)!);
    impact.add(newPubs.get(id)!);
  }
  const oldCatalogs = new Map(
    before.presentations.catalogs.map((c) => [c.locale, c.entries.map((e) => e.node_id)]),
  );
  const newCatalogs = new Map(
    candidate.presentations.catalogs.map((c) => [c.locale, c.entries.map((e) => e.node_id)]),
  );
  for (const [locale, ids] of oldCatalogs) {
    const after = newCatalogs.get(locale);
    if (after) for (const id of checkOrder(ids, after, locked)) impact.add(id);
  }
  const lockedCatalogs = new Set(
    [...oldCatalogs]
      .filter(([, ids]) => ids.some((id) => locked.has(id)))
      .map(([locale]) => locale),
  );
  for (const locale of checkOrder([...oldCatalogs.keys()], [...newCatalogs.keys()], lockedCatalogs))
    for (const id of [...oldCatalogs.get(locale)!, ...newCatalogs.get(locale)!]) impact.add(id);
  for (const graph of [before, candidate]) {
    for (const node of Object.values(graph.nodes)) {
      if (!impact.has(node.node_id)) continue;
      for (const target of node.uses) refs.add(target);
      if (node.kind !== 'tool' && node.instruction_template)
        for (const part of node.instruction_template.parts)
          if (part.kind === 'NodeRef') refs.add(part.target_id);
    }
    for (const pub of graph.publications) if (impact.has(pub.opens_id)) refs.add(pub.opens_id);
  }
  return Object.freeze({
    impact: Object.freeze([...impact].sort(order)),
    reference_targets: Object.freeze([...refs].sort(order)),
    roots_changed: !equal(before.roots, candidate.roots),
  });
}
