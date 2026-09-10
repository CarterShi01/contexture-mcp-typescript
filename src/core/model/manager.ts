import { defineManagedApplication, type ManagedApplicationDeclaration } from '../../application.js';
import { ModelValidationError } from '../foundation/errors.js';
import { REFERENCE_SEPARATOR } from '../foundation/vocabulary.js';
import { compileApplication, type CompiledApplication } from './compiler.js';
import type { ChannelHandle } from './channels.js';
import type { Factory, NodeDeclaration, NodeKind } from './node.js';
import {
  definePublication,
  isPublicationDeclaration,
  type PublicationDeclaration,
  type RoleDeclaration,
} from './role.js';
import type { SkillDeclaration } from './skill.js';
import type { ToolDeclaration } from './tool.js';

/** A factory registered explicitly as a root Role. */
export type RoleFactory = Factory<RoleDeclaration>;
/** A factory registered explicitly as a standalone root Skill. */
export type SkillFactory = Factory<SkillDeclaration>;
/** A factory registered explicitly as a standalone root Tool. */
export type ToolFactory = Factory<ToolDeclaration>;

/**
 * Imperative owner for a pre-serving Contexture forest.
 *
 * A normal ApplicationDeclaration retains lazy factories. A ControllerManager
 * intentionally constructs each registered factory once, validates and owns a
 * deep immutable snapshot, then issues fresh declaration trees on every
 * application or compilation. This is useful for embedding hosts that want a
 * deliberate registration phase without exposing mutable controller identity
 * to an already-serving graph.
 */
export class ControllerManager {
  readonly #roles: RoleDeclaration[] = [];
  readonly #skills: SkillDeclaration[] = [];
  readonly #tools: ToolDeclaration[] = [];
  readonly #seen = new WeakMap<object, string>();
  #channels: ChannelHandle | undefined;

  constructor(options: { readonly channels?: ChannelHandle } = {}) {
    this.#channels = options.channels;
  }

