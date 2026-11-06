/** Exact stable-ID endpoint diffs; explicit projections are not inferred behavior. */
import { canonicalJSON, freezeJSON, GraphError, thawJSON } from './canonical.js';
import type { FrozenJSON } from './canonical.js';
import type { GraphDefinition, JSONObject } from './model.js';

type Wire = Record<string, unknown>;
const groups = ['nodes', 'membership', 'uses', 'publications', 'locales'] as const;
function order(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!),
    y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
function equal(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJSON(a)).equals(Buffer.from(canonicalJSON(b)));
}
function optional(o: Wire, k: string): Wire {
  return Object.hasOwn(o, k) ? { present: true, value: o[k] } : { present: false };
}
function pointer(k: string): string {
  return '/' + k.replace(/~/gu, '~0').replace(/\//gu, '~1');
}
export class DefinitionDiff {
  readonly value: JSONObject;
  constructor(value: unknown) {
    const v = freezeJSON(value);
    if (
      v === null ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      !equal(Object.keys(v).sort(), [...groups].sort())
    )
      throw new GraphError('schema_invalid', 'DefinitionDiff requires five declared groups');
    this.value = v as JSONObject;
    Object.freeze(this);
  }
  asJSON(): Wire {
    return thawJSON(this.value) as Wire;
  }
  get empty(): boolean {
    return groups.every((k) => Array.isArray(this.value[k]) && this.value[k].length === 0);
  }
}
export function definitionDiff(base: GraphDefinition, candidate: GraphDefinition): DefinitionDiff {
  if (base.graph_id !== candidate.graph_id)
    throw new GraphError('schema_invalid', 'Cannot align different graph identities');
  const result: Record<(typeof groups)[number], Wire[]> = {
    nodes: [],
    membership: [],
    uses: [],
    publications: [],
    locales: [],
  };
  function entry(
    group: (typeof groups)[number],
    id: string,
    field: string,
    a: Wire,
    b: Wire,
    key: string,
  ): void {
    const before = optional(a, key),
      after = optional(b, key);
    if (!equal(before, after)) result[group].push({ id, field, before, after });
  }
  const a = base.asJSON() as Wire,
    b = candidate.asJSON() as Wire;
  for (const field of ['schema', 'semantic_version', 'application_name', 'mode', 'extensions'])
    entry('nodes', base.graph_id, pointer(field), a, b, field);
  entry('membership', base.graph_id, '/roots', a, b, 'roots');
  for (const id of [...new Set([...Object.keys(base.nodes), ...Object.keys(candidate.nodes)])].sort(
    order,
  )) {
    const x = base.nodes[id],
      y = candidate.nodes[id];
    if (!x || !y) {
      entry('nodes', id, '', x ? { node: x } : {}, y ? { node: y } : {}, 'node');
      continue;
    }
    for (const field of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort(order))
      entry(
        field === 'members' ? 'membership' : field === 'uses' ? 'uses' : 'nodes',
        id,
        pointer(field),
        x as unknown as Wire,
        y as unknown as Wire,
        field,
      );
  }
  entry('publications', base.graph_id, '/publications', a, b, 'publications');
  const ap = new Map(base.publications.map((p) => [p.publication_id, p])),
    bp = new Map(candidate.publications.map((p) => [p.publication_id, p]));
  for (const id of [...new Set([...ap.keys(), ...bp.keys()])].sort(order))
    entry(
      'publications',
      id,
      '',
      ap.has(id) ? { publication: ap.get(id) } : {},
      bp.has(id) ? { publication: bp.get(id) } : {},
      'publication',
    );
  entry('locales', base.graph_id, '/presentations', a, b, 'presentations');
  for (const value of Object.values(result))
    value.sort(
      (a, b) =>
        order(a.id as string, b.id as string) || order(a.field as string, b.field as string),
    );
  return new DefinitionDiff(result);
}
export const diff = definitionDiff;
function projectionDiff(before: unknown, after: unknown, kind: string): JSONObject {
  const a = freezeJSON(before),
    b = freezeJSON(after);
  if (
    a === null ||
    typeof a !== 'object' ||
    Array.isArray(a) ||
    b === null ||
    typeof b !== 'object' ||
    Array.isArray(b)
  )
    throw new GraphError('schema_invalid', 'Explicit normalized projection objects are required');
  return freezeJSON({ kind, equal: equal(a, b), before: a, after: b }) as JSONObject;
}
export const behaviorDiff = (a: unknown, b: unknown): Readonly<Record<string, FrozenJSON>> =>
  projectionDiff(a, b, 'behavior');
export const surfaceDiff = (a: unknown, b: unknown): Readonly<Record<string, FrozenJSON>> =>
  projectionDiff(a, b, 'surface');
export const executionDiff = (a: unknown, b: unknown): Readonly<Record<string, FrozenJSON>> =>
  projectionDiff(a, b, 'execution');
