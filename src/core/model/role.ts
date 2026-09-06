import type { BaseNodeDeclaration, Factory } from './node.js';
import type { SkillDeclaration } from './skill.js';
import type { ToolDeclaration } from './tool.js';

/** A role is a containment and responsibility boundary. */
export interface RoleDeclaration extends BaseNodeDeclaration {
  readonly kind: 'role';
  readonly instructions: string;
  readonly children?: readonly Factory<RoleDeclaration>[];
  readonly skills?: readonly Factory<SkillDeclaration>[];
  readonly tools?: readonly Factory<ToolDeclaration>[];
}
