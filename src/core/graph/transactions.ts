/** WP11 candidate PURE ordinary transaction slice, not admission, commit or a wire release.
 * No storage, clock, authorization, registry lookup, binding resolution or execution.
 * A Host MUST authorize reads/impact/references/root operations, fence authority,
 * check idempotent receipts before CAS, and append facts+receipt atomically.
 */
import { createHash } from 'node:crypto';
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
import type { FrozenJSON, GraphErrorCode } from './canonical.js';
import { GraphIndex } from './index.js';
import { GraphDefinition, normalizeLocale, placements, PublicationContract } from './model.js';
import type { JSONObject, PublicationContracts, Slot } from './model.js';
import { protectChange } from './policy.js';
import type { ProtectionReport } from './policy.js';

type Wire = { [key: string]: FrozenJSON };
type DraftObject = { [key: string]: unknown };
const slots: readonly Slot[] = ['pre_process', 'children', 'post_process', 'skills', 'tools'];
const singleton = new Set<string>(['pre_process', 'post_process']);
const updates = [
  'description',
  'instructions',
  'instruction_template',
  'extensions',
  'binding',
  'input_contract',
];
const unsettable = new Set(['instructions', 'instruction_template', 'binding', 'input_contract']);

export const SUPPORTED_COMMANDS = Object.freeze([
  'create_node',
  'update_node',
  'rename_node',
  'attach_node',
  'move_node',
  'detach_node',
  'reorder_members',
  'add_root',
  'remove_root',
  'add_use',
  'remove_use',
  'delete_nodes',
  'restore_nodes',
  'replace_subtree',
  'import',
  'reconcile',
  'put_publication',
  'remove_publication',
  'put_presentation',
  'remove_presentation',
]);
export const UNSUPPORTED_COMMANDS: readonly string[] = Object.freeze([]);

function fail(
  message: string,
  code: GraphErrorCode | 'history_unavailable' | 'scope_escape' = 'schema_invalid',
): never {
  // The shared diagnostic union is owned by a different slice. Preserve the
  // candidate oracle's runtime codes without changing canonical.ts.
  throw new GraphError(code as GraphErrorCode, message);
}
function object(value: unknown, required: string, optional = ''): Wire {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('Expected closed object');
  const allowed = new Set(`${required} ${optional}`.split(' ').filter(Boolean));
  if (
    required
      .split(' ')
      .filter(Boolean)
      .some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    fail('Missing required or unknown fields');
  return value as Wire;
}
function array(value: unknown): readonly FrozenJSON[] {
  if (!Array.isArray(value)) fail('Expected array');
  return value as readonly FrozenJSON[];
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) fail('Expected nonempty text');
  return value;
}
function ids(value: unknown): string[] {
  const result = array(value).map((id) => validateID(id));
  if (new Set(result).size !== result.length) fail('Duplicate identity');
  return result;
}
function position(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    fail('Insertion position is outside resulting sequence');
  return value;
}
function slot(value: unknown): Slot {
  if (typeof value !== 'string' || !slots.includes(value as Slot))
    fail('Invalid typed member slot');
  return value as Slot;
}
function plane(value: unknown): 'model' | 'prompt' {
  if (value !== 'model' && value !== 'prompt') fail('Invalid root plane');
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJSON(a)).equals(Buffer.from(canonicalJSON(b)));
}
function scalarOrder(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Local NodeSpec decoder via existing model validation, NOT serving validation.
 * Synthetic reference targets and the inert binding below exist only in this
 * detached shape probe; none enter a candidate or trigger registry resolution.
 */
function nodeShape(value: unknown): Wire {
  const raw = object(
    value,
    'node_id kind name description',
    'mutable uses extensions instructions instruction_template role_variant members binding input_contract',
  );
  const id = validateID(raw.node_id);
  const probe = thawJSON(raw) as DraftObject;
  const missingBinding = raw.kind === 'tool' && !Object.hasOwn(raw, 'binding');
  if (missingBinding)
    probe.binding = {
      kind: 'registered',
      binding_id: 'shape-only',
      version: '1',
      portability: { kind: 'portable', contract_id: 'shape-only' },
    };
  const targets = new Set<string>();
  for (const target of ids(raw.uses ?? [])) targets.add(target);
  if (raw.instruction_template !== undefined) {
    const template = object(raw.instruction_template, 'parts');
    for (const part of array(template.parts)) {
      const p = object(part, 'kind', 'text target_id label');
      if (p.kind === 'NodeRef') targets.add(validateID(p.target_id));
    }
  }
  // create_node forbids containment, so no artificial ownership is inferred.
  if (raw.members !== undefined) {
    const members = object(raw.members, '', slots.join(' '));
    for (const key of slots) {
      if (!Object.hasOwn(members, key)) continue;
      if (singleton.has(key)) validateID(members[key]);
      else if (ids(members[key]).length) fail('Create relations must be empty');
      if (singleton.has(key)) fail('Create relations must be empty');
    }
  }
  const placeholders = [...targets]
    .filter((target) => target !== id)
    .map((target) => ({
      node_id: target,
      kind: 'skill',
      name: target,
      description: 'shape',
      instructions: '',
    }));
  // Placeholder names need not be valid author names: use safe distinct names.
  placeholders.forEach((node, i) => {
    node.name = `${raw.name === `target-${i}` ? 'other-' : ''}target-${i}`;
  });
  const nodes = [probe, ...placeholders];
  const definition = GraphDefinition.fromJSON({
    schema: 'contexture.graph/v1',
    semantic_version: '1',
    graph_id: 'shape',
    application_name: 'shape',
    mode: 'runtime',
    nodes,
    roots: nodes.map((node, i) => ({ node_id: node.node_id, plane: i === 0 ? 'model' : 'prompt' })),
    presentations: { default_locale: 'en', catalogs: [] },
  });
  const normalized = thawJSON(definition.nodes[id]) as Wire;
  if (missingBinding) delete normalized.binding;
  return normalized;
}

export interface TransactionLimits {
  readonly max_commands: number;
  readonly max_transaction_bytes: number;
  readonly max_definition_bytes: number;
  readonly max_resolved_bytes: number;
  readonly max_nodes: number;
  readonly max_edges: number;
  readonly max_depth: number;
  readonly max_node_bytes: number;
  readonly max_expanded_operations: number;
}
export const DEFAULT_LIMITS: TransactionLimits = Object.freeze({
  max_commands: 10000,
  max_transaction_bytes: 16 * 1024 * 1024,
  max_definition_bytes: 256 * 1024 * 1024,
  max_resolved_bytes: 64 * 1024 * 1024,
  max_nodes: 100000,
  max_edges: 1000000,
  max_depth: 1024,
  max_node_bytes: 1024 * 1024,
  max_expanded_operations: 2000000,
});
function limitsValue(value: TransactionLimits): TransactionLimits {
  const obj = object(freezeJSON(value), Object.keys(DEFAULT_LIMITS).join(' '));
  for (const entry of Object.values(obj))
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0)
      fail('Limits must be positive safe integers');
  return obj as unknown as TransactionLimits;
}

