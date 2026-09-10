import type { BaseNodeDeclaration, Factory } from './node.js';
import type { SkillDeclaration } from './skill.js';
import type { ToolDeclaration } from './tool.js';

const PRE_PROCESS = Symbol('ContexturePreProcess');
const POST_PROCESS = Symbol('ContexturePostProcess');

/** A role is a containment and responsibility boundary. */
export interface RoleDeclaration extends BaseNodeDeclaration {
  readonly kind: 'role';
  readonly instructions: string;
  readonly preProcess?: Factory<PreProcessDeclaration>;
  readonly children?: readonly Factory<RoleDeclaration>[];
  readonly postProcess?: Factory<PostProcessDeclaration>;
  readonly skills?: readonly Factory<SkillDeclaration>[];
  readonly tools?: readonly Factory<ToolDeclaration>[];
}

/** A Role specialized as optional preparation procedure and equipment. */
export interface PreProcessDeclaration extends RoleDeclaration {
  readonly [PRE_PROCESS]: true;
}

/** A Role specialized as optional finishing procedure and equipment. */
export interface PostProcessDeclaration extends RoleDeclaration {
  readonly [POST_PROCESS]: true;
}

/** Create one runtime-verifiable PreProcess declaration. */
export function definePreProcess(
  declaration: Omit<PreProcessDeclaration, typeof PRE_PROCESS>,
): PreProcessDeclaration {
  if (isPostProcessDeclaration(declaration)) {
    throw new TypeError('A PostProcess cannot also be declared as a PreProcess.');
  }
  return Object.freeze({ ...declaration, [PRE_PROCESS]: true as const });
}

/** Create one runtime-verifiable PostProcess declaration. */
export function definePostProcess(
  declaration: Omit<PostProcessDeclaration, typeof POST_PROCESS>,
): PostProcessDeclaration {
  if (isPreProcessDeclaration(declaration)) {
    throw new TypeError('A PreProcess cannot also be declared as a PostProcess.');
  }
  return Object.freeze({ ...declaration, [POST_PROCESS]: true as const });
}

/** @internal Verify a constructed PreProcess. */
export function isPreProcessDeclaration(value: unknown): value is PreProcessDeclaration {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, PRE_PROCESS) === true &&
    Reflect.get(value, POST_PROCESS) !== true
  );
}

/** @internal Verify a constructed PostProcess. */
export function isPostProcessDeclaration(value: unknown): value is PostProcessDeclaration {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, POST_PROCESS) === true &&
    Reflect.get(value, PRE_PROCESS) !== true
  );
}
