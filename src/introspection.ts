import { z } from 'zod';
import { foldCatalogText } from './catalog-text.js';
import type { CompiledApplication, CompiledNode } from './core/model/compiler.js';
import { Disclosure } from './core/model/disclosure.js';
import { compileNode, CompileLevel, type View } from './core/model/node.js';
import { SurfaceSelection } from './core/model/root-selection.js';
import { ModelValidationError } from './core/foundation/errors.js';
import { stripText } from './core/foundation/text.js';
import { Presentation, resolvePresentation } from './core/presentation.js';
import {
  canonicalCatalogDigest,
  formatCatalogJson,
  freezeCatalogObject,
  type CatalogObject,
} from './catalog-json.js';

export {
  canonicalCatalogDigest as canonicalDigest,
  formatCatalogJson,
  parseCatalogJson,
} from './catalog-json.js';
export type { CatalogObject, CatalogValue } from './catalog-json.js';

export const SCHEMA = 'contexture.node-catalog/v1';
export const CatalogView = Object.freeze({
  APPLICATION: 'application',
  MODEL: 'model',
  SURFACE: 'surface',
} as const);
export type CatalogView = (typeof CatalogView)[keyof typeof CatalogView];
export const CatalogDetail = Object.freeze({
  SUMMARY: 'summary',
  DEFINITION: 'definition',
} as const);
export type CatalogDetail = (typeof CatalogDetail)[keyof typeof CatalogDetail];
export const MemberSlot = Object.freeze({
  PRE_PROCESS: 'pre_process',
  CHILD: 'child',
  POST_PROCESS: 'post_process',
  SKILL: 'skill',
  TOOL: 'tool',
} as const);
export type MemberSlot = (typeof MemberSlot)[keyof typeof MemberSlot];

function invalid(message: string): never {
  throw new ModelValidationError(message);
}
function reference(value: string): boolean {
  return value.length !== 0 && value.split('/').every((part) => part.length !== 0);
}
function namespace(value: string): boolean {
  return value.includes('/') && value.split('/').every((part) => stripText(part).length !== 0);
}

const ref = z.string().refine(reference);
const kind = z.enum(['role', 'skill', 'tool']);
const jsonObject = z.unknown().transform(freezeCatalogObject);
const roleDefinition = z
  .strictObject({
    authored_instructions: z.string().min(1),
    effective_instructions: z.string().min(1),
    pre_process_ref: ref.nullable(),
    post_process_ref: ref.nullable(),
  })
  .readonly();
const skillDefinition = z
  .strictObject({
    authored_instructions: z.string().min(1),
    effective_instructions: z.string().min(1),
  })
  .readonly();
const toolDefinition = z
  .union([
    z.strictObject({ execution_available: z.literal(false) }),
    z.strictObject({
      execution_available: z.literal(true),
      read_only: z.boolean(),
      input_schema: jsonObject,
    }),
  ])
  .readonly();
const memberDescriptor = z
  .strictObject({
    ref,
    kind,
    slot: z.enum(['pre_process', 'child', 'post_process', 'skill', 'tool']),
  })
  .readonly();
const nodeDescriptor = z
  .strictObject({
    ref,
    kind,
    name: z.string().min(1),
    description: z.string().min(1),
    presentation: z
      .strictObject({ title: z.string().min(1), description: z.string().min(1).optional() })
      .readonly()
      .nullable(),
    plane: z.enum(['model', 'prompt']),
    parent_ref: ref.nullable(),
    ordinal: z.number().int().nonnegative(),
    members: z.array(memberDescriptor).readonly(),
    uses: z.array(ref).readonly(),
    dependents: z.array(ref).readonly(),
    role: roleDefinition.nullable(),
    skill: skillDefinition.nullable(),
    tool: toolDefinition.nullable(),
    extensions: jsonObject,
  })
  .readonly();
const applicationDescriptor = z
  .strictObject({
    name: z.string().min(1),
    mode: z.enum(['runtime', 'disclosure-only']),
    view: z.enum(['application', 'model', 'surface']),
    detail: z.enum(['summary', 'definition']),
    locale: z.string().min(1).nullable(),
    execution_bound: z.boolean(),
  })
  .readonly();