function publicationShape(value: unknown): FrozenJSON {
  const pub = object(
    value,
    'kind publication_id opens_id',
    'name description model_may_open uri mime_type method path',
  );
  const target = validateID(pub.opens_id);
  const binding = {
    kind: 'registered',
    binding_id: 'shape-only',
    version: '1',
    portability: { kind: 'portable', contract_id: 'shape-only' },
  };
  const executable = pub.kind !== 'prompt';
  const contract = new PublicationContract(
    binding,
    pub.kind === 'resource' || ['GET', 'HEAD'].includes(pub.method as string)
      ? 'read_only'
      : 'write',
    true,
  );
  const graph = GraphDefinition.fromJSON(
    {
      schema: 'contexture.graph/v1',
      semantic_version: '1',
      graph_id: 'shape',
      application_name: 'shape',
      mode: 'runtime',
      nodes: [
        {
          node_id: target,
          kind: executable ? 'tool' : 'skill',
          name: 'shape',
          description: 'shape',
          ...(executable ? { binding } : { instructions: '' }),
        },
      ],
      roots: [{ node_id: target, plane: 'model' }],
      publications: [value],
      presentations: { default_locale: 'en', catalogs: [] },
    },
    { [target]: contract },
  );
  return freezeJSON(graph.publications[0]);
}

function blobReference(value: unknown): Wire {
  const ref = object(value, 'digest size media_type');
  parseCounter(ref.size);
  if (
    ref.media_type !== 'application/json' ||
    !/^sha256:[0-9a-f]{64}$/u.test(text(ref.digest)) ||
    text(ref.digest).length !== 71
  )
    fail('Invalid canonical definition blob reference');
  return ref;
}

function closure(graph: GraphDefinition, seeds: readonly string[]): Set<string> {
  const found = new Set<string>();
  const stack = seeds.filter((id) => Object.hasOwn(graph.nodes, id));
  while (stack.length) {
    const id = stack.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    const node = graph.nodes[id]!;
    if (node.kind === 'role') stack.push(...placements(node.members).map((p) => p[2]));
  }
  return found;
}
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
function checkScope(
  before: GraphDefinition,
  after: GraphDefinition,
  seeds: string[],
): [Set<string>, Set<string>] {
  if (
    !seeds.length ||
    seeds.some((id) => !Object.hasOwn(before.nodes, id) && !Object.hasOwn(after.nodes, id))
  )
    fail('Scope anchors must exist in at least one endpoint', 'scope_escape');
  const a = closure(before, seeds),
    b = closure(after, seeds);
  if (
    [...b].some((id) => !a.has(id) && Object.hasOwn(before.nodes, id)) ||
    [...a].some((id) => !b.has(id) && Object.hasOwn(after.nodes, id))
  )
    fail('Existing identity crosses the explicit scope boundary', 'scope_escape');
  const whole =
    a.size === Object.keys(before.nodes).length && b.size === Object.keys(after.nodes).length;
  if (before.application_name !== after.application_name)
    fail('Ordinary payload cannot rename application identity', 'identity_conflict');
  for (const key of ['schema', 'semantic_version', 'graph_id', 'mode', 'extensions'] as const)
    if (!equal(before[key], after[key]) && (!whole || !['mode', 'extensions'].includes(key)))
      fail('Graph metadata lies outside the declared scope', 'scope_escape');
  const outside = (graph: GraphDefinition, scope: Set<string>) =>
    Object.keys(graph.nodes).filter((id) => !scope.has(id));
  if (!sameSet(new Set(outside(before, a)), new Set(outside(after, b))))
    fail('Candidate changes identities outside scope', 'scope_escape');
  const projection = (graph: GraphDefinition, id: string, scope: Set<string>) => {
    const node = thawJSON(graph.nodes[id]) as DraftObject;
    if (node.kind === 'role') {
      const members = node.members as DraftObject;
      for (const key of slots)
        if (singleton.has(key)) {
          if (scope.has(members[key] as string)) delete members[key];
        } else members[key] = (members[key] as string[]).filter((n) => !scope.has(n));
    }
    return node;
  };
  for (const id of outside(before, a))
    if (!equal(projection(before, id, a), projection(after, id, b)))
      fail('Candidate changes an outside node or boundary reference', 'scope_escape');
  if (
    !equal(
      before.roots.filter((v) => !a.has(v.node_id)),
      after.roots.filter((v) => !b.has(v.node_id)),
    ) ||
    !equal(
      before.publications.filter((v) => !a.has(v.opens_id)),
      after.publications.filter((v) => !b.has(v.opens_id)),
    )
  )
    fail('Candidate changes outside placement/publication', 'scope_escape');
  for (const pub of after.publications) {
    const old = before.publications.find((p) => p.publication_id === pub.publication_id);
    if (old && a.has(old.opens_id) !== b.has(pub.opens_id))
      fail('Publication identity crosses scope', 'scope_escape');
  }
  if (!whole) {
    if (before.presentations.default_locale !== after.presentations.default_locale)
      fail('Default locale lies outside partial node scope', 'scope_escape');
    const existing = new Set(before.presentations.catalogs.map((c) => c.locale));
    const projection = (graph: GraphDefinition, scope: Set<string>) =>
      graph.presentations.catalogs
        .filter((c) => existing.has(c.locale))
        .map((c) => ({
          locale: c.locale,
          entries: c.entries.filter((e) => !scope.has(e.node_id)),
        }));
    if (
      !equal(projection(before, a), projection(after, b)) ||
      after.presentations.catalogs.some(
        (c) =>
          !existing.has(c.locale) &&
          (!c.entries.length || c.entries.some((e) => !b.has(e.node_id))),
      )
    )
      fail('Candidate changes outside presentation catalogs', 'scope_escape');
  }
  return [a, b];
}

