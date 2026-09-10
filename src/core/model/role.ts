import type { BaseNodeDeclaration, Factory } from './node.js';
import type { SkillDeclaration } from './skill.js';
import type { ToolDeclaration } from './tool.js';

const PUBLICATION = Symbol('ContexturePublication');

/** A role is a containment and responsibility boundary. */
export interface RoleDeclaration extends BaseNodeDeclaration {
  readonly kind: 'role';
  readonly instructions: string;
  readonly children?: readonly Factory<RoleDeclaration>[];
  readonly publication?: Factory<PublicationDeclaration>;
  readonly skills?: readonly Factory<SkillDeclaration>[];
  readonly tools?: readonly Factory<ToolDeclaration>[];
}

/** A Role specialized as optional finishing procedure and equipment. */
export interface PublicationDeclaration extends RoleDeclaration {
  readonly [PUBLICATION]: true;
}

/** Create one runtime-verifiable Publication declaration. */
export function definePublication(
  declaration: Omit<PublicationDeclaration, typeof PUBLICATION>,
): PublicationDeclaration {
  return Object.freeze({ ...declaration, [PUBLICATION]: true as const });
}

/** @internal Verify that a publication factory did not return an ordinary Role. */
export function isPublicationDeclaration(value: unknown): value is PublicationDeclaration {
  return typeof value === 'object' && value !== null && Reflect.get(value, PUBLICATION) === true;
}
