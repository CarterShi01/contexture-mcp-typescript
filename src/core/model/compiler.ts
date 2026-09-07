import type {
  Factory,
  NodeDeclaration,
  NodeKind,
  RoleDeclaration,
  SkillDeclaration,
  ToolDeclaration,
} from './declarations.js';
import {
  normalizeApplication,
  type ApplicationDeclaration,
  type ManagedApplicationDeclaration,
} from '../../application.js';
import type { ChannelHandle } from './channels.js';
import {
  ContainmentCycleError,
  DuplicateNameError,
  LookupFailure,
  ModelValidationError,
  NodeNotFoundError,
  UnresolvedReferenceError,
} from '../foundation/errors.js';
import { REFERENCE_SEPARATOR } from '../foundation/vocabulary.js';
import { bindTool, type JsonObject, type ToolBinding } from './binding.js';
import { compareCodePoints, matchingRefs, type ReferenceMatches } from './reference-queries.js';

interface CompiledNodeBase {
  readonly kind: NodeKind;
  readonly name: string;
  readonly description: string;
  readonly uses: readonly string[];
}

export interface CompiledRole extends CompiledNodeBase {
  readonly kind: 'role';
  readonly instructions: string;
  readonly children: readonly CompiledRole[];
  readonly skills: readonly CompiledSkill[];
  readonly tools: readonly CompiledTool[];
}

export interface CompiledSkill extends CompiledNodeBase {
  readonly kind: 'skill';
  readonly instructions: string;
}

export interface CompiledTool extends CompiledNodeBase {
  readonly kind: 'tool';
  readonly readOnly: boolean;
  readonly declaration: ToolDeclaration;
  readonly binding: ToolBinding | undefined;
}

export type CompiledNode = CompiledRole | CompiledSkill | CompiledTool;

/** One undisclosed ancestor and the number of direct Role choices below it. */
export interface SignpostLevel {
  readonly ref: string;
  readonly subRoleCount: number;
}

/** One declared `uses` edge whose target belongs to another root. */
export interface ReferenceCrossing {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly targetRoot: string;
}

/**
 * Immutable compiled facts for one complete Contexture forest.
 *
 * This is the TypeScript-native Index facade. Queries never re-run lazy
 * factories, open Channels, or follow `uses` while traversing containment.
 */
export interface Index {
  readonly name: string;
  readonly roots: readonly CompiledNode[];
  readonly modelRoots: readonly CompiledNode[];
  readonly promptRoots: readonly CompiledNode[];
  readonly channels: ChannelHandle | undefined;
  readonly executionBound: boolean;
  readonly isBound: boolean;
  readonly size: number;
  has(ref: string): boolean;
  find(ref: string): CompiledNode;
  tool(ref: string): CompiledTool;
  bindingOf(ref: string): ToolBinding;
  schemaOf(node: CompiledNode): JsonObject;
  refOf(node: CompiledNode): string;
  parentOf(node: CompiledNode): CompiledRole | undefined;
  childrenOf(node: CompiledNode): readonly CompiledNode[];
  usesOf(ref: string): readonly string[];
  dependentsOf(ref: string): readonly string[];
  ofKind<K extends NodeKind>(kind: K): readonly Extract<CompiledNode, { readonly kind: K }>[];
  walk(): IterableIterator<readonly [string, CompiledNode]>;
  nodesWithRefs(): IterableIterator<readonly [string, CompiledNode]>;
  skills(): IterableIterator<readonly [string, CompiledSkill]>;
  rolesWithRefs(): IterableIterator<readonly [string, CompiledRole]>;
  rolesByLevel(): IterableIterator<readonly [string, CompiledRole]>;
  matchingRefs(value: string, limit: number): ReferenceMatches;
  signpost(ref: string): readonly SignpostLevel[];
  crossings(): IterableIterator<ReferenceCrossing>;
}

/** Backward-compatible name for the native immutable {@link Index} facade. */
export type CompiledApplication = Index;

interface CompilationState {
  readonly byRef: Map<string, CompiledNode>;
  readonly parentByNode: Map<CompiledNode, CompiledRole | undefined>;
  readonly refByNode: Map<CompiledNode, string>;
  readonly byKind: Map<NodeKind, CompiledNode[]>;
  readonly activeFactories: Set<Factory<NodeDeclaration>>;
  readonly declarations: WeakSet<object>;
  readonly bindTools: boolean;
}

/** The SDK-neutral declaration normalized before every public compilation route. */
export type ApplicationCompilation = ApplicationDeclaration | ManagedApplicationDeclaration;