function normalizeCommand(value: unknown): Wire {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('Expected typed command');
  const op = text((value as Wire).op);
  if (!SUPPORTED_COMMANDS.includes(op))
    fail(`Unsupported pure candidate command: ${op}`, 'unsupported_contract');
  const shapes: Record<string, readonly [string, string]> = {
    create_node: ['node', ''],
    update_node: ['node_id set_fields unset_fields', ''],
    rename_node: ['node_id new_name', ''],
    attach_node: ['node_id target', ''],
    move_node: ['node_id target', ''],
    detach_node: ['node_id', ''],
    reorder_members: ['parent_id slot node_ids', ''],
    add_root: ['node_id plane position', ''],
    remove_root: ['node_id', ''],
    add_use: ['source_id target_id', 'position'],
    remove_use: ['source_id target_id', ''],
    delete_nodes: ['targets policy deleted_ids disconnections', ''],
    restore_nodes: ['revision node_ids', ''],
    replace_subtree: ['anchor_id id_mapping payload', ''],
    import: ['scope_ids id_mapping payload', ''],
    reconcile: ['scope_ids id_mapping payload', ''],
    put_publication: ['publication', ''],
    remove_publication: ['publication_id', ''],
    put_presentation: ['locale presentation', ''],
    remove_presentation: ['locale node_id', ''],
  };
  const shape = shapes[op]!;
  const obj = { ...object(value, `op ${shape[0]}`, shape[1]) };
  for (const key of [
    'node_id',
    'parent_id',
    'source_id',
    'target_id',
    'anchor_id',
    'publication_id',
  ])
    if (Object.hasOwn(obj, key)) validateID(obj[key]);
  if (Object.hasOwn(obj, 'position')) position(obj.position, Number.MAX_SAFE_INTEGER);
  if (Object.hasOwn(obj, 'plane')) plane(obj.plane);
  if (Object.hasOwn(obj, 'slot')) slot(obj.slot);
  for (const key of ['node_ids', 'scope_ids', 'targets', 'deleted_ids'])
    if (Object.hasOwn(obj, key)) obj[key] = ids(obj[key]);
  if (Object.hasOwn(obj, 'revision') && parseCounter(obj.revision) === 0n)
    fail('Restore requires a nonzero historical revision');
  if (Object.hasOwn(obj, 'target')) {
    const target = obj.target;
    const isMember =
      target !== null && typeof target === 'object' && Object.hasOwn(target, 'parent_id');
    const t = object(target, isMember ? 'parent_id slot position' : 'plane position');
    if (isMember) {
      validateID(t.parent_id);
      slot(t.slot);
    } else plane(t.plane);
    position(t.position, Number.MAX_SAFE_INTEGER);
  }
  if (op === 'create_node') {
    const node = nodeShape(obj.node);
    if (ids(node.uses).length) fail('Create relations must be empty; use ordered commands');
    obj.node = node;
  }
  if (op === 'rename_node') {
    nodeShape({
      node_id: 'shape',
      kind: 'skill',
      name: obj.new_name,
      description: 'shape',
      instructions: '',
    });
  }
  if (op === 'update_node') {
    const fields = { ...object(obj.set_fields, '', updates.join(' ')) };
    const unset = ids(obj.unset_fields);
    if (unset.some((key) => !unsettable.has(key) || Object.hasOwn(fields, key)))
      fail('Invalid or conflicting update fields');
    for (const [field, raw] of Object.entries(fields)) {
      const tool = field === 'binding' || field === 'input_contract';
      const probe = nodeShape({
        node_id: 'shape',
        kind: tool ? 'tool' : 'skill',
        name: 'shape',
        description: 'shape',
        ...(!tool && field !== 'instruction_template' ? { instructions: '' } : {}),
        [field]: raw,
      });
      fields[field] = probe[field]!;
    }
    obj.set_fields = fields;
    obj.unset_fields = unset;
  }
  if (op === 'put_publication') obj.publication = publicationShape(obj.publication);
  if (Object.hasOwn(obj, 'locale')) obj.locale = normalizeLocale(obj.locale);
  if (op === 'put_presentation') {
    const entry = object(obj.presentation, 'node_id', 'title description');
    validateID(entry.node_id);
    if (Object.keys(entry).length === 1) fail('Presentation requires human fields');
    for (const key of ['title', 'description']) if (Object.hasOwn(entry, key)) text(entry[key]);
  }
  if (Object.hasOwn(obj, 'id_mapping')) {
    const mapping = object(obj.id_mapping, 'retained_ids new_ids deleted_ids');
    obj.id_mapping = Object.fromEntries(
      Object.entries(mapping).map(([key, value]) => [key, ids(value)]),
    );
    const payload = object(obj.payload, '', 'inline blob');
    if (Object.keys(payload).length !== 1) fail('Exactly one inline/blob payload required');
    if (Object.hasOwn(payload, 'blob')) blobReference(payload.blob);
  }
  if (op === 'delete_nodes') {
    if (
      !ids(obj.targets).length ||
      !['reject_references', 'explicit_cascade'].includes(text(obj.policy))
    )
      fail('Explicit nonempty delete targets and policy required');
    const entries = array(obj.disconnections).map((value) => {
      const d = object(value, 'source_id target_id relation');
      validateID(d.source_id);
      validateID(d.target_id);
      if (
        !['uses', 'containment', 'instruction_template', 'publication', 'presentation'].includes(
          text(d.relation),
        )
      )
        fail('Invalid delete relation');
      return d;
    });
    if (
      new Set(entries.map((d) => Buffer.from(canonicalJSON(d)).toString())).size !== entries.length
    )
      fail('Duplicate delete disconnection');
    obj.disconnections = entries;
  }
  if (op === 'restore_nodes' && !ids(obj.node_ids).length) fail('Restore scope cannot be empty');
  return obj;
}