const snapshotBody = z
  .strictObject({
    schema: z.literal(SCHEMA),
    application: applicationDescriptor,
    roots: z.array(ref).readonly(),
    counts: z
      .strictObject({
        role: z.number().int().nonnegative(),
        skill: z.number().int().nonnegative(),
        tool: z.number().int().nonnegative(),
      })
      .readonly(),
    nodes: z.array(nodeDescriptor).readonly(),
  })
  .readonly();
const snapshotEnvelope = snapshotBody
  .unwrap()
  .extend({ content_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) });

export type NodeDescriptor = z.infer<typeof nodeDescriptor>;
export type MemberDescriptor = z.infer<typeof memberDescriptor>;
export type ApplicationDescriptor = z.infer<typeof applicationDescriptor>;
export type RoleDefinition = z.infer<typeof roleDefinition>;
export type SkillDefinition = z.infer<typeof skillDefinition>;
export type ToolDefinition = z.infer<typeof toolDefinition>;
export type PresentationDescriptor = NonNullable<NodeDescriptor['presentation']>;
type Body = z.infer<typeof snapshotBody>;

function validate(body: Body): void {
  const { application, roots, nodes, counts } = body;
  if ((application.mode === 'runtime') !== application.execution_bound)
    invalid('Catalog mode and execution binding disagree.');
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  const uses = new Map(nodes.map((node) => [node.ref, new Set(node.uses)]));
  const dependents = new Map(nodes.map((node) => [node.ref, new Set(node.dependents)]));
  if (byRef.size !== nodes.length || new Set(roots).size !== roots.length)
    invalid('Catalog refs and roots must be unique.');
  const rootSet = new Set(roots);
  if (
    nodes.filter((node) => node.parent_ref === null).length !== roots.length ||
    roots.some(
      (root, ordinal) =>
        byRef.get(root)?.parent_ref !== null || byRef.get(root)?.ordinal !== ordinal,
    )
  ) {
    invalid('Catalog roots/parents/ordinals disagree.');
  }
  for (const name of ['role', 'skill', 'tool'] as const) {
    if (counts[name] !== nodes.filter((node) => node.kind === name).length)
      invalid('Catalog counts disagree with nodes.');
  }
  for (const node of nodes) {
    for (const keys of [node.members.map((member) => member.ref), node.uses, node.dependents]) {
      if (new Set(keys).size !== keys.length)
        invalid('Catalog relationships must not repeat refs.');
    }
    if (Object.keys(node.extensions).some((key) => !namespace(key)))
      invalid('Catalog extension namespaces require an owner prefix and slash.');
    if (node.kind !== 'role' && node.members.length !== 0)
      invalid('Only catalog Roles contain members.');
    const definitions = [
      node.role !== null && 'role',
      node.skill !== null && 'skill',
      node.tool !== null && 'tool',
    ].filter(Boolean);
    if (
      application.detail === 'summary'
        ? definitions.length !== 0
        : definitions.length !== 1 || definitions[0] !== node.kind
    ) {
      invalid('Catalog detail and node definitions disagree.');
    }
    if (node.parent_ref !== null) {
      const parent = byRef.get(node.parent_ref);
      if (
        parent?.kind !== 'role' ||
        parent.ref === node.ref ||
        parent.plane !== node.plane ||
        parent.members[node.ordinal]?.ref !== node.ref
      )
        invalid('Catalog parent/member/ordinal facts disagree.');
    } else if (!rootSet.has(node.ref)) invalid('A parentless catalog node must be a root.');
    for (let ordinal = 0; ordinal < node.members.length; ordinal += 1) {
      const member = node.members[ordinal]!;
      const target = byRef.get(member.ref);
      const expected = member.slot === 'skill' ? 'skill' : member.slot === 'tool' ? 'tool' : 'role';
      if (
        member.kind !== expected ||
        target?.kind !== member.kind ||
        target.parent_ref !== node.ref ||
        target.ordinal !== ordinal
      )
        invalid('Catalog member slots disagree with targets.');
    }
    if (node.role !== null) {
      for (const slot of ['pre_process', 'post_process'] as const) {
        const members = node.members.filter((member) => member.slot === slot);
        if (members.length > 1 || node.role[`${slot}_ref`] !== (members[0]?.ref ?? null))
          invalid('Catalog process designation disagrees with member slots.');
      }
    }
    if (node.tool !== null && node.tool.execution_available !== application.execution_bound)
      invalid('Catalog Tool binding disagrees with mode.');
    if (
      node.uses.some((target) => !dependents.get(target)?.has(node.ref)) ||
      node.dependents.some((source) => !uses.get(source)?.has(node.ref))
    )
      invalid('Catalog uses/dependents must be reciprocal.');
  }
}