/** Compile one lazy application into an immutable, canonical forest snapshot. */
export function compileApplication(application: ApplicationCompilation): CompiledApplication {
  return compile(normalizeApplication(application), true);
}

/** Compile an independent structural projection with neither bindings nor Channels. */
export function compileDisclosureApplication(
  application: ApplicationCompilation,
): CompiledApplication {
  const declaration = normalizeApplication(application);
  if (declaration.channels !== undefined) {
    throw new ModelValidationError(
      'A disclosure-only Contexture application cannot declare Channels.',
    );
  }
  if ((declaration.resources?.length ?? 0) > 0) {
    throw new ModelValidationError(
      'A disclosure-only Contexture application cannot declare Resources.',
    );
  }
  return compile(declaration, false);
}

function compile(application: ApplicationCompilation, bindTools: boolean): CompiledApplication {
  const state: CompilationState = {
    byRef: new Map(),
    parentByNode: new Map(),
    refByNode: new Map(),
    byKind: new Map<NodeKind, CompiledNode[]>(),
    activeFactories: new Set(),
    declarations: new WeakSet(),
    bindTools,
  };

  const modelRoots = application.roots.map((factory) =>
    compileFactory(factory, [], undefined, state),
  );
  const promptRoots = (application.promptRoots ?? []).map((factory) =>
    compileFactory(factory, [], undefined, state),
  );
  validateUses(state.byRef);
  const dependents = deriveDependents(state.byRef);
  return new ImmutableIndex(
    application.name,
    modelRoots,
    promptRoots,
    application.channels,
    state,
    dependents,
  );
}

function compileFactory(
  factory: Factory<NodeDeclaration>,
  parentPath: readonly string[],
  parent: CompiledRole | undefined,
  state: CompilationState,
): CompiledNode {
  if (typeof factory !== 'function') {
    throw new ModelValidationError('Every Contexture node must be declared by a lazy factory.');
  }
  if (state.activeFactories.has(factory)) {
    throw new ContainmentCycleError(
      'A Contexture factory contains itself through an active ancestor.',
    );
  }
  state.activeFactories.add(factory);
  try {
    return compileDeclaration(factory(), parentPath, parent, state);
  } finally {
    state.activeFactories.delete(factory);
  }
}

function compileDeclaration(
  declaration: NodeDeclaration,
  parentPath: readonly string[],
  parent: CompiledRole | undefined,
  state: CompilationState,
): CompiledNode {
  validateDeclaration(declaration, state.bindTools);
  if (state.declarations.has(declaration)) {
    throw new DuplicateNameError(
      `Contexture node ${JSON.stringify(declaration.name)} reuses one declaration object at more than one address.`,
    );
  }
  state.declarations.add(declaration);
  const path = [...parentPath, declaration.name];
  const ref = path.join(REFERENCE_SEPARATOR);
  if (state.byRef.has(ref)) {
    throw new DuplicateNameError(
      `Contexture address ${JSON.stringify(ref)} is declared more than once.`,
    );
  }

  if (declaration.kind === 'role') {
    const role = declaration as RoleDeclaration;
    const node = {
      ...baseOf(role),
      kind: 'role' as const,
      instructions: role.instructions,
      children: [] as CompiledRole[],
      skills: [] as CompiledSkill[],
      tools: [] as CompiledTool[],
    } as CompiledRole;
    registerNode(node, ref, parent, state);
    const children = (role.children ?? []).map((factory) =>
      compileFactory(factory, path, node, state),
    );
    const skills = (role.skills ?? []).map((factory) => compileFactory(factory, path, node, state));
    const tools = (role.tools ?? []).map((factory) => compileFactory(factory, path, node, state));
    if (children.some((child) => child.kind !== 'role')) {
      throw new ModelValidationError(
        `Role ${JSON.stringify(role.name)} children must build Roles.`,
      );
    }
    if (skills.some((skill) => skill.kind !== 'skill')) {
      throw new ModelValidationError(`Role ${JSON.stringify(role.name)} skills must build Skills.`);
    }
    if (tools.some((tool) => tool.kind !== 'tool')) {
      throw new ModelValidationError(`Role ${JSON.stringify(role.name)} tools must build Tools.`);
    }
    assertUniqueMemberNames(role.name, [...children, ...skills, ...tools]);
    (node as { children: readonly CompiledRole[] }).children = Object.freeze(
      children as CompiledRole[],
    );
    (node as { skills: readonly CompiledSkill[] }).skills = Object.freeze(
      skills as CompiledSkill[],
    );
    (node as { tools: readonly CompiledTool[] }).tools = Object.freeze(tools as CompiledTool[]);
    return Object.freeze(node);
  }

  if (declaration.kind === 'skill') {
    const node = Object.freeze({
      ...baseOf(declaration as SkillDeclaration),
      kind: 'skill' as const,
      instructions: declaration.instructions,
    });
    registerNode(node, ref, parent, state);
    return node;
  }

  const node = Object.freeze({
    ...baseOf(declaration as ToolDeclaration),
    kind: 'tool' as const,
    readOnly: declaration.readOnly,
    declaration: Object.freeze({
      ...declaration,
      uses: Object.freeze([...(declaration.uses ?? [])]),
    }),
    binding: state.bindTools ? bindTool(declaration as ToolDeclaration) : undefined,
  });
  registerNode(node, ref, parent, state);
  return node;
}