/** Immutable normalized request. Hash excludes key/correlation/approval, never actor evidence. */
export class TransactionEnvelope {
  readonly value: JSONObject;
  private constructor(value: Wire) {
    this.value = freezeJSON(value) as JSONObject;
    Object.freeze(this);
  }
  static fromJSON(value: unknown, limits: TransactionLimits = DEFAULT_LIMITS): TransactionEnvelope {
    limits = limitsValue(limits);
    if (value instanceof Uint8Array) {
      if (value.byteLength > limits.max_transaction_bytes)
        fail('Inline transaction budget exceeded', 'limit_exceeded');
      value = decodeJSON(value);
    }
    const obj = {
      ...object(
        freezeJSON(value),
        'schema graph_id base_revision idempotency_key commands reason correlation_id',
        'approval_ref',
      ),
    };
    if (obj.schema !== 'contexture.transaction/v1')
      fail('Ordinary candidate schema required', 'unsupported_contract');
    for (const key of ['graph_id', 'idempotency_key', 'correlation_id']) validateID(obj[key]);
    if (Object.hasOwn(obj, 'approval_ref')) validateID(obj.approval_ref);
    parseCounter(obj.base_revision);
    text(obj.reason);
    const commands = array(obj.commands);
    if (!commands.length || commands.length > limits.max_commands)
      fail('Command count outside budget', 'limit_exceeded');
    obj.commands = commands.map(normalizeCommand);
    if (canonicalJSON(obj).byteLength > limits.max_transaction_bytes)
      fail('Inline transaction budget exceeded', 'limit_exceeded');
    return new TransactionEnvelope(obj);
  }
  get commandDigest(): string {
    const subject: Wire = {};
    for (const key of ['schema', 'graph_id', 'base_revision', 'commands', 'reason'])
      subject[key] = this.value[key]!;
    return canonicalDigest(subject, 'contexture.command/v1');
  }
}

const snapshots = new WeakSet<PureRevisionState>();
/** Caller-supplied accepted snapshot, not a journal owner or a serving generation. */
export class PureRevisionState {
  readonly tombstones: readonly JSONObject[];
  constructor(
    readonly definition: GraphDefinition,
    readonly revision: string,
    tombstones: unknown = [],
  ) {
    if (!GraphDefinition.isValidated(definition) || parseCounter(revision) === 0n)
      fail('Accepted snapshot requires validated definition and nonzero revision');
    const seen = new Set<string>();
    this.tombstones = Object.freeze(
      array(freezeJSON(tombstones))
        .map((raw) => {
          const t = object(raw, 'node_id kind mutable deleted_revision');
          const id = validateID(t.node_id);
          const deleted = parseCounter(t.deleted_revision);
          if (deleted === 0n || deleted > parseCounter(revision) || seen.has(id))
            fail('Invalid retained identity history');
          seen.add(id);
          if (
            !['role', 'skill', 'tool'].includes(text(t.kind)) ||
            (typeof t.mutable !== 'boolean' && t.mutable !== 'inherit')
          )
            fail('Invalid retained creation policy');
          const live = definition.nodes[id];
          if (live && (live.kind !== t.kind || live.mutable !== t.mutable))
            fail('Live identity conflicts with tombstone', 'identity_conflict');
          return t;
        })
        .sort((a, b) => scalarOrder(a.node_id as string, b.node_id as string)),
    );
    snapshots.add(this);
    Object.freeze(this);
  }
  get definitionDigest(): string {
    return this.definition.digest();
  }
}

/** Already acquired immutable evidence only. No provider callbacks or I/O in this layer. */
export interface PureTransactionOptions {
  readonly limits?: TransactionLimits;
  readonly publicationContracts?: PublicationContracts;
  readonly history?: readonly PureRevisionState[];
  readonly payloads?: readonly Uint8Array[];
}