/** Immutable validated read-model envelope; it grants no runtime authority. */
export class NodeCatalogSnapshot {
  readonly #body: Body;
  readonly #envelope: CatalogObject;
  readonly contentDigest: string;

  private constructor(body: Body) {
    validate(body);
    this.#body = body;
    this.contentDigest = canonicalCatalogDigest(body);
    this.#envelope = freezeCatalogObject({ ...body, content_digest: this.contentDigest });
    Object.freeze(this);
  }

  static of(value: unknown): NodeCatalogSnapshot {
    const parsed = snapshotBody.safeParse(freezeCatalogObject(value));
    if (!parsed.success) invalid('Invalid Node Catalog snapshot shape.');
    return new NodeCatalogSnapshot(parsed.data);
  }

  static fromJson(value: unknown): NodeCatalogSnapshot {
    const parsed = snapshotEnvelope.safeParse(freezeCatalogObject(value));
    if (!parsed.success) invalid('Invalid Node Catalog envelope shape.');
    const { content_digest, ...body } = parsed.data;
    const snapshot = NodeCatalogSnapshot.of(body);
    if (snapshot.contentDigest !== content_digest) invalid('Node Catalog content digest mismatch.');
    return snapshot;
  }

  get application(): ApplicationDescriptor {
    return this.#body.application;
  }
  get roots(): readonly string[] {
    return this.#body.roots;
  }
  get counts(): Body['counts'] {
    return this.#body.counts;
  }
  get nodes(): readonly NodeDescriptor[] {
    return this.#body.nodes;
  }
  asJson(): CatalogObject {
    return this.#envelope;
  }
  toJson(indent: number | null = 2): string {
    return formatCatalogJson(this.#envelope, { indent });
  }
}

export interface NodeMetadataContributor {
  readonly namespace: string;
  describe(ref: string, node: CompiledNode, graph: CompiledApplication): unknown;
}
export interface NodeCatalogOptions {
  readonly view: CatalogView;
  readonly detail?: CatalogDetail;
  readonly locale?: string;
  readonly surfaceSelection?: SurfaceSelection;
  readonly contributors?: readonly NodeMetadataContributor[];
}

/** Trusted application/developer graph projection; never an automatic MCP tool. */
export class NodeCatalog {
  readonly #snapshot: NodeCatalogSnapshot;
  readonly #byRef: ReadonlyMap<string, NodeDescriptor>;

  private constructor(snapshot: NodeCatalogSnapshot) {
    this.#snapshot = snapshot;
    this.#byRef = new Map(snapshot.nodes.map((node) => [node.ref, node]));
    Object.freeze(this);
  }