function baseOf(declaration: NodeDeclaration): Omit<CompiledNodeBase, 'kind'> {
  return {
    name: declaration.name,
    description: declaration.description,
    uses: Object.freeze([...(declaration.uses ?? [])]),
  };
}

function registerNode(
  node: CompiledNode,
  ref: string,
  parent: CompiledRole | undefined,
  state: CompilationState,
): void {
  state.byRef.set(ref, node);
  state.parentByNode.set(node, parent);
  state.refByNode.set(node, ref);
  const nodes = state.byKind.get(node.kind) ?? [];
  nodes.push(node);
  state.byKind.set(node.kind, nodes);
}

function validateDeclaration(declaration: NodeDeclaration, bindTools: boolean): void {
  if (typeof declaration !== 'object' || declaration === null) {
    throw new ModelValidationError('A Contexture factory must return a node declaration object.');
  }
  if (!['role', 'skill', 'tool'].includes(declaration.kind)) {
    throw new ModelValidationError('A Contexture node kind must be role, skill, or tool.');
  }
  requireText(declaration.name, 'Context node name must not be empty.');
  requireText(
    declaration.description,
    `Context node ${JSON.stringify(declaration.name)} must have a routing description.`,
  );
  if (declaration.name.includes(REFERENCE_SEPARATOR)) {
    throw new ModelValidationError(
      `Context node name ${JSON.stringify(declaration.name)} must not contain ${JSON.stringify(REFERENCE_SEPARATOR)}.`,
    );
  }
  const uses = declaration.uses ?? [];
  if (!Array.isArray(uses))
    throw new ModelValidationError(
      `Node ${JSON.stringify(declaration.name)} uses must be an array.`,
    );
  const seen = new Set<string>();
  for (const ref of uses) {
    requireText(ref, `Node ${JSON.stringify(declaration.name)} names an empty reference in uses.`);
    if (seen.has(ref)) {
      throw new DuplicateNameError(
        `Node ${JSON.stringify(declaration.name)} names ${JSON.stringify(ref)} more than once in uses.`,
      );
    }
    seen.add(ref);
  }
  if (declaration.kind === 'role') {
    requireText(
      declaration.instructions,
      `Role ${JSON.stringify(declaration.name)} must have instructions.`,
    );
    for (const [label, values] of [
      ['children', declaration.children],
      ['skills', declaration.skills],
      ['tools', declaration.tools],
    ] as const) {
      if (values !== undefined && !Array.isArray(values)) {
        throw new ModelValidationError(
          `Role ${JSON.stringify(declaration.name)} ${label} must be an array.`,
        );
      }
    }
  }
  if (declaration.kind === 'skill') {
    requireText(
      declaration.instructions,
      `Skill ${JSON.stringify(declaration.name)} must have instructions.`,
    );
  }
  if (declaration.kind === 'tool') {
    if (typeof declaration.readOnly !== 'boolean') {
      throw new ModelValidationError(
        `Tool ${JSON.stringify(declaration.name)} must declare readOnly.`,
      );
    }
    if (typeof declaration.invoke !== 'function') {
      throw new ModelValidationError(
        `Tool ${JSON.stringify(declaration.name)} must declare invoke.`,
      );
    }
    if (bindTools && (typeof declaration.input !== 'object' || declaration.input === null)) {
      throw new ModelValidationError(
        `Tool ${JSON.stringify(declaration.name)} must declare a Zod input schema.`,
      );
    }
  }
}

function requireText(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new ModelValidationError(message);
}

function assertUniqueMemberNames(roleName: string, members: readonly CompiledNode[]): void {
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.name)) {
      throw new DuplicateNameError(
        `Role ${JSON.stringify(roleName)} contains more than one member named ${JSON.stringify(member.name)}.`,
      );
    }
    seen.add(member.name);
  }
}