class Draft {
  readonly nodes = new Map<string, DraftObject>();
  roots: DraftObject[];
  wire: DraftObject;
  pubs: DraftObject[];
  catalogs: Map<string, DraftObject[]>;
  defaultLocale: string;
  readonly deleted = new Set<string>();
  readonly restored = new Set<string>();
  rootOperations = false;
  constructor(
    readonly base: PureRevisionState,
    readonly options: PureTransactionOptions,
    readonly limits: TransactionLimits,
  ) {
    for (const node of Object.values(base.definition.nodes))
      this.nodes.set(node.node_id, thawJSON(node) as DraftObject);
    this.roots = thawJSON(base.definition.roots) as DraftObject[];
    this.wire = base.definition.asJSON() as DraftObject;
    this.pubs = thawJSON(base.definition.publications) as DraftObject[];
    this.catalogs = new Map(
      base.definition.presentations.catalogs.map((c) => [
        c.locale,
        thawJSON(c.entries) as DraftObject[],
      ]),
    );
    this.defaultLocale = base.definition.presentations.default_locale;
  }
  node(value: unknown): DraftObject {
    const node = this.nodes.get(validateID(value));
    if (!node) fail('Command target must already exist', 'reference_not_found');
    return node;
  }
  templateTargets(value: unknown): void {
    for (const raw of array(object(value, 'parts').parts)) {
      const part = object(raw, 'kind', 'text target_id label');
      if (part.kind === 'NodeRef') this.node(part.target_id);
    }
  }
  members(parent: unknown): DraftObject {
    const node = this.node(parent);
    if (node.kind !== 'role') fail('Containment parent must be a Role');
    return node.members as DraftObject;
  }
  sequence(parent: unknown, key: Slot): string[] {
    const members = this.members(parent);
    return singleton.has(key)
      ? Object.hasOwn(members, key)
        ? [members[key] as string]
        : []
      : (members[key] as string[]);
  }
  assign(parent: unknown, key: Slot, values: string[]): void {
    const members = this.members(parent);
    if (singleton.has(key)) {
      if (values.length > 1) fail('Singleton member slot is occupied');
      delete members[key];
      if (values.length) members[key] = values[0];
    } else members[key] = values;
  }
  owners(id: string): { parent: string | null; key: Slot | null; position: number }[] {
    const found: { parent: string | null; key: Slot | null; position: number }[] = [];
    this.roots.forEach((root, i) => {
      if (root.node_id === id) found.push({ parent: null, key: null, position: i });
    });
    for (const [parent, node] of this.nodes)
      if (node.kind === 'role')
        for (const key of slots)
          this.sequence(parent, key).forEach((target, i) => {
            if (target === id) found.push({ parent, key, position: i });
          });
    if (found.length > 1) fail('Draft has multiple containment owners');
    return found;
  }
  detach(id: string, rootOnly = false, required = true): void {
    this.node(id);
    const owner = this.owners(id)[0];
    if (!owner) {
      if (required) fail('Node has no placement');
      return;
    }
    if (owner.parent === null) {
      this.roots.splice(owner.position, 1);
      this.rootOperations = true;
    } else {
      if (rootOnly) fail('remove_root target is not a root');
      const values = [...this.sequence(owner.parent, owner.key!)];
      values.splice(owner.position, 1);
      this.assign(owner.parent, owner.key!, values);
    }
  }
  attach(id: string, target: Wire): void {
    this.node(id);
    if (this.owners(id).length) fail('attach requires an unowned draft object');
    if (Object.hasOwn(target, 'parent_id')) {
      const key = slot(target.slot);
      const values = [...this.sequence(target.parent_id, key)];
      values.splice(position(target.position, values.length), 0, id);
      this.assign(target.parent_id, key, values);
    } else {
      this.roots.splice(position(target.position, this.roots.length), 0, {
        node_id: id,
        plane: plane(target.plane),
      });
      this.rootOperations = true;
    }
  }
  apply(command: Wire): void {
    const op = command.op;
    const id = command.node_id as string;
    if (op === 'create_node') {
      const node = thawJSON(command.node) as DraftObject;
      const identity = node.node_id as string;
      if (
        this.nodes.has(identity) ||
        this.deleted.has(identity) ||
        this.base.tombstones.some((t) => t.node_id === identity)
      )
        fail('Identity reuse requires explicit historical restore', 'identity_conflict');
      if (node.instruction_template !== undefined) this.templateTargets(node.instruction_template);
      this.nodes.set(identity, node);
    } else if (op === 'update_node' || op === 'rename_node') {
      const node = this.node(id);
      if (op === 'rename_node') node.name = command.new_name;
      else {
        const fields = command.set_fields as Wire;
        if (Object.hasOwn(fields, 'instruction_template'))
          this.templateTargets(fields.instruction_template);
        for (const key of ids(command.unset_fields)) delete node[key];
        for (const [key, value] of Object.entries(fields)) node[key] = thawJSON(value);
      }
    } else if (op === 'attach_node' || op === 'move_node' || op === 'add_root') {
      if (op === 'move_node') this.detach(id);
      this.attach(
        id,
        op === 'add_root'
          ? { plane: command.plane!, position: command.position! }
          : (command.target as Wire),
      );
    } else if (op === 'detach_node' || op === 'remove_root') this.detach(id, op === 'remove_root');
    else if (op === 'reorder_members') {
      const key = slot(command.slot);
      const current = this.sequence(command.parent_id, key);
      const values = ids(command.node_ids);
      if (current.length !== values.length || values.some((value) => !current.includes(value)))
        fail('Reorder requires exactly the existing member set');
      this.assign(command.parent_id, key, values);
    } else if (op === 'add_use' || op === 'remove_use') {
      const source = this.node(command.source_id);
      this.node(command.target_id);
      const uses = source.uses as string[];
      const target = command.target_id as string;
      if (op === 'add_use') {
        if (uses.includes(target) || command.source_id === target) fail('Duplicate or self use');
        uses.splice(position(command.position ?? uses.length, uses.length), 0, target);
      } else {
        if (!uses.includes(target)) fail('Use does not exist');
        uses.splice(uses.indexOf(target), 1);
      }
    } else if (op === 'delete_nodes') this.delete(command);
    else if (op === 'restore_nodes') this.restore(command);
    else if (['replace_subtree', 'import', 'reconcile'].includes(op as string))
      this.replace(command);
    else if (op === 'put_publication' || op === 'remove_publication') {
      const pub = command.publication as Wire;
      if (op === 'put_publication') this.node(pub.opens_id);
      const id = op === 'put_publication' ? pub.publication_id : command.publication_id;
      const i = this.pubs.findIndex((p) => p.publication_id === id);
      if (op === 'remove_publication') {
        if (i < 0) fail('Publication does not exist');
        this.pubs.splice(i, 1);
      } else if (i < 0) this.pubs.push(thawJSON(pub) as DraftObject);
      else this.pubs[i] = thawJSON(pub) as DraftObject;
    } else if (op === 'put_presentation' || op === 'remove_presentation') {
      const locale = command.locale as string;
      if (!this.catalogs.has(locale)) {
        if (op === 'remove_presentation') fail('Presentation does not exist');
        this.catalogs.set(locale, []);
      }
      const entries = this.catalogs.get(locale)!;
      const entry = op === 'put_presentation' ? (command.presentation as Wire) : { node_id: id };
      this.node(entry.node_id);
      const i = entries.findIndex((e) => e.node_id === entry.node_id);
      if (op === 'remove_presentation') {
        if (i < 0) fail('Presentation does not exist');
        entries.splice(i, 1);
      } else if (i < 0) entries.push(thawJSON(entry) as DraftObject);
      else entries[i] = thawJSON(entry) as DraftObject;
    } else fail('Unsupported pure command', 'unsupported_contract');
  }
  delete(command: Wire): void {
    const deleted = new Set(ids(command.deleted_ids));
    const closure = new Set<string>();
    const stack = ids(command.targets);
    while (stack.length) {
      const id = stack.pop()!;
      if (closure.has(id)) continue;
      const node = this.node(id);
      closure.add(id);
      if (node.kind === 'role') for (const key of slots) stack.push(...this.sequence(id, key));
    }
    if (!sameSet(deleted, closure))
      fail('deleted_ids must exactly equal the target subtree closure');
    const disconnections: Wire[] = [];
    const relation = (source_id: string, target_id: string, relation: string) =>
      disconnections.push({ source_id, target_id, relation });
    for (const id of [...deleted].sort(scalarOrder))
      for (const owner of this.owners(id))
        if (owner.parent === null || !deleted.has(owner.parent))
          relation(owner.parent ?? this.base.definition.graph_id, id, 'containment');
    for (const [source, node] of this.nodes) {
      if (deleted.has(source)) continue;
      for (const target of node.uses as string[])
        if (deleted.has(target)) relation(source, target, 'uses');
      if (node.instruction_template !== undefined)
        for (const raw of array(object(node.instruction_template, 'parts').parts)) {
          const part = raw as Wire;
          if (part.kind === 'NodeRef' && deleted.has(part.target_id as string))
            fail('Repair external NodeRef programs explicitly before delete');
        }
    }
    for (const pub of this.pubs)
      if (deleted.has(pub.opens_id as string))
        relation(pub.publication_id as string, pub.opens_id as string, 'publication');
    for (const [locale, entries] of this.catalogs)
      if (entries.some((e) => deleted.has(e.node_id as string)))
        fail('Remove target presentations explicitly before delete: ' + locale);
    const encoded = (values: readonly FrozenJSON[]) =>
      new Set(values.map((v) => Buffer.from(canonicalJSON(v)).toString()));
    if (!sameSet(encoded(disconnections), encoded(array(command.disconnections))))
      fail('Disconnections must exactly match all boundary references');
    if (
      command.policy === 'reject_references' &&
      disconnections.some((d) => d.relation !== 'containment')
    )
      fail('Delete target has external references');
    for (const id of [...deleted].sort(scalarOrder)) this.detach(id, false, false);
    for (const node of this.nodes.values())
      node.uses = (node.uses as string[]).filter((n) => !deleted.has(n));
    this.pubs = this.pubs.filter((p) => !deleted.has(p.opens_id as string));
    for (const id of deleted) {
      this.nodes.delete(id);
      this.deleted.add(id);
    }
  }
  restore(command: Wire): void {
    const revision = command.revision as string;
    if (parseCounter(revision) > parseCounter(this.base.revision))
      fail('Restore requires a past accepted revision', 'history_unavailable');
    const past = this.options.history?.find(
      (s) =>
        snapshots.has(s) &&
        s.revision === revision &&
        s.definition.graph_id === this.base.definition.graph_id,
    );
    if (!past) fail('Retained history snapshot required', 'history_unavailable');
    for (const id of ids(command.node_ids)) {
      const historical = past.definition.nodes[id];
      if (this.nodes.has(id) || !historical)
        fail(
          'Restore requires absent current and present historical identity',
          'identity_conflict',
        );
      const evidence = this.base.tombstones.find((t) => t.node_id === id);
      const original = this.deleted.has(id) ? this.base.definition.nodes[id] : undefined;
      if (!evidence && !original)
        fail('Restore identity has no retained tombstone', 'history_unavailable');
      if (
        historical.kind !== (original ?? evidence)!.kind ||
        historical.mutable !== (original ?? evidence)!.mutable
      )
        fail('Historical identity creation policy mismatch', 'identity_conflict');
      this.nodes.set(id, thawJSON(historical) as DraftObject);
      this.restored.add(id);
    }
  }
  replace(command: Wire): void {
    const payload = command.payload as Wire;
    let raw: unknown = payload.inline;
    if (Object.hasOwn(payload, 'blob')) {
      const ref = blobReference(payload.blob);
      const size = parseCounter(ref.size);
      if (size > BigInt(this.limits.max_definition_bytes))
        fail('Staged definition exceeds budget', 'limit_exceeded');
      if (!this.options.payloads) fail('Immutable payload bytes required', 'unsupported_contract');
      const supplied = this.options.payloads.find(
        (data) =>
          data instanceof Uint8Array &&
          BigInt(data.byteLength) === size &&
          'sha256:' + createHash('sha256').update(data).digest('hex') === ref.digest,
      );
      if (!supplied) fail('Payload bytes disagree with immutable reference');
      const data = Uint8Array.from(supplied);
      raw = decodeJSON(data);
      if (!Buffer.from(canonicalJSON(raw)).equals(Buffer.from(data)))
        fail('Definition blob must contain exact canonical bytes');
    }
    if (canonicalJSON(raw).byteLength > this.limits.max_definition_bytes)
      fail('Definition payload exceeds budget', 'limit_exceeded');
    const candidate = GraphDefinition.fromJSON(raw, this.options.publicationContracts);
    if (candidate.graph_id !== this.base.definition.graph_id)
      fail('Cross-graph replacement is not an ordinary transaction');
    const before = this.definition(this.options.publicationContracts, this.limits);
    const seeds =
      command.op === 'replace_subtree' ? [validateID(command.anchor_id)] : ids(command.scope_ids);
    if (command.op === 'replace_subtree') this.node(seeds[0]);
    const [a, b] = checkScope(before, candidate, seeds);
    const mapping = command.id_mapping as Wire;
    const expected = {
      retained_ids: new Set([...a].filter((id) => b.has(id))),
      new_ids: new Set([...b].filter((id) => !a.has(id))),
      deleted_ids: new Set([...a].filter((id) => !b.has(id))),
    };
    for (const [key, values] of Object.entries(expected))
      if (!sameSet(new Set(ids(mapping[key])), values))
        fail('ID mapping is not the exact retained/new/deleted partition');
    if (new Set([...a, ...b]).size > this.limits.max_expanded_operations)
      fail('Replacement expansion budget exceeded', 'limit_exceeded');
    for (const [id, node] of Object.entries(candidate.nodes)) {
      const old = this.nodes.get(id);
      if (!old && (this.deleted.has(id) || this.base.tombstones.some((t) => t.node_id === id)))
        fail('Replacement cannot resurrect deleted identities', 'identity_conflict');
      if (
        old &&
        (old.kind !== node.kind ||
          old.mutable !== node.mutable ||
          old.role_variant !== (node.kind === 'role' ? node.role_variant : undefined))
      )
        fail('Replacement cannot reset creation identity', 'identity_conflict');
    }
    for (const id of this.nodes.keys())
      if (!Object.hasOwn(candidate.nodes, id)) this.deleted.add(id);
    this.rootOperations ||= !equal(this.roots, candidate.roots);
    this.wire = candidate.asJSON() as DraftObject;
    this.nodes.clear();
    for (const [id, node] of Object.entries(candidate.nodes))
      this.nodes.set(id, thawJSON(node) as DraftObject);
    this.roots = thawJSON(candidate.roots) as DraftObject[];
    this.pubs = thawJSON(candidate.publications) as DraftObject[];
    this.catalogs = new Map(
      candidate.presentations.catalogs.map((c) => [c.locale, thawJSON(c.entries) as DraftObject[]]),
    );
    this.defaultLocale = candidate.presentations.default_locale;
  }
  definition(
    contracts: PublicationContracts | undefined,
    limits: TransactionLimits,
  ): GraphDefinition {
    const wire = { ...this.wire };
    wire.nodes = [...this.nodes.values()];
    wire.roots = this.roots;
    wire.publications = this.pubs;
    wire.presentations = {
      default_locale: this.defaultLocale,
      catalogs: [...this.catalogs].map(([locale, entries]) => ({ locale, entries })),
    };
    if (
      this.nodes.size > limits.max_nodes ||
      canonicalJSON(wire).byteLength > limits.max_definition_bytes
    )
      fail('Candidate exceeds graph budget', 'limit_exceeded');
    const candidate = GraphDefinition.fromJSON(wire, contracts);
    const index = GraphIndex.build(candidate, contracts);
    let edges = candidate.roots.length + candidate.publications.length;
    for (const node of Object.values(candidate.nodes)) {
      edges += node.uses.length;
      if (node.kind === 'role')
        for (const key of slots) edges += this.sequence(node.node_id, key).length;
      if (node.kind !== 'tool' && node.instruction_template)
        edges += node.instruction_template.parts.length;
      if (
        index.locations[node.node_id]!.depth > limits.max_depth ||
        canonicalJSON(node).byteLength > limits.max_node_bytes
      )
        fail('Node size/depth exceeds transaction validation budget', 'limit_exceeded');
    }
    if (edges > limits.max_edges) fail('Graph relation budget exceeded', 'limit_exceeded');
    return candidate;
  }
}