  static of(index: CompiledApplication, options: NodeCatalogOptions): NodeCatalog {
    const view = options.view;
    const detail = options.detail === undefined ? 'summary' : options.detail;
    if (
      !['application', 'model', 'surface'].includes(view) ||
      !['summary', 'definition'].includes(detail)
    )
      invalid('Explicit Catalog view and valid detail are required.');
    if ((view === 'surface') !== (options.surfaceSelection !== undefined))
      invalid('Only surface Catalogs require a SurfaceSelection.');
    if (
      options.surfaceSelection !== undefined &&
      !(options.surfaceSelection instanceof SurfaceSelection)
    )
      invalid('Constructed SurfaceSelection required.');
    const selection = options.surfaceSelection?.resolve(index) ?? SurfaceSelection.all();
    const [locale, presentation] = resolvePresentation(
      index.presentation ?? new Presentation(),
      options.locale,
    );
    const base = new Disclosure(index, { nodePresentations: presentation.nodes }).unrestricted();
    const entries = [...index.walk()];
    const promptRoots = new Set(index.promptRoots.map((node) => index.refOf(node)));
    const selected = selection.names === undefined ? undefined : new Set(selection.names);
    const selectedNodes = new Map<CompiledNode, boolean>();
    const included = new Set<string>();
    for (const [ref, node] of entries) {
      const parent = index.parentOf(node);
      const visible =
        selected === undefined ||
        selected.has(ref) ||
        (parent !== undefined && selectedNodes.get(parent) === true);
      selectedNodes.set(node, visible);
      if (visible && (view === 'application' || !promptRoots.has(ref.split('/')[0]!)))
        included.add(ref);
    }
    const roots = (
      selected === undefined
        ? index.roots
        : entries.filter(([ref]) => selected.has(ref)).map(([, node]) => node)
    )
      .map((node) => index.refOf(node))
      .filter((ref) => included.has(ref));
    const rootSet = new Set(roots);
    const visibleNodes = (nodes: Iterable<CompiledNode>) =>
      [...nodes].filter((node) => included.has(index.refOf(node)));
    const visibleRefs = (refs: Iterable<string>) => [...refs].filter((ref) => included.has(ref));
    const active: View<CompiledNode> = {
      refOf: (node) => index.refOf(node),
      cardOf: (node) => base.cardOf(node),
      routingCardOf: (node) => base.routingCardOf(node),
      cardFor: (ref) => {
        if (!included.has(ref)) invalid('Reference is outside this Catalog view.');
        return base.cardFor(ref);
      },
      cardsOf: (nodes) => base.cardsOf(visibleNodes(nodes)),
      routingCardsOf: (nodes) => base.routingCardsOf(visibleNodes(nodes)),
      cardsFor: (refs) => base.cardsFor(visibleRefs(refs)),
      routingCardsFor: (refs) => base.routingCardsFor(visibleRefs(refs)),
      executionOf: (node) => base.executionOf(node),
      schemaOf: (node) => index.schemaOf(node),
      presentCard: (node, card) => base.presentCard(node, card),
    };
    const ordinals = new Map(roots.map((ref, ordinal) => [ref, ordinal]));
    const contributors = (options.contributors ?? []).map((contributor) => {
      if (
        typeof contributor.namespace !== 'string' ||
        !namespace(contributor.namespace) ||
        typeof contributor.describe !== 'function'
      )
        invalid('Invalid Node Metadata Contributor.');
      return {
        namespace: contributor.namespace,
        owner: contributor,
        describe: contributor.describe,
      };
    });
    if (
      new Set(contributors.map((contributor) => contributor.namespace)).size !== contributors.length
    )
      invalid('Catalog contributor namespace is registered twice.');
    const members = new Map<string, MemberDescriptor[]>();
    for (const [ref, node] of entries) {
      if (!included.has(ref)) continue;
      const rows: MemberDescriptor[] = [];
      if (node.kind === 'role') {
        for (const child of node.members()) {
          const target = index.refOf(child);
          if (!included.has(target)) continue;
          const slot: MemberSlot =
            child === node.preProcess
              ? 'pre_process'
              : child === node.postProcess
                ? 'post_process'
                : child.kind === 'skill'
                  ? 'skill'
                  : child.kind === 'tool'
                    ? 'tool'
                    : 'child';
          rows.push(Object.freeze({ ref: target, kind: child.kind, slot }));
          if (!rootSet.has(target)) ordinals.set(target, rows.length - 1);
        }
      }
      members.set(ref, rows);
    }
    const nodes = entries
      .filter(([ref]) => included.has(ref))
      .map(([ref, node]) => {
        const parent = index.parentOf(node);
        const parentRef = parent === undefined ? null : index.refOf(parent);
        const metadata = contributors.flatMap((contributor): [string, CatalogObject][] => {
          const value = contributor.describe.call(contributor.owner, ref, node, index);
          return value === null || value === undefined
            ? []
            : [[contributor.namespace, freezeCatalogObject(value)]];
        });
        const copy = Object.hasOwn(presentation.nodes, ref) ? presentation.nodes[ref] : undefined;
        const opened =
          detail === 'definition' && node.kind !== 'tool'
            ? compileNode(node, CompileLevel.ACTIVE, active)
            : undefined;
        if (opened !== undefined && typeof opened.instructions !== 'string')
          invalid('Catalog ACTIVE program must be text.');
        return {
          ref,
          kind: node.kind,
          name: node.name,
          description: node.description,
          presentation:
            copy === undefined
              ? null
              : {
                  title: copy.title,
                  ...(copy.description === undefined ? {} : { description: copy.description }),
                },
          plane: promptRoots.has(ref.split('/')[0]!) ? 'prompt' : 'model',
          parent_ref:
            rootSet.has(ref) || parentRef === null || !included.has(parentRef) ? null : parentRef,
          ordinal: ordinals.get(ref),
          members: members.get(ref),
          uses: node.uses.filter((target) => included.has(target)),
          dependents: index.dependentsOf(ref).filter((source) => included.has(source)),
          role:
            detail === 'definition' && node.kind === 'role'
              ? {
                  authored_instructions: node.instructions,
                  effective_instructions: opened?.instructions,
                  pre_process_ref: opened?.pre_process ?? null,
                  post_process_ref: opened?.post_process ?? null,
                }
              : null,
          skill:
            detail === 'definition' && node.kind === 'skill'
              ? {
                  authored_instructions: node.instructions,
                  effective_instructions: opened?.instructions,
                }
              : null,
          tool:
            detail === 'definition' && node.kind === 'tool'
              ? index.executionBound
                ? {
                    execution_available: true,
                    read_only: node.readOnly,
                    input_schema: index.schemaOf(node),
                  }
                : { execution_available: false }
              : null,
          extensions: Object.fromEntries(metadata),
        };
      });
    const counts = { role: 0, skill: 0, tool: 0 };
    for (const node of nodes) counts[node.kind] += 1;
    return new NodeCatalog(
      NodeCatalogSnapshot.of({
        schema: SCHEMA,
        application: {
          name: index.name,
          mode: index.executionBound ? 'runtime' : 'disclosure-only',
          view,
          detail,
          locale: locale ?? null,
          execution_bound: index.executionBound,
        },
        roots,
        counts,
        nodes,
      }),
    );
  }

