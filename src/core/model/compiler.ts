import type {
  Channels,
  Factory,
  NodeDeclaration,
  NodeKind,
  RoleDeclaration,
  SkillDeclaration,
  ToolDeclaration,
} from './declarations.js';
import {
  ContainmentCycleError,
  DuplicateNameError,
  LookupFailure,
  ModelValidationError,
  NodeNotFoundError,
  UnresolvedReferenceError,
} from '../foundation/errors.js';
import { bindTool, type ToolBinding } from './binding.js';

const SEPARATOR = '/';

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

export interface CompiledApplication {
  readonly name: string;
  readonly roots: readonly CompiledNode[];
  readonly modelRoots: readonly CompiledNode[];
  readonly promptRoots: readonly CompiledNode[];
  readonly channels: import('./declarations.js').Channels | undefined;
  readonly executionBound: boolean;
  readonly size: number;
  find(ref: string): CompiledNode;
  tool(ref: string): CompiledTool;
  refOf(node: CompiledNode): string;
  parentOf(node: CompiledNode): CompiledRole | undefined;
  childrenOf(node: CompiledNode): readonly CompiledNode[];
  usesOf(ref: string): readonly string[];
  dependentsOf(ref: string): readonly string[];
  ofKind<K extends NodeKind>(kind: K): readonly Extract<CompiledNode, { readonly kind: K }>[];
  walk(): IterableIterator<readonly [string, CompiledNode]>;
}

interface CompilationState {
  readonly byRef: Map<string, CompiledNode>;
  readonly parentByNode: Map<CompiledNode, CompiledRole | undefined>;
  readonly refByNode: Map<CompiledNode, string>;
  readonly byKind: Map<NodeKind, CompiledNode[]>;
  readonly activeFactories: Set<Factory<NodeDeclaration>>;
  readonly declarations: WeakSet<object>;
  readonly bindTools: boolean;
}

/** The SDK-neutral fields required to construct a canonical model Index. */
export interface ApplicationCompilation {
  readonly name: string;
  readonly roots: readonly Factory<NodeDeclaration>[];
  readonly promptRoots?: readonly Factory<NodeDeclaration>[];
  readonly channels?: Channels;
  readonly resources?: readonly unknown[];
}

/** Compile one lazy application into an immutable, canonical forest snapshot. */
export function compileApplication(application: ApplicationCompilation): CompiledApplication {
  return compile(application, true);
}

/** Compile an independent structural projection with neither bindings nor Channels. */
export function compileDisclosureApplication(
  application: ApplicationCompilation,
): CompiledApplication {
  if (application.channels !== undefined) {
    throw new ModelValidationError(
      'A disclosure-only Contexture application cannot declare Channels.',
    );
  }
  if ((application.resources?.length ?? 0) > 0) {
    throw new ModelValidationError(
      'A disclosure-only Contexture application cannot declare Resources.',
    );
  }
  return compile(application, false);
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
  const ref = path.join(SEPARATOR);
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
  if (declaration.name.includes(SEPARATOR)) {
    throw new ModelValidationError(
      `Context node name ${JSON.stringify(declaration.name)} must not contain ${JSON.stringify(SEPARATOR)}.`,
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

class ImmutableIndex implements CompiledApplication {
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
    readonly channels: import('./declarations.js').Channels | undefined,
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

  find(ref: string): CompiledNode {
    if (ref.length === 0) {
      throw new NodeNotFoundError({
        reason: LookupFailure.EMPTY_REF,
        ref,
        known: this.roots.map((root) => root.name),
      });
    }

    const segments = ref.split(SEPARATOR);
    const rootSegment = segments[0] ?? '';
    const root = this.roots.find((candidate) => candidate.name === rootSegment);
    if (root === undefined) {
      throw new NodeNotFoundError({
        reason: LookupFailure.NO_SUCH_ROOT,
        ref,
        segment: rootSegment,
        known: this.roots.map((root) => root.name),
      });
    }
    let node: CompiledNode = root;

    for (const segment of segments.slice(1)) {
      const scope = this.refOf(node);
      if (node.kind !== 'role') {
        throw new NodeNotFoundError({
          reason: LookupFailure.NOT_A_CONTAINER,
          ref,
          segment,
          scope,
          kind: node.kind,
        });
      }
      const child: CompiledNode | undefined = this.childrenOf(node).find(
        (candidate) => candidate.name === segment,
      );
      if (child === undefined) {
        throw new NodeNotFoundError({
          reason: LookupFailure.NO_SUCH_MEMBER,
          ref,
          segment,
          scope,
          known: this.childrenOf(node).map((candidate) => candidate.name),
        });
      }
      node = child;
    }
    return node;
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
    yield* this.#byRef.entries();
  }
}

const EMPTY_NODES: readonly CompiledNode[] = Object.freeze([]);
const EMPTY_REFS: readonly string[] = Object.freeze([]);