/** Complete endpoint normal form, independent of transient command writes. */
function resolveFacts(
  base: PureRevisionState,
  candidate: GraphDefinition,
): { facts: readonly JSONObject[]; tombstones: readonly JSONObject[] } {
  const before = base.definition;
  const a = before.nodes;
  const b = candidate.nodes;
  const facts: unknown[] = [];
  const tombstones = new Map(base.tombstones.map((t) => [t.node_id as string, t]));
  for (const id of Object.keys(b)
    .filter((id) => !Object.hasOwn(a, id))
    .sort(scalarOrder))
    facts.push(
      tombstones.has(id)
        ? { type: 'NodeRestored', node: b[id], tombstone: tombstones.get(id) }
        : { type: 'NodeCreated', node: b[id] },
    );
  const retained = Object.keys(a)
    .filter((id) => Object.hasOwn(b, id))
    .sort(scalarOrder);
  const optional = (node: object, key: string) =>
    Object.hasOwn(node, key)
      ? { present: true, value: (node as DraftObject)[key] }
      : { present: false };
  for (const id of retained) {
    const fields = ['name', ...updates]
      .sort(scalarOrder)
      .filter((key) => !equal(optional(a[id]!, key), optional(b[id]!, key)));
    if (fields.length)
      facts.push({
        type: 'NodeFieldsSet',
        node_id: id,
        before: Object.fromEntries(fields.map((key) => [key, optional(a[id]!, key)])),
        after: Object.fromEntries(fields.map((key) => [key, optional(b[id]!, key)])),
      });
  }
  const graphFields = ['application_name', 'extensions', 'mode'] as const;
  const changedGraph = graphFields.filter((key) => !equal(before[key], candidate[key]));
  if (changedGraph.length)
    facts.push({
      type: 'GraphFieldsSet',
      before: Object.fromEntries(changedGraph.map((key) => [key, before[key]])),
      after: Object.fromEntries(changedGraph.map((key) => [key, candidate[key]])),
    });
  if (!equal(before.roots, candidate.roots))
    facts.push({ type: 'RootsAssigned', before: before.roots, after: candidate.roots });
  for (const [field, type] of [
    ['members', 'MembersAssigned'],
    ['uses', 'UsesAssigned'],
  ] as const)
    for (const id of retained) {
      const x = a[id]! as unknown as Wire;
      const y = b[id]! as unknown as Wire;
      if (Object.hasOwn(x, field) && !equal(x[field], y[field]))
        facts.push({ type, node_id: id, before: x[field], after: y[field] });
    }
  const ap = new Map(
    before.publications.map((p, i) => [p.publication_id, { pub: p, position: i }]),
  );
  const bp = new Map(
    candidate.publications.map((p, i) => [p.publication_id, { pub: p, position: i }]),
  );
  for (const id of [...new Set([...ap.keys(), ...bp.keys()])].sort(scalarOrder)) {
    const x = ap.get(id),
      y = bp.get(id);
    if (!y) facts.push({ type: 'PublicationRemoved', before: x!.pub, position: x!.position });
    else if (!x || x.position !== y.position || !equal(x.pub, y.pub))
      facts.push({
        type: 'PublicationPut',
        before: x ? { present: true, value: x.pub } : { present: false },
        after: y.pub,
        position: y.position,
      });
  }
  if (!equal(before.presentations, candidate.presentations))
    facts.push({
      type: 'PresentationsAssigned',
      before: before.presentations,
      after: candidate.presentations,
    });
  for (const id of Object.keys(a)
    .filter((id) => !Object.hasOwn(b, id))
    .sort(scalarOrder)) {
    const revision = parseCounter(base.revision) + 1n;
    if (revision > MAX_COUNTER) fail('Revision counter exhausted', 'limit_exceeded');
    const t = freezeJSON({
      node_id: id,
      kind: a[id]!.kind,
      mutable: a[id]!.mutable,
      deleted_revision: String(revision),
    }) as JSONObject;
    tombstones.set(id, t);
    facts.push({ type: 'NodeDeleted', node_id: id, before: a[id], tombstone: t });
  }
  return {
    facts: freezeJSON(facts) as readonly JSONObject[],
    tombstones: Object.freeze(
      [...tombstones.keys()].sort(scalarOrder).map((id) => tombstones.get(id)!),
    ),
  };
}

