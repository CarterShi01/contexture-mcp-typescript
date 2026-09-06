/** A lazy factory. Calling it belongs to compilation, never declaration. */
export type Factory<T> = () => T;

/** The closed set of progressively disclosed Contexture node kinds. */
export type NodeKind = 'role' | 'skill' | 'tool';

/** Facts shared by every Contexture node declaration. */
export interface NodeDeclaration {
  readonly kind: NodeKind;
  readonly name: string;
  readonly description: string;
  readonly uses?: readonly string[];
}

/** A role is a containment and responsibility boundary. */
export interface RoleDeclaration extends NodeDeclaration {
  readonly kind: 'role';
  readonly instructions: string;
  readonly members?: readonly Factory<NodeDeclaration>[];
}

/** A skill is model-followed procedural knowledge. */
export interface SkillDeclaration extends NodeDeclaration {
  readonly kind: 'skill';
  readonly instructions: string;
}

/** A tool is an executable capability; its binding will own schema and validation. */
export interface ToolDeclaration<Input = unknown, Output = unknown> extends NodeDeclaration {
  readonly kind: 'tool';
  readonly readOnly: boolean;
  readonly invoke: (input: Input) => Output | Promise<Output>;
}

/** The lazy application composition root. */
export interface ApplicationDeclaration {
  readonly name: string;
  readonly roots: readonly Factory<RoleDeclaration>[];
  readonly promptRoots?: readonly Factory<RoleDeclaration>[];
}

/**
 * Declare an application without constructing any node or opening any resource.
 *
 * Structural compilation and conformance behavior intentionally remain future
 * work; this helper only establishes the lazy public boundary.
 */
export function defineApplication(declaration: ApplicationDeclaration): ApplicationDeclaration {
  if (declaration.name.trim().length === 0) {
    throw new TypeError('Application name must not be empty.');
  }
  if (declaration.roots.length === 0) {
    throw new TypeError('Application must declare at least one model-visible root.');
  }

  return Object.freeze({ ...declaration });
}