  get roots(): readonly string[] {
    return this.#snapshot.roots;
  }
  get(ref: string): NodeDescriptor {
    const node = this.#byRef.get(ref);
    if (node === undefined) invalid('Reference is not present in this Node Catalog view.');
    return node;
  }
  children(ref: string): readonly NodeDescriptor[] {
    return Object.freeze(this.get(ref).members.map((member) => this.get(member.ref)));
  }
  list(
    options: { readonly kind?: 'role' | 'skill' | 'tool'; readonly query?: string } = {},
  ): readonly NodeDescriptor[] {
    if (options.kind !== undefined && !['role', 'skill', 'tool'].includes(options.kind))
      invalid('Unknown Catalog node kind.');
    const query = options.query === undefined ? '' : options.query;
    if (typeof query !== 'string') invalid('Catalog query must be text.');
    const wanted = foldCatalogText(stripText(query));
    return Object.freeze(
      this.#snapshot.nodes.filter(
        (node) =>
          (options.kind === undefined || node.kind === options.kind) &&
          (!wanted || foldCatalogText(searchText(node)).includes(wanted)),
      ),
    );
  }
  snapshot(): NodeCatalogSnapshot {
    return this.#snapshot;
  }
}

function searchText(node: NodeDescriptor): string {
  const fields = [node.ref, node.name, node.description, ...node.uses, ...node.dependents];
  if (node.presentation !== null)
    fields.push(node.presentation.title, node.presentation.description ?? '');
  if (node.role !== null)
    fields.push(node.role.authored_instructions, node.role.effective_instructions);
  if (node.skill !== null)
    fields.push(node.skill.authored_instructions, node.skill.effective_instructions);
  if (node.tool !== null) fields.push(formatCatalogJson(node.tool, { spaced: true }));
  fields.push(formatCatalogJson(node.extensions, { spaced: true }));
  return fields.join(' ');
}