export interface PurePreparedTransaction {
  readonly status: 'prepared-pure-candidate';
  readonly base: PureRevisionState;
  readonly envelope: TransactionEnvelope;
  readonly candidate: GraphDefinition;
  readonly facts: readonly JSONObject[];
  readonly tombstones: readonly JSONObject[];
  readonly factsDigest: string;
  readonly protection: ProtectionReport;
  readonly rootOperations: boolean;
  readonly noop: boolean;
  readonly resultRevision: string;
  readonly approvalSubject: JSONObject;
  readonly approvalSubjectDigest: string;
}

/** Authorizes NOTHING. Produces detached proposed facts and exact preview hash subject only.
 * This is deliberately not PreviewReceipt: no admission, expiry, full definition
 * diff or durable result is manufactured. Root intent remains visible even on noop.
 */
export function prepare(
  base: PureRevisionState,
  envelope: unknown,
  options: PureTransactionOptions = {},
): PurePreparedTransaction {
  if (!snapshots.has(base)) fail('Expected validated pure revision snapshot');
  const limits = limitsValue(options.limits ?? DEFAULT_LIMITS);
  const request = TransactionEnvelope.fromJSON(
    envelope instanceof TransactionEnvelope ? envelope.value : envelope,
    limits,
  );
  if (
    request.value.graph_id !== base.definition.graph_id ||
    request.value.base_revision !== base.revision
  )
    fail('Transaction does not match accepted base', 'revision_conflict');
  const draft = new Draft(base, options, limits);
  for (const command of request.value.commands as readonly Wire[]) {
    draft.apply(command);
    if (draft.nodes.size > limits.max_nodes) fail('Node budget exceeded', 'limit_exceeded');
  }
  const candidate = draft.definition(options.publicationContracts, limits);
  const protection = protectChange(base.definition, candidate, options.publicationContracts);
  const { facts, tombstones } = resolveFacts(base, candidate);
  if (canonicalJSON(facts).byteLength > limits.max_resolved_bytes)
    fail('Resolved facts exceed atomic batch budget', 'limit_exceeded');
  const noop = facts.length === 0;
  const number = parseCounter(base.revision) + (noop ? 0n : 1n);
  if (number > MAX_COUNTER) fail('Revision counter exhausted', 'limit_exceeded');
  const factsDigest = canonicalDigest(facts, 'contexture.facts/v1');
  const approvalSubject = freezeJSON({
    schema: 'contexture.preview/v1',
    graph_id: base.definition.graph_id,
    base_revision: base.revision,
    base_digest: base.definitionDigest,
    candidate_digest: candidate.digest(),
    command_digest: request.commandDigest,
    resolved_fact_digest: factsDigest,
  }) as JSONObject;
  return Object.freeze({
    status: 'prepared-pure-candidate',
    base,
    envelope: request,
    candidate,
    facts,
    tombstones,
    factsDigest,
    protection,
    rootOperations: draft.rootOperations,
    noop,
    resultRevision: String(number),
    approvalSubject,
    approvalSubjectDigest: canonicalDigest(approvalSubject, 'contexture.preview/v1'),
  });
}