function validateUses(byRef: ReadonlyMap<string, CompiledNode>): void {
  for (const [source, node] of byRef) {
    for (const target of node.uses) {
      if (!byRef.has(target)) {
        throw new UnresolvedReferenceError(
          `${JSON.stringify(source)} uses unknown Contexture reference ${JSON.stringify(target)}.`,
        );
      }
    }
  }
}

function deriveDependents(
  byRef: ReadonlyMap<string, CompiledNode>,
): ReadonlyMap<string, readonly string[]> {
  const dependents = new Map<string, string[]>();
  for (const [source, node] of byRef) {
    for (const target of node.uses) {
      const refs = dependents.get(target) ?? [];
      refs.push(source);
      dependents.set(target, refs);
    }
  }
  return new Map([...dependents].map(([ref, sources]) => [ref, Object.freeze([...sources])]));
}

class ImmutableIndex implements Index {
  readonly executionBound: boolean;
  readonly size: number;
  readonly roots: readonly CompiledNode[];
  readonly modelRoots: readonly CompiledNode[];
  readonly promptRoots: readonly CompiledNode[];
  #byRef: ReadonlyMap<string, CompiledNode>;
  #parentByNode: ReadonlyMap<CompiledNode, CompiledRole | undefined>;
  #refByNode: ReadonlyMap<CompiledNode, string>;
  #byKind: ReadonlyMap<NodeKind, readonly CompiledNode[]>;
  #dependents: ReadonlyMap<string, readonly string[]>;

