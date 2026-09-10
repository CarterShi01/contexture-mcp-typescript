/** Compatibility barrel for the split Contexture model declaration modules. */
export type {
  BaseNodeDeclaration,
  ContextNode,
  Factory,
  NodeDeclaration,
  NodeKind,
} from './node.js';
export type { PublicationDeclaration, RoleDeclaration } from './role.js';
export { definePublication } from './role.js';
export type { SkillDeclaration } from './skill.js';
export type { ToolCallContext, ToolDeclaration, ToolDefinition } from './tool.js';
export { defineTool } from './tool.js';
export { Channels } from './channels.js';
export type { ChannelHandle, CleanupRegistrar } from './channels.js';
