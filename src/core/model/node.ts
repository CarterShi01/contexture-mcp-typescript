import type { RoleDeclaration } from './role.js';
import type { SkillDeclaration } from './skill.js';
import type { ToolDeclaration } from './tool.js';

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

/** The closed union accepted at an application root or inside a compiled Index. */
export type NodeDeclaration = RoleDeclaration | SkillDeclaration | ToolDeclaration<never, unknown>;
