import type { BaseNodeDeclaration } from './node.js';

/** A skill is model-followed procedural knowledge. */
export interface SkillDeclaration extends BaseNodeDeclaration {
  readonly kind: 'skill';
  readonly instructions: string;
}