  /** Registered Role snapshots, preserving Role registration order. */
  get roles(): readonly RoleDeclaration[] {
    return Object.freeze(this.#roles.map((node) => cloneNode(node) as RoleDeclaration));
  }

  /** Registered standalone Skill snapshots, preserving Skill registration order. */
  get skills(): readonly SkillDeclaration[] {
    return Object.freeze(this.#skills.map((node) => cloneNode(node) as SkillDeclaration));
  }

  /** Registered standalone Tool snapshots, preserving Tool registration order. */
  get tools(): readonly ToolDeclaration[] {
    return Object.freeze(this.#tools.map((node) => cloneNode(node) as ToolDeclaration));
  }

  /** Root snapshots in Contexture order: Roles, then Skills, then Tools. */
  get roots(): readonly NodeDeclaration[] {
    return Object.freeze([...this.roles, ...this.skills, ...this.tools]);
  }

  /** The Channels identity captured by Applications produced after this point. */
  get channels(): ChannelHandle | undefined {
    return this.#channels;
  }

  /** Construct, validate, and capture one root Role. */
  registerRole(factory: RoleFactory): RoleDeclaration {
    return this.register(factory, 'role') as RoleDeclaration;
  }

  /** Construct, validate, and capture one standalone root Skill. */
  registerSkill(factory: SkillFactory): SkillDeclaration {
    return this.register(factory, 'skill') as SkillDeclaration;
  }

  /** Construct, validate, and capture one standalone root Tool. */
  registerTool(factory: ToolFactory): ToolDeclaration {
    return this.register(factory, 'tool') as ToolDeclaration;
  }

  /** Construct and dispatch one root by its declared Contexture kind. */
  registerRoot(factory: Factory<NodeDeclaration>): NodeDeclaration {
    return this.register(factory);
  }

  /**
   * Change the serving dependency only for future Application snapshots.
   * Existing ApplicationDeclarations and compiled Index values retain the
   * Channels identity captured when they were produced.
   */
  rebindChannels(channels: ChannelHandle | undefined): void {
    this.#channels = channels;
  }

  /** Produce an immutable lazy Application snapshot of roots registered so far. */
  application(name: string): ManagedApplicationDeclaration {
    const roots = this.#roots().map((node) => frozenFactory(node));
    return defineManagedApplication({
      name,
      roots,
      ...(this.#channels === undefined ? {} : { channels: this.#channels }),
    });
  }

  /** Compile a fresh immutable Index from the manager's current owned snapshot. */
  compile(name: string): CompiledApplication {
    return compileApplication(this.application(name));
  }

  private register(factory: Factory<NodeDeclaration>, expected?: NodeKind): NodeDeclaration {
    if (typeof factory !== 'function') {
      throw new ModelValidationError(
        `ControllerManager Register${title(expected)} requires a lazy factory.`,
      );
    }
    const declaration = factory();
    if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
      throw new ModelValidationError(
        'A ControllerManager registration factory must return a node declaration object.',
      );
    }
    if (expected !== undefined && declaration.kind !== expected) {
      throw new ModelValidationError(
        `ControllerManager Register${title(expected)} received a ${String(declaration.kind)}, not a ${expected}.`,
      );
    }
    const rootName = typeof declaration.name === 'string' ? declaration.name.trim() : '';
    const taken = this.#roots().find((node) => node.name === rootName);
    if (taken !== undefined) {
      throw new ModelValidationError(
        `Root ${JSON.stringify(rootName)} is already registered as a ${taken.kind}; a root name is the first segment of every address, so another ${String(declaration.kind)} root would make its branch unreachable.`,
      );
    }
    const pending = new Map<object, string>();
    const captured = captureNode(declaration, rootName, this.#seen, pending, new Set());
    for (const [source, path] of pending) this.#seen.set(source, path);
    switch (captured.kind) {
      case 'role':
        this.#roles.push(captured);
        break;
      case 'skill':
        this.#skills.push(captured);
        break;
      case 'tool':
        this.#tools.push(captured);
        break;
    }
    return cloneNode(captured);
  }

  #roots(): readonly NodeDeclaration[] {
    return [...this.#roles, ...this.#skills, ...this.#tools];
  }
}

function captureNode(
  candidate: unknown,
  path: string,
  seen: WeakMap<object, string>,
  pending: Map<object, string>,
  active: Set<object>,
): NodeDeclaration {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new ModelValidationError(
      'A ControllerManager registration factory must return a node declaration object.',
    );
  }
  const declaration = candidate as NodeDeclaration;
  const previous = pending.get(declaration) ?? seen.get(declaration);
  if (previous !== undefined) {
    if (active.has(declaration)) {
      throw new ModelValidationError(
        `Node ${JSON.stringify(nameOf(declaration))} contains itself at ${JSON.stringify(previous)} on the path to ${JSON.stringify(path)}.`,
      );
    }
    throw new ModelValidationError(
      `Node ${JSON.stringify(nameOf(declaration))} is held twice at ${JSON.stringify(previous)} and ${JSON.stringify(path)}; one capability has one canonical address.`,
    );
  }
  validateNode(declaration);
  pending.set(declaration, path);
  active.add(declaration);
  try {
    if (declaration.kind === 'role') {
      const role = declaration as RoleDeclaration;
      const children = captureGroup(role.children, 'role', path, seen, pending, active);
      const publication = capturePublication(role.publication, path, seen, pending, active);
      const skills = captureGroup(role.skills, 'skill', path, seen, pending, active);
      const tools = captureGroup(role.tools, 'tool', path, seen, pending, active);
      ensureUniqueMembers(path, [
        ...children,
        ...(publication === undefined ? [] : [publication]),
        ...skills,
        ...tools,
      ]);
      const capturedRole = {
        kind: 'role' as const,
        name: role.name.trim(),
        description: role.description,
        instructions: role.instructions,
        ...(role.uses === undefined ? {} : { uses: Object.freeze([...role.uses]) }),
        ...(children.length === 0 ? {} : { children: factoriesFor(children as RoleDeclaration[]) }),
        ...(publication === undefined
          ? {}
          : { publication: frozenFactory(publication) as Factory<PublicationDeclaration> }),
        ...(skills.length === 0 ? {} : { skills: factoriesFor(skills as SkillDeclaration[]) }),
        ...(tools.length === 0 ? {} : { tools: factoriesFor(tools as ToolDeclaration[]) }),
      };
      return isPublicationDeclaration(role)
        ? definePublication(capturedRole as PublicationDeclaration)
        : Object.freeze(capturedRole);
    }
    if (declaration.kind === 'skill') {
      const skill = declaration as SkillDeclaration;
      return Object.freeze({
        kind: 'skill' as const,
        name: skill.name.trim(),
        description: skill.description,
        instructions: skill.instructions,
        ...(skill.uses === undefined ? {} : { uses: Object.freeze([...skill.uses]) }),
      });
    }
    const tool = declaration as ToolDeclaration;
    const input = toolInput(tool);
    return Object.freeze({
      kind: 'tool' as const,
      name: tool.name.trim(),
      description: tool.description,
      readOnly: tool.readOnly,
      input,
      invoke: tool.invoke,
      ...(tool.uses === undefined ? {} : { uses: Object.freeze([...tool.uses]) }),
    });
  } finally {
    active.delete(declaration);
  }
}

function capturePublication(
  factory: Factory<PublicationDeclaration> | undefined,
  parent: string,
  seen: WeakMap<object, string>,
  pending: Map<object, string>,
  active: Set<object>,
): PublicationDeclaration | undefined {
  if (factory === undefined) return undefined;
  if (typeof factory !== 'function') {
    throw new ModelValidationError(`Role ${JSON.stringify(parent)} publication must be a factory.`);
  }
  const publication = factory();
  if (!isPublicationDeclaration(publication)) {
    throw new ModelValidationError(
      `Role ${JSON.stringify(parent)} publication factory must return a Publication created with definePublication.`,
    );
  }
  return captureNode(
    publication,
    `${parent}${REFERENCE_SEPARATOR}${publication.name.trim()}`,
    seen,
    pending,
    active,
  ) as PublicationDeclaration;
}

function captureGroup(
  factories: readonly Factory<NodeDeclaration>[] | undefined,
  expected: NodeKind,
  parent: string,
  seen: WeakMap<object, string>,
  pending: Map<object, string>,
  active: Set<object>,
): NodeDeclaration[] {
  if (factories === undefined) return [];
  if (!Array.isArray(factories)) {
    throw new ModelValidationError(
      `Role ${JSON.stringify(parent)} ${expected} group must be an array.`,
    );
  }
  return factories.map((factory) => {
    if (typeof factory !== 'function') {
      throw new ModelValidationError(
        `Role ${JSON.stringify(parent)} has a non-factory ${expected} member.`,
      );
    }
    const member = factory();
    if (typeof member !== 'object' || member === null || Array.isArray(member)) {
      throw new ModelValidationError(
        `Role ${JSON.stringify(parent)} ${expected} factory returned no node.`,
      );
    }
    if ((member as NodeDeclaration).kind !== expected) {
      throw new ModelValidationError(
        `Role ${JSON.stringify(parent)} member ${JSON.stringify(nameOf(member))} is a ${String((member as NodeDeclaration).kind)} in the ${expected} group.`,
      );
    }
    return captureNode(
      member,
      `${parent}${REFERENCE_SEPARATOR}${nameOf(member)}`,
      seen,
      pending,
      active,
    );
  });
}

function validateNode(declaration: NodeDeclaration): void {
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
  if (!Array.isArray(uses)) {
    throw new ModelValidationError(
      `Node ${JSON.stringify(declaration.name)} uses must be an array.`,
    );
  }
  const used = new Set<string>();
  for (const ref of uses) {
    requireText(ref, `Node ${JSON.stringify(declaration.name)} names an empty reference in uses.`);
    if (used.has(ref)) {
      throw new ModelValidationError(
        `Node ${JSON.stringify(declaration.name)} names ${JSON.stringify(ref)} more than once in uses.`,
      );
    }
    used.add(ref);
  }
  if (declaration.kind === 'role') {
    requireText(
      declaration.instructions,
      `Role ${JSON.stringify(declaration.name)} must have instructions.`,
    );
    return;
  }
  if (declaration.kind === 'skill') {
    requireText(
      declaration.instructions,
      `Skill ${JSON.stringify(declaration.name)} must have instructions.`,
    );
    return;
  }
  if (typeof declaration.readOnly !== 'boolean') {
    throw new ModelValidationError(
      `Tool ${JSON.stringify(declaration.name)} must declare readOnly.`,
    );
  }
  if (typeof declaration.invoke !== 'function') {
    throw new ModelValidationError(`Tool ${JSON.stringify(declaration.name)} must declare invoke.`);
  }
  if (typeof declaration.input !== 'object' || declaration.input === null) {
    throw new ModelValidationError(
      `Tool ${JSON.stringify(declaration.name)} must declare a Zod input schema.`,
    );
  }
}

function ensureUniqueMembers(parent: string, members: readonly NodeDeclaration[]): void {
  const names = new Set<string>();
  for (const member of members) {
    if (names.has(member.name)) {
      throw new ModelValidationError(
        `Role ${JSON.stringify(parent)} contains more than one member named ${JSON.stringify(member.name)}.`,
      );
    }
    names.add(member.name);
  }
}

function cloneNode(node: NodeDeclaration): NodeDeclaration {
  if (node.kind === 'role') {
    const clonedRole = {
      kind: 'role' as const,
      name: node.name,
      description: node.description,
      instructions: node.instructions,
      ...(node.uses === undefined ? {} : { uses: Object.freeze([...node.uses]) }),
      ...(node.children === undefined ? {} : { children: cloneFactories(node.children) }),
      ...(node.publication === undefined
        ? {}
        : {
            publication: cloneFactories([node.publication])[0] as Factory<PublicationDeclaration>,
          }),
      ...(node.skills === undefined ? {} : { skills: cloneFactories(node.skills) }),
      ...(node.tools === undefined ? {} : { tools: cloneFactories(node.tools) }),
    };
    return isPublicationDeclaration(node)
      ? definePublication(clonedRole as PublicationDeclaration)
      : Object.freeze(clonedRole);
  }
  if (node.kind === 'skill') {
    return Object.freeze({
      kind: 'skill' as const,
      name: node.name,
      description: node.description,
      instructions: node.instructions,
      ...(node.uses === undefined ? {} : { uses: Object.freeze([...node.uses]) }),
    });
  }
  return Object.freeze({
    kind: 'tool' as const,
    name: node.name,
    description: node.description,
    readOnly: node.readOnly,
    input: toolInput(node),
    invoke: node.invoke,
    ...(node.uses === undefined ? {} : { uses: Object.freeze([...node.uses]) }),
  });
}

function factoriesFor<T extends NodeDeclaration>(nodes: readonly T[]): readonly Factory<T>[] {
  return Object.freeze(nodes.map((node) => frozenFactory(node) as Factory<T>));
}

function cloneFactories<T extends NodeDeclaration>(
  factories: readonly Factory<T>[],
): readonly Factory<T>[] {
  return Object.freeze(
    factories.map((factory) => {
      const captured = factory();
      return frozenFactory(captured) as Factory<T>;
    }),
  );
}

function frozenFactory(node: NodeDeclaration): Factory<NodeDeclaration> {
  return () => cloneNode(node);
}

function requireText(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new ModelValidationError(message);
}

function toolInput(tool: ToolDeclaration): NonNullable<ToolDeclaration['input']> {
  if (tool.input === undefined) {
    throw new ModelValidationError(
      `Tool ${JSON.stringify(tool.name)} must declare a Zod input schema.`,
    );
  }
  return tool.input;
}

function nameOf(value: unknown): string {
  return typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string'
    ? value.name.trim()
    : '';
}

function title(kind: NodeKind | undefined): string {
  return kind === undefined ? 'Root' : kind.slice(0, 1).toUpperCase() + kind.slice(1);
}
