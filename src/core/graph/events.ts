/** Pure resolved-fact projection. No admission, policy, registry, handlers or persistence. */
import {
  canonicalDigest,
  canonicalJSON,
  decodeJSON,
  freezeJSON,
  GraphError,
  MAX_COUNTER,
  parseCounter,
  thawJSON,
  validateID,
} from './canonical.js';
import type { GraphErrorCode } from './canonical.js';
import { GraphDefinition } from './model.js';
import type { JSONObject, PublicationContracts } from './model.js';
import { definitionDiff } from './diff.js';

type Wire = Record<string, unknown>;
export interface AcceptedState {
  readonly definition: GraphDefinition;
  readonly revision: string;
  readonly tombstones: readonly JSONObject[];
  readonly definitionDigest: string;
}
export function eventError(message: string, code = 'corrupt_facts'): never {
  // Candidate diagnostics absent from the shared, separately owned union.
  throw new GraphError(code as GraphErrorCode, message);
}
export function scalarOrder(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function equalJSON(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJSON(a)).equals(Buffer.from(canonicalJSON(b)));
}
function object(value: unknown, required: string, optional = ''): Wire {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    eventError('Expected closed object');
  const allowed = new Set(`${required} ${optional}`.split(' ').filter(Boolean));
  if (
    required
      .split(' ')
      .filter(Boolean)
      .some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !allowed.has(k))
  )
    eventError('Missing required or unknown fields');
  return value as Wire;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) eventError('Expected array');
  return value as unknown[];
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 71 || !/^sha256:[0-9a-f]{64}$/u.test(value))
    eventError('Invalid digest');
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value) eventError('Event reason must be nonempty text');
  return value;
}
function frozenObject(value: unknown): JSONObject {
  const result = freezeJSON(value);
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    eventError('Expected JSON object');
  return result as JSONObject;
}
function retained(value: unknown, revision: string): readonly JSONObject[] {
  const seen = new Set<string>();
  return Object.freeze(
    array(thawJSON(value))
      .map((raw) => {
        const t = object(raw, 'node_id kind mutable deleted_revision');
        const id = validateID(t.node_id),
          n = parseCounter(t.deleted_revision);
        if (
          seen.has(id) ||
          n === 0n ||
          n > parseCounter(revision) ||
          !['role', 'skill', 'tool'].includes(String(t.kind)) ||
          (typeof t.mutable !== 'boolean' && t.mutable !== 'inherit')
        )
          eventError('Invalid retained identity evidence');
        seen.add(id);
        return frozenObject(t);
      })
      .sort((a, b) => scalarOrder(a.node_id as string, b.node_id as string)),
  );
}
export class RevisionState implements AcceptedState {
  readonly tombstones: readonly JSONObject[];
  constructor(
    readonly definition: GraphDefinition,
    readonly revision: string,
    tombstones: unknown = [],
  ) {
    if (!GraphDefinition.isValidated(definition) || parseCounter(revision) === 0n)
      eventError('Revision zero cannot own a serving definition', 'bootstrap_contract_unfrozen');
    this.tombstones = retained(tombstones, revision);
    for (const t of this.tombstones) {
      const live = definition.nodes[t.node_id as string];
      if (live && (live.kind !== t.kind || live.mutable !== t.mutable))
        eventError('Live identity conflicts with retained creation policy');
    }
    Object.freeze(this);
  }
  get definitionDigest(): string {
    return this.definition.digest();
  }
}
function checked(base: AcceptedState): RevisionState {
  const state = new RevisionState(base.definition, base.revision, base.tombstones);
  if (state.definitionDigest !== base.definitionDigest) eventError('Invalid base digest');
  return state;
}
export class UnseededState {
  readonly revision = '0';
  readonly tombstones = Object.freeze([]);
  readonly definitionDigest = canonicalDigest(null, 'contexture.graph/v1');
  constructor(readonly graph_id: string) {
    validateID(graph_id);
    Object.freeze(this);
  }
}
export class BootstrapCandidate {
  private constructor(readonly definition: GraphDefinition) {
    Object.freeze(this);
  }
  static own(seed: GraphDefinition): BootstrapCandidate {
    if (!GraphDefinition.isValidated(seed)) eventError('Bootstrap requires validated seed');
    return new BootstrapCandidate(seed);
  }
}
export function optional(value: Wire, key: string): Wire {
  return Object.hasOwn(value, key) ? { present: true, value: value[key] } : { present: false };
}
function unwrap(value: unknown): Wire {
  const obj = object(value, 'present', 'value');
  if (typeof obj.present !== 'boolean' || Object.hasOwn(obj, 'value') !== obj.present)
    eventError('Invalid OptionalValue');
  return obj;
}
export function factsDigest(facts: unknown): string {
  array(facts);
  return canonicalDigest(facts, 'contexture.facts/v1');
}
export class ResolvedChange {
  readonly facts: readonly JSONObject[];
  readonly tombstones: readonly JSONObject[];
  readonly sourceMapping: JSONObject | null;
  constructor(
    readonly candidate: GraphDefinition,
    facts: unknown,
    tombstones: unknown,
    readonly migrationID: string | null = null,
    sourceMapping: unknown = null,
  ) {
    if (!GraphDefinition.isValidated(candidate)) eventError('Expected validated candidate');
    this.facts = Object.freeze(array(freezeJSON(facts)).map(frozenObject));
    this.tombstones = Object.freeze(array(freezeJSON(tombstones)).map(frozenObject));
    if (migrationID !== null) validateID(migrationID);
    this.sourceMapping = sourceMapping === null ? null : frozenObject(sourceMapping);
    Object.freeze(this);
  }
  get factsDigest(): string {
    return factsDigest(this.facts);
  }
  get noop(): boolean {
    return this.facts.length === 0;
  }
}
const fields = [
  'name',
  'description',
  'instructions',
  'instruction_template',
  'extensions',
  'binding',
  'input_contract',
];
const graphFields = ['application_name', 'extensions', 'mode'];
function resolve(
  base: AcceptedState,
  candidate: GraphDefinition,
  migrationID: string | null = null,
  sourceMapping: JSONObject | null = null,
): ResolvedChange {
  checked(base);
  if (!GraphDefinition.isValidated(candidate)) eventError('Expected validated candidate');
  const old = base.definition.asJSON() as Wire,
    next = candidate.asJSON() as Wire;
  for (const key of ['schema', 'semantic_version', 'graph_id'])
    if (!equalJSON(old[key], next[key]))
      eventError('Unsupported identity/schema transition', 'unsupported_contract');
  const a = base.definition.nodes,
    b = candidate.nodes;
  const facts: Wire[] = [];
  const tombstones = new Map(base.tombstones.map((t) => [t.node_id as string, t]));
  for (const id of Object.keys(b)
    .filter((id) => !Object.hasOwn(a, id))
    .sort(scalarOrder)) {
    const t = tombstones.get(id),
      node = b[id]!;
    if (t && (node.kind !== t.kind || node.mutable !== t.mutable))
      eventError('Restoration changes retained policy');
    facts.push(t ? { type: 'NodeRestored', node, tombstone: t } : { type: 'NodeCreated', node });
  }
  const common = Object.keys(a)
    .filter((id) => Object.hasOwn(b, id))
    .sort(scalarOrder);
  for (const id of common) {
    const x = a[id]! as unknown as Wire,
      y = b[id]! as unknown as Wire;
    for (const key of ['kind', 'role_variant'])
      if (!equalJSON(optional(x, key), optional(y, key)))
        eventError('Ordinary facts cannot change identity/variant');
    if (x.mutable !== y.mutable) {
      if (migrationID === null) eventError('Ordinary facts cannot change creation policy');
      facts.push({
        type: 'CreationPolicyMigrated',
        node_id: id,
        before: x.mutable,
        after: y.mutable,
        migration_id: migrationID,
      });
      if (tombstones.has(id))
        tombstones.set(id, frozenObject({ ...tombstones.get(id), mutable: y.mutable }));
    }
    const changed = fields
      .filter((k) => !equalJSON(optional(x, k), optional(y, k)))
      .sort(scalarOrder);
    if (changed.length)
      facts.push({
        type: 'NodeFieldsSet',
        node_id: id,
        before: Object.fromEntries(changed.map((k) => [k, optional(x, k)])),
        after: Object.fromEntries(changed.map((k) => [k, optional(y, k)])),
      });
  }
  const changed = graphFields.filter((k) => !equalJSON(old[k], next[k]));
  if (changed.length)
    facts.push({
      type: 'GraphFieldsSet',
      before: Object.fromEntries(changed.map((k) => [k, old[k]])),
      after: Object.fromEntries(changed.map((k) => [k, next[k]])),
    });
  if (!equalJSON(old.roots, next.roots))
    facts.push({ type: 'RootsAssigned', before: old.roots, after: next.roots });
  for (const [field, tag] of [
    ['members', 'MembersAssigned'],
    ['uses', 'UsesAssigned'],
  ] as const)
    for (const id of common) {
      const x = a[id]! as unknown as Wire,
        y = b[id]! as unknown as Wire;
      if (Object.hasOwn(x, field) && !equalJSON(x[field], y[field]))
        facts.push({ type: tag, node_id: id, before: x[field], after: y[field] });
    }
  const ap = new Map(base.definition.publications.map((p, i) => [p.publication_id, { i, p }]));
  const bp = new Map(candidate.publications.map((p, i) => [p.publication_id, { i, p }]));
  for (const id of [...new Set([...ap.keys(), ...bp.keys()])].sort(scalarOrder)) {
    const x = ap.get(id),
      y = bp.get(id);
    if (!y) facts.push({ type: 'PublicationRemoved', before: x!.p, position: x!.i });
    else if (!x || x.i !== y.i || !equalJSON(x.p, y.p))
      facts.push({
        type: 'PublicationPut',
        before: x ? { present: true, value: x.p } : { present: false },
        after: y.p,
        position: y.i,
      });
  }
  if (!equalJSON(old.presentations, next.presentations))
    facts.push({
      type: 'PresentationsAssigned',
      before: old.presentations,
      after: next.presentations,
    });
  for (const id of Object.keys(a)
    .filter((id) => !Object.hasOwn(b, id))
    .sort(scalarOrder)) {
    const n = parseCounter(base.revision) + 1n;
    if (n > MAX_COUNTER) eventError('Revision exhausted', 'limit_exceeded');
    const t = frozenObject({
      node_id: id,
      kind: a[id]!.kind,
      mutable: a[id]!.mutable,
      deleted_revision: String(n),
    });
    tombstones.set(id, t);
    facts.push({ type: 'NodeDeleted', node_id: id, before: a[id], tombstone: t });
  }
  if (migrationID !== null && facts.length)
    facts.unshift({
      type: 'SemanticMigrated',
      before: old.semantic_version,
      after: next.semantic_version,
      migration_id: migrationID,
      source_mapping: sourceMapping,
    });
  return new ResolvedChange(
    candidate,
    facts,
    [...tombstones.keys()].sort(scalarOrder).map((id) => tombstones.get(id)!),
    migrationID,
    sourceMapping,
  );
}
export function resolveFacts(base: AcceptedState, candidate: GraphDefinition): ResolvedChange {
  return resolve(base, candidate);
}
export function resolveMigration(
  base: AcceptedState,
  candidate: GraphDefinition,
  options: { migrationID: string; exactDiff: unknown; sourceMapping: unknown },
): ResolvedChange {
  validateID(options.migrationID);
  if (!equalJSON(options.exactDiff, definitionDiff(base.definition, candidate).asJSON()))
    eventError('Migration exact diff mismatch');
  const a = new Set(Object.keys(base.definition.nodes)),
    b = new Set(Object.keys(candidate.nodes));
  const expected = {
    retained_ids: [...a].filter((id) => b.has(id)).sort(scalarOrder),
    new_ids: [...b].filter((id) => !a.has(id)).sort(scalarOrder),
    deleted_ids: [...a].filter((id) => !b.has(id)).sort(scalarOrder),
  };
  if (!equalJSON(options.sourceMapping, expected)) eventError('Migration source mapping mismatch');
  return resolve(base, candidate, options.migrationID, frozenObject(expected));
}
function provenance(value: unknown, kind: 'bootstrap' | 'migration', source: string): Wire {
  const p = object(
    value,
    'kind approval_ref source_digest' + (kind === 'migration' ? ' migration_id exact_diff' : ''),
  );
  if (p.kind !== kind || digest(p.source_digest) !== source)
    eventError('Provenance kind/source mismatch');
  validateID(p.approval_ref);
  if (kind === 'migration') validateID(p.migration_id);
  return p;
}
export interface EventOptions {
  readonly commandDigest: string;
  readonly reason: string;
  readonly migration?: unknown;
}
export function bootstrapEvent(
  base: UnseededState,
  seed: GraphDefinition | BootstrapCandidate,
  options: EventOptions & { approvalRef: string },
): JSONObject {
  const definition = seed instanceof BootstrapCandidate ? seed.definition : seed;
  if (
    !(base instanceof UnseededState) ||
    !GraphDefinition.isValidated(definition) ||
    definition.graph_id !== base.graph_id
  )
    eventError('Invalid bootstrap endpoint');
  if (options.migration !== undefined) eventError('Bootstrap provenance is derived');
  validateID(options.approvalRef);
  return frozenObject({
    type: 'GraphChangeCommitted',
    graph_id: base.graph_id,
    semantic_version: '1',
    base_revision: '0',
    result_revision: '1',
    before_digest: base.definitionDigest,
    after_digest: definition.digest(),
    resolved_facts: [{ type: 'GraphSeeded', before: null, after: definition.asJSON() }],
    command_digest: digest(options.commandDigest),
    reason: reason(options.reason),
    migration: {
      kind: 'bootstrap',
      approval_ref: options.approvalRef,
      source_digest: base.definitionDigest,
    },
  });
}
export function changeEvent(
  base: AcceptedState,
  change: ResolvedChange,
  options: EventOptions,
): JSONObject {
  digest(options.commandDigest);
  reason(options.reason);
  let expected: ResolvedChange;
  if (change.migrationID !== null) {
    const p = provenance(options.migration, 'migration', base.definitionDigest);
    if (p.migration_id !== change.migrationID) eventError('Migration ID mismatch');
    expected = resolveMigration(base, change.candidate, {
      migrationID: change.migrationID,
      exactDiff: p.exact_diff,
      sourceMapping: change.sourceMapping,
    });
  } else {
    if (options.migration != null) eventError('Ordinary change carries provenance');
    expected = resolveFacts(base, change.candidate);
  }
  if (
    !equalJSON(expected.facts, change.facts) ||
    !equalJSON(expected.tombstones, change.tombstones)
  )
    eventError('Change does not belong to base');
  if (change.noop)
    return frozenObject({
      type: 'CommandCompleted',
      graph_id: base.definition.graph_id,
      revision: base.revision,
      command_digest: options.commandDigest,
      status: 'noop',
    });
  const revision = parseCounter(base.revision) + 1n;
  if (revision > MAX_COUNTER) eventError('Revision exhausted', 'limit_exceeded');
  return frozenObject({
    type: 'GraphChangeCommitted',
    graph_id: base.definition.graph_id,
    semantic_version: '1',
    base_revision: base.revision,
    result_revision: String(revision),
    before_digest: base.definitionDigest,
    after_digest: change.candidate.digest(),
    resolved_facts: change.facts,
    command_digest: options.commandDigest,
    reason: options.reason,
    ...(options.migration == null ? {} : { migration: options.migration }),
  });
}
export interface ApplyFactsOptions {
  readonly tombstones: unknown;
  readonly revision: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly resolvedFactDigest?: string;
  readonly publicationContracts?: PublicationContracts;
  readonly migration?: unknown;
}
/** Re-normalization checks exact closed shapes, preconditions, ordering and omissions. */
export function applyFacts(
  base: AcceptedState,
  facts: unknown,
  options: ApplyFactsOptions,
): RevisionState {
  checked(base);
  const n = parseCounter(options.revision);
  if (n !== parseCounter(base.revision) + 1n || n > MAX_COUNTER)
    eventError('Result revision must be next counter');
  if (digest(options.beforeDigest) !== base.definitionDigest)
    eventError('Stale definition digest', 'revision_conflict');
  digest(options.afterDigest);
  const raw = array(thawJSON(decodeResolvedFacts(facts)));
  if (!raw.length) eventError('No-op must not produce revision');
  if (
    options.resolvedFactDigest !== undefined &&
    digest(options.resolvedFactDigest) !== factsDigest(raw)
  )
    eventError('Fact digest mismatch');
  const wire = base.definition.asJSON() as Wire;
  const nodes = new Map(
    Object.entries(base.definition.nodes).map(([id, node]) => [id, thawJSON(node) as Wire]),
  );
  const pubs = new Map(base.definition.publications.map((p) => [p.publication_id, thawJSON(p)]));
  const positions = new Map(base.definition.publications.map((p, i) => [p.publication_id, i]));
  const locales = new Map(
    base.definition.presentations.catalogs.map((c) => [
      c.locale,
      c.entries.map((e) => thawJSON(e) as Wire),
    ]),
  );
  let presentations: unknown,
    sourceMapping: unknown = null;
  const p =
    options.migration == null
      ? null
      : provenance(options.migration, 'migration', base.definitionDigest);
  const migrationID = p === null ? null : validateID(p.migration_id);
  const deleted = new Set<string>();
  for (const value of raw) {
    const f = object(
      value,
      'type',
      'node node_id before after tombstone position locale migration_id source_mapping',
    );
    const id = Object.hasOwn(f, 'node_id') ? validateID(f.node_id) : '';
    switch (f.type) {
      case 'SemanticMigrated':
        if (migrationID === null || f.migration_id !== migrationID)
          eventError('Missing migration provenance');
        sourceMapping = f.source_mapping;
        break;
      case 'CreationPolicyMigrated':
        if (migrationID === null || f.migration_id !== migrationID || !nodes.has(id))
          eventError('Invalid policy migration');
        nodes.get(id)!.mutable = f.after;
        break;
      case 'GraphFieldsSet':
        Object.assign(wire, object(f.after, '', graphFields.join(' ')));
        break;
      case 'PresentationsAssigned':
        presentations = f.after;
        break;
      case 'NodeCreated':
      case 'NodeRestored': {
        const node = object(
          f.node,
          'node_id',
          'kind name description mutable uses extensions instructions instruction_template role_variant members binding input_contract',
        );
        const key = validateID(node.node_id);
        if (nodes.has(key)) eventError('Identity already exists');
        nodes.set(key, node);
        break;
      }
      case 'NodeFieldsSet': {
        if (!nodes.has(id)) eventError('Missing field target');
        for (const [key, value] of Object.entries(object(f.after, '', fields.join(' ')))) {
          const v = unwrap(value);
          if (v.present)
            Object.defineProperty(nodes.get(id)!, key, {
              value: v.value,
              writable: true,
              configurable: true,
              enumerable: true,
            });
          else delete nodes.get(id)![key];
        }
        break;
      }
      case 'MembersAssigned':
      case 'UsesAssigned':
        if (!nodes.has(id)) eventError('Missing relation target');
        nodes.get(id)![f.type === 'MembersAssigned' ? 'members' : 'uses'] = f.after;
        break;
      case 'RootsAssigned':
        wire.roots = f.after;
        break;
      case 'NodeDeleted':
        if (!nodes.has(id) || deleted.has(id)) eventError('Missing/duplicate deletion target');
        deleted.add(id);
        break;
      case 'PublicationPut':
      case 'PublicationRemoved': {
        const pub = object(
          f.type === 'PublicationPut' ? f.after : f.before,
          'publication_id',
          'kind name description opens_id model_may_open uri mime_type method path',
        );
        const key = validateID(pub.publication_id);
        if (f.type === 'PublicationPut') {
          if (typeof f.position !== 'number' || !Number.isSafeInteger(f.position) || f.position < 0)
            eventError('Invalid publication position');
          pubs.set(key, thawJSON(pub));
          positions.set(key, f.position);
        } else {
          if (!pubs.has(key)) eventError('Missing publication removal target');
          pubs.delete(key);
          positions.delete(key);
        }
        break;
      }
      case 'PresentationPut':
      case 'PresentationRemoved': {
        if (typeof f.locale !== 'string' || !locales.has(f.locale))
          eventError('Legacy catalog creation unsupported', 'unsupported_contract');
        const entry = object(
          f.type === 'PresentationPut' ? f.after : f.before,
          'node_id',
          'title description',
        );
        const key = validateID(entry.node_id),
          entries = locales.get(f.locale)!;
        const i = entries.findIndex((e) => e.node_id === key);
        if (f.type === 'PresentationRemoved') {
          if (i < 0) eventError('Missing presentation removal target');
          entries.splice(i, 1);
        } else if (i < 0) entries.push(entry);
        else entries[i] = entry;
        break;
      }
      default:
        eventError('Unknown required fact type', 'unsupported_contract');
    }
  }
  wire.nodes = [...nodes.keys()]
    .sort(scalarOrder)
    .filter((id) => !deleted.has(id))
    .map((id) => nodes.get(id)!);
  if (
    !equalJSON(
      [...positions.values()].sort((a, b) => a - b),
      Array.from({ length: positions.size }, (_, i) => i),
    )
  )
    eventError('Publication positions must form complete permutation');
  wire.publications = [...pubs.keys()]
    .sort((a, b) => positions.get(a)! - positions.get(b)!)
    .map((id) => pubs.get(id)!);
  wire.presentations =
    presentations === undefined
      ? {
          default_locale: base.definition.presentations.default_locale,
          catalogs: [...locales].map(([locale, entries]) => ({ locale, entries })),
        }
      : presentations;
  const candidate = GraphDefinition.fromJSON(wire, options.publicationContracts);
  const expected =
    migrationID === null
      ? resolveFacts(base, candidate)
      : resolveMigration(base, candidate, { migrationID, exactDiff: p!.exact_diff, sourceMapping });
  const expectedFacts = raw.some((v) =>
    ['PresentationPut', 'PresentationRemoved'].includes(String((v as Wire).type)),
  )
    ? legacyFacts(base.definition, candidate, expected.facts)
    : expected.facts;
  if (!equalJSON(raw, expectedFacts))
    eventError('Facts are not complete normalized base-to-candidate patch');
  if (!equalJSON(expected.tombstones, retained(options.tombstones, options.revision)))
    eventError('Retained tombstone mismatch');
  if (candidate.digest() !== options.afterDigest) eventError('Final digest mismatch');
  return new RevisionState(candidate, options.revision, expected.tombstones);
}
function legacyFacts(
  base: GraphDefinition,
  candidate: GraphDefinition,
  facts: readonly JSONObject[],
): unknown[] {
  const a = base.presentations,
    b = candidate.presentations;
  if (
    a.default_locale !== b.default_locale ||
    !equalJSON(
      a.catalogs.map((c) => c.locale),
      b.catalogs.map((c) => c.locale),
    )
  )
    eventError('Ambiguous legacy catalog order/default');
  const legacy: Wire[] = [];
  a.catalogs.forEach((c, i) => {
    const x = new Map(c.entries.map((e) => [e.node_id, e])),
      y = new Map(b.catalogs[i]!.entries.map((e) => [e.node_id, e]));
    if (
      !equalJSON(
        [...y.keys()],
        [...x.keys()]
          .filter((id) => y.has(id))
          .concat([...y.keys()].filter((id) => !x.has(id)).sort(scalarOrder)),
      )
    )
      eventError('Ambiguous legacy entry order');
    for (const id of [...new Set([...x.keys(), ...y.keys()])].sort(scalarOrder)) {
      if (!y.has(id))
        legacy.push({ type: 'PresentationRemoved', locale: c.locale, before: x.get(id) });
      else if (!x.has(id) || !equalJSON(x.get(id), y.get(id)))
        legacy.push({
          type: 'PresentationPut',
          locale: c.locale,
          before: x.has(id) ? { present: true, value: x.get(id) } : { present: false },
          after: y.get(id),
        });
    }
  });
  return facts.flatMap((f) => (f.type === 'PresentationsAssigned' ? legacy : [f]));
}
export interface ApplyEventOptions {
  readonly tombstones: unknown;
  readonly publicationContracts?: PublicationContracts;
}
/** Closed structural decoding; endpoint preconditions are verified by applyFacts. */
export function decodeResolvedFacts(value: unknown): readonly JSONObject[] {
  const raw = value instanceof Uint8Array ? decodeJSON(value) : value;
  const shapes: Record<string, string> = {
    GraphSeeded: 'type before after',
    NodeCreated: 'type node',
    NodeRestored: 'type node tombstone',
    NodeFieldsSet: 'type node_id before after',
    GraphFieldsSet: 'type before after',
    RootsAssigned: 'type before after',
    MembersAssigned: 'type node_id before after',
    UsesAssigned: 'type node_id before after',
    PublicationPut: 'type before after position',
    PublicationRemoved: 'type before position',
    PresentationsAssigned: 'type before after',
    NodeDeleted: 'type node_id before tombstone',
    SemanticMigrated: 'type before after migration_id source_mapping',
    CreationPolicyMigrated: 'type node_id before after migration_id',
    PresentationPut: 'type locale before after',
    PresentationRemoved: 'type locale before',
  };
  return Object.freeze(
    array(freezeJSON(raw)).map((raw) => {
      const tag = object(
        raw,
        'type',
        'node node_id before after tombstone position locale migration_id source_mapping',
      );
      if (typeof tag.type !== 'string' || !Object.hasOwn(shapes, tag.type))
        eventError('Unknown required fact type', 'unsupported_contract');
      const f = object(raw, shapes[tag.type]!);
      if (Object.hasOwn(f, 'node_id')) validateID(f.node_id);
      if (Object.hasOwn(f, 'migration_id')) validateID(f.migration_id);
      if (
        Object.hasOwn(f, 'position') &&
        (typeof f.position !== 'number' || !Number.isSafeInteger(f.position) || f.position < 0)
      )
        eventError('Invalid fact position');
      if (f.type === 'NodeFieldsSet')
        for (const side of ['before', 'after'])
          for (const v of Object.values(object(f[side], '', fields.join(' ')))) unwrap(v);
      if (f.type === 'GraphFieldsSet')
        for (const side of ['before', 'after']) object(f[side], '', graphFields.join(' '));
      if (f.type === 'PublicationPut' || f.type === 'PresentationPut') unwrap(f.before);
      return frozenObject(f);
    }),
  );
}
export function decodeGraphEvent(value: unknown): JSONObject {
  const raw = freezeJSON(value instanceof Uint8Array ? decodeJSON(value) : value);
  const tag = object(
    raw,
    'type',
    'graph_id semantic_version base_revision result_revision before_digest after_digest resolved_facts command_digest reason migration revision status',
  );
  if (tag.type === 'CommandCompleted') {
    const e = object(raw, 'type graph_id revision command_digest status');
    validateID(e.graph_id);
    if (parseCounter(e.revision) === 0n || e.status !== 'noop') eventError('Invalid no-op event');
    digest(e.command_digest);
    return frozenObject(e);
  }
  if (tag.type !== 'GraphChangeCommitted')
    eventError('Unknown required event type', 'unsupported_contract');
  const e = object(
    raw,
    'type graph_id semantic_version base_revision result_revision before_digest after_digest resolved_facts command_digest reason',
    'migration',
  );
  validateID(e.graph_id);
  if (e.semantic_version !== '1') eventError('Unsupported event version', 'unsupported_contract');
  if (parseCounter(e.result_revision) !== parseCounter(e.base_revision) + 1n)
    eventError('Invalid event revision sequence');
  digest(e.before_digest);
  digest(e.after_digest);
  digest(e.command_digest);
  reason(e.reason);
  const facts = decodeResolvedFacts(e.resolved_facts);
  if (!facts.length) eventError('Graph change requires nonempty facts');
  if (Object.hasOwn(e, 'migration')) {
    const kind = e.base_revision === '0' ? 'bootstrap' : 'migration';
    provenance(e.migration, kind, e.before_digest as string);
  }
  return frozenObject(e);
}
export function applyEvent(
  base: AcceptedState | UnseededState,
  event: unknown,
  options: ApplyEventOptions,
): RevisionState {
  const raw = thawJSON(decodeGraphEvent(event));
  if (base instanceof UnseededState) {
    const e = object(
      raw,
      'type graph_id semantic_version base_revision result_revision before_digest after_digest resolved_facts command_digest reason migration',
    );
    const p = provenance(e.migration, 'bootstrap', base.definitionDigest),
      facts = array(e.resolved_facts);
    if (facts.length !== 1 || !equalJSON(options.tombstones, []))
      eventError('Bootstrap requires one fact and no tombstones');
    const f = object(facts[0], 'type before after');
    if (f.type !== 'GraphSeeded' || f.before !== null) eventError('Invalid bootstrap fact');
    const definition = GraphDefinition.fromJSON(f.after, options.publicationContracts);
    const expected = bootstrapEvent(base, definition, {
      commandDigest: digest(e.command_digest),
      reason: reason(e.reason),
      approvalRef: validateID(p.approval_ref),
    });
    if (!equalJSON(expected, e)) eventError('Bootstrap is not exact normalized transition');
    return new RevisionState(definition, '1');
  }
  checked(base);
  const tag = object(
    raw,
    'type',
    'graph_id semantic_version base_revision result_revision before_digest after_digest resolved_facts command_digest reason migration revision status',
  );
  if (tag.type === 'CommandCompleted') {
    const e = object(raw, 'type graph_id revision command_digest status');
    digest(e.command_digest);
    if (
      e.graph_id !== base.definition.graph_id ||
      e.revision !== base.revision ||
      e.status !== 'noop' ||
      !equalJSON(base.tombstones, options.tombstones)
    )
      eventError('No-op disagrees with base');
    return base instanceof RevisionState
      ? base
      : new RevisionState(base.definition, base.revision, base.tombstones);
  }
  if (tag.type !== 'GraphChangeCommitted')
    eventError('Unknown required event type', 'unsupported_contract');
  const e = object(
    raw,
    'type graph_id semantic_version base_revision result_revision before_digest after_digest resolved_facts command_digest reason',
    'migration',
  );
  if (
    e.graph_id !== base.definition.graph_id ||
    e.semantic_version !== '1' ||
    e.base_revision !== base.revision
  )
    eventError('Graph event identity/schema/revision mismatch');
  digest(e.command_digest);
  reason(e.reason);
  return applyFacts(base, e.resolved_facts, {
    ...options,
    revision: e.result_revision as string,
    beforeDigest: digest(e.before_digest),
    afterDigest: digest(e.after_digest),
    migration: e.migration,
  });
}
/** Graph-local verified records, not the store-wide hash-chain/receipt protocol. */
export interface EventRecord {
  readonly journalSeq: string;
  readonly event: JSONObject;
  readonly tombstones: readonly JSONObject[];
}
export function decodeEventRecords(value: unknown): readonly EventRecord[] {
  const raw = value instanceof Uint8Array ? decodeJSON(value) : value;
  return Object.freeze(
    array(freezeJSON(raw)).map((value) => {
      const r = object(value, 'journal_seq event tombstones');
      if (parseCounter(r.journal_seq) === 0n) eventError('Record sequence must be positive');
      const event = decodeGraphEvent(r.event);
      return Object.freeze({
        journalSeq: r.journal_seq as string,
        event: frozenObject(event),
        tombstones: retained(r.tombstones, (event.result_revision ?? event.revision) as string),
      });
    }),
  );
}
export function applyEventRecords(
  base: AcceptedState | UnseededState,
  records: unknown,
  options: { afterSeq?: string; publicationContracts?: PublicationContracts } = {},
): Readonly<{ state: RevisionState; journalSeq: string }> {
  let state: AcceptedState | UnseededState = base,
    seq = options.afterSeq ?? '0';
  parseCounter(seq);
  const decoded = decodeEventRecords(records);
  if (!decoded.length) eventError('Expected nonempty graph record batch');
  for (const record of decoded) {
    if (parseCounter(record.journalSeq) <= parseCounter(seq))
      eventError('Record sequences must increase');
    state = applyEvent(state, record.event, {
      tombstones: record.tombstones,
      ...(options.publicationContracts === undefined
        ? {}
        : { publicationContracts: options.publicationContracts }),
    });
    seq = record.journalSeq;
  }
  return Object.freeze({ state: state as RevisionState, journalSeq: seq });
}