/** Pure CAS + reconstruction check, not current authority or append admission. */
export function recheckPrepared(
  current: PureRevisionState,
  prepared: PurePreparedTransaction,
  options: PureTransactionOptions = {},
): PurePreparedTransaction {
  if (!snapshots.has(current) || !snapshots.has(prepared.base))
    fail('Expected validated snapshots');
  if (
    current.revision !== prepared.base.revision ||
    current.definitionDigest !== prepared.base.definitionDigest ||
    !equal(current.tombstones, prepared.base.tombstones)
  )
    fail('Current head or identity history changed', 'revision_conflict');
  const fresh = prepare(current, prepared.envelope, options);
  if (
    !equal(fresh.approvalSubject, prepared.approvalSubject) ||
    fresh.approvalSubjectDigest !== prepared.approvalSubjectDigest ||
    !equal(fresh.facts, prepared.facts) ||
    !equal(fresh.tombstones, prepared.tombstones) ||
    !equal(fresh.protection, prepared.protection) ||
    fresh.candidate.digest() !== prepared.candidate.digest() ||
    fresh.factsDigest !== prepared.factsDigest ||
    fresh.rootOperations !== prepared.rootOperations ||
    fresh.noop !== prepared.noop ||
    fresh.resultRevision !== prepared.resultRevision ||
    fresh.status !== prepared.status
  )
    fail('Prepared proposal no longer describes the complete transaction', 'revision_conflict');
  return fresh;
}