  constructor(
    readonly name: string,
    modelRoots: readonly CompiledNode[],
    promptRoots: readonly CompiledNode[],
    readonly channels: ChannelHandle | undefined,
    state: CompilationState,
    dependents: ReadonlyMap<string, readonly string[]>,
  ) {
    this.executionBound = state.bindTools;
    this.modelRoots = Object.freeze([...modelRoots]);
    this.promptRoots = Object.freeze([...promptRoots]);
    this.roots = Object.freeze([...this.modelRoots, ...this.promptRoots]);
    this.size = state.byRef.size;
    this.#byRef = new Map(state.byRef);
    this.#parentByNode = new Map(state.parentByNode);
    this.#refByNode = new Map(state.refByNode);
    this.#byKind = new Map(
      [...state.byKind].map(([kind, nodes]) => [kind, Object.freeze([...nodes])]),
    );
    this.#dependents = new Map(dependents);
    Object.freeze(this);
  }

  get isBound(): boolean {
    return this.executionBound;
  }

  has(ref: string): boolean {
    return this.#byRef.has(ref);
  }

  find(ref: string): CompiledNode {
    const segments = ref.split(REFERENCE_SEPARATOR).filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      throw new NodeNotFoundError({
        reason: LookupFailure.EMPTY_REF,
        ref,
      });
    }
    const canonical = segments.join(REFERENCE_SEPARATOR);
    const found = this.#byRef.get(canonical);
    if (found !== undefined) return found;
    throw this.diagnose(segments, ref);
  }

  diagnose(segments: readonly string[], ref: string): NodeNotFoundError {
    const root = segments[0] ?? '';
    if (!this.#byRef.has(root)) {
      return new NodeNotFoundError({
        reason: LookupFailure.NO_SUCH_ROOT,
        ref,
        segment: root,
        scope: root,
        known: sorted(this.roots.map((candidate) => candidate.name)),
      });
    }
    for (let depth = 2; depth <= segments.length; depth += 1) {
      const candidate = segments.slice(0, depth).join(REFERENCE_SEPARATOR);
      if (this.#byRef.has(candidate)) continue;
      const parentRef = segments.slice(0, depth - 1).join(REFERENCE_SEPARATOR);
      const held = this.#byRef.get(parentRef);
      if (held === undefined)
        throw new ModelValidationError('Index lookup diagnosis lost its parent.');
      const segment = segments[depth - 1] ?? '';
      if (held.kind !== 'role') {
        return new NodeNotFoundError({
          reason: LookupFailure.NOT_A_CONTAINER,
          ref,
          segment,
          scope: held.name,
          kind: held.kind,
        });
      }
      return new NodeNotFoundError({
        reason: LookupFailure.NO_SUCH_MEMBER,
        ref,
        segment,
        scope: held.name,
        kind: held.kind,
        known: sorted(this.childrenOf(held).map((member) => member.name)),
      });
    }
    return new NodeNotFoundError({
      reason: LookupFailure.NO_SUCH_MEMBER,
      ref,
      segment: segments[segments.length - 1] ?? '',
    });
  }

  tool(ref: string): CompiledTool {
    const node = this.find(ref);
    if (node.kind !== 'tool') {
      throw new NodeNotFoundError({
        reason: LookupFailure.WRONG_KIND,
        ref,
        kind: node.kind,
        wanted: 'tool',
      });
    }
    return node;
  }

  bindingOf(ref: string): ToolBinding {
    if (!this.executionBound) {
      throw new ModelValidationError(
        'This Index is disclosure-only and has no executable bindings. Compile a bound Index for runtime execution.',
      );
    }
    const binding = this.tool(ref).binding;
    if (binding === undefined) {
      throw new ModelValidationError(
        `Tool ${JSON.stringify(ref)} has no executable binding in this Index.`,
      );
    }
    return binding;
  }

  schemaOf(node: CompiledNode): JsonObject {
    return this.bindingOf(this.refOf(node)).schema;
  }

  refOf(node: CompiledNode): string {
    const ref = this.#refByNode.get(node);
    if (ref === undefined) throw new ModelValidationError('Node is not registered in this Index.');
    return ref;
  }

  parentOf(node: CompiledNode): CompiledRole | undefined {
    if (!this.#parentByNode.has(node))
      throw new ModelValidationError('Node is not registered in this Index.');
    return this.#parentByNode.get(node);
  }

  childrenOf(node: CompiledNode): readonly CompiledNode[] {
    this.refOf(node);
    return node.kind === 'role'
      ? Object.freeze([...node.children, ...node.skills, ...node.tools])
      : EMPTY_NODES;
  }

  usesOf(ref: string): readonly string[] {
    return this.find(ref).uses;
  }

  dependentsOf(ref: string): readonly string[] {
    this.find(ref);
    return this.#dependents.get(ref) ?? EMPTY_REFS;
  }

  ofKind<K extends NodeKind>(kind: K): readonly Extract<CompiledNode, { readonly kind: K }>[] {
    return (this.#byKind.get(kind) ?? EMPTY_NODES) as readonly Extract<
      CompiledNode,
      { readonly kind: K }
    >[];
  }

  *walk(): IterableIterator<readonly [string, CompiledNode]> {
    for (const [ref, node] of this.#byRef) yield Object.freeze([ref, node]);
  }

  *nodesWithRefs(): IterableIterator<readonly [string, CompiledNode]> {
    yield* this.walk();
  }

  *skills(): IterableIterator<readonly [string, CompiledSkill]> {
    for (const node of this.ofKind('skill')) yield Object.freeze([this.refOf(node), node]);
  }

  *rolesWithRefs(): IterableIterator<readonly [string, CompiledRole]> {
    for (const [ref, node] of this.walk()) {
      if (node.kind === 'role') yield Object.freeze([ref, node]);
    }
  }

  *rolesByLevel(): IterableIterator<readonly [string, CompiledRole]> {
    const queue: Array<readonly [string, CompiledRole]> = this.roots.flatMap((node) =>
      node.kind === 'role' ? [[this.refOf(node), node] as const] : [],
    );
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const entry = queue[cursor];
      if (entry === undefined) continue;
      const [ref, role] = entry;
      yield Object.freeze([ref, role]);
      for (const child of this.childrenOf(role)) {
        if (child.kind === 'role') queue.push([this.refOf(child), child]);
      }
    }
  }

  matchingRefs(value: string, limit: number): ReferenceMatches {
    return matchingRefs(this.#byRef.keys(), value, limit);
  }

  signpost(ref: string): readonly SignpostLevel[] {
    const canonical = this.refOf(this.find(ref));
    const parts = canonical.split(REFERENCE_SEPARATOR);
    const levels: SignpostLevel[] = [];
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join(REFERENCE_SEPARATOR);
      const subRoleCount = this.childrenOf(this.find(ancestor)).filter(
        (node) => node.kind === 'role',
      ).length;
      levels.push(Object.freeze({ ref: ancestor, subRoleCount }));
    }
    return Object.freeze(levels);
  }

  *crossings(): IterableIterator<ReferenceCrossing> {
    for (const [sourceRef, node] of this.walk()) {
      const sourceRoot = sourceRef.split(REFERENCE_SEPARATOR)[0] ?? '';
      for (const targetRef of node.uses) {
        const targetRoot = targetRef.split(REFERENCE_SEPARATOR)[0] ?? '';
        if (sourceRoot !== targetRoot) {
          yield Object.freeze({ sourceRef, targetRef, targetRoot });
        }
      }
    }
  }
}

const EMPTY_NODES: readonly CompiledNode[] = Object.freeze([]);
const EMPTY_REFS: readonly string[] = Object.freeze([]);

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort(compareCodePoints);
}
