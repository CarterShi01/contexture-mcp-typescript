/** A lazy factory. Calling it belongs to compilation, never declaration. */
export type Factory<T> = () => T;

/** The closed set of progressively disclosed Contexture node kinds. */
export type NodeKind = 'role' | 'skill' | 'tool';

/** Facts shared by every Contexture node declaration. */
export interface BaseNodeDeclaration {
  readonly kind: NodeKind;
  readonly name: string;
  readonly description: string;
  readonly uses?: readonly string[];
}

/** A role is a containment and responsibility boundary. */
export interface RoleDeclaration extends BaseNodeDeclaration {
  readonly kind: 'role';
  readonly instructions: string;
  readonly children?: readonly Factory<RoleDeclaration>[];
  readonly skills?: readonly Factory<SkillDeclaration>[];
  readonly tools?: readonly Factory<ToolDeclaration>[];
}

/** A skill is model-followed procedural knowledge. */
export interface SkillDeclaration extends BaseNodeDeclaration {
  readonly kind: 'skill';
  readonly instructions: string;
}

/** Context supplied by Contexture when it invokes a business Tool. */
export interface ToolCallContext {
  readonly signal?: AbortSignal;
  readonly host?: unknown;
}

/** A tool is an executable capability; its Binding owns schema and validation. */
export interface ToolDeclaration<Input = unknown, Output = unknown> extends BaseNodeDeclaration {
  readonly kind: 'tool';
  readonly readOnly: boolean;
  readonly invoke: (input: Input, context: ToolCallContext) => Output | Promise<Output>;
}

/** The closed union accepted at an application root or inside a compiled Index. */
export type NodeDeclaration = RoleDeclaration | SkillDeclaration | ToolDeclaration;

/** The lazy application composition root. */
export interface ApplicationDeclaration {
  readonly name: string;
  readonly roots: readonly Factory<NodeDeclaration>[];
  readonly promptRoots?: readonly Factory<NodeDeclaration>[];
  readonly channels?: unknown;
}

/**
 * Declare an application without constructing nodes, opening dependencies, or
 * compiling an Index.
 */
export function defineApplication(declaration: ApplicationDeclaration): ApplicationDeclaration {
  if (typeof declaration.name !== 'string' || declaration.name.trim().length === 0) {
    throw new TypeError('Application name must not be empty.');
  }
  if (!Array.isArray(declaration.roots) || declaration.roots.length === 0) {
    throw new TypeError('Application must declare at least one model-visible root.');
  }
  if (declaration.roots.some((factory) => typeof factory !== 'function')) {
    throw new TypeError('Application roots must be lazy factories.');
  }
  if (
    declaration.promptRoots !== undefined &&
    (!Array.isArray(declaration.promptRoots) ||
      declaration.promptRoots.some((factory) => typeof factory !== 'function'))
  ) {
    throw new TypeError('Application promptRoots must be lazy factories.');
  }

  return Object.freeze({
    name: declaration.name,
    roots: Object.freeze([...declaration.roots]),
    ...(declaration.promptRoots === undefined
      ? {}
      : { promptRoots: Object.freeze([...declaration.promptRoots]) }),
    ...(declaration.channels === undefined ? {} : { channels: declaration.channels }),
  });
}
