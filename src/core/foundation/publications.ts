/**
 * SDK-neutral declaration data for MCP's person- and host-controlled planes.
 *
 * These are intentionally plain TypeScript object shapes. Model validation
 * owns their meaning; an MCP adapter only translates already-validated data
 * to the official SDK. Keeping them here prevents the model from depending on
 * the sibling primitive-projection package merely to validate an application.
 */

/** A person-controlled publication that opens one existing Contexture node. */
export interface PromptDeclaration {
  readonly opens: string;
  readonly description: string;
  readonly name?: string;
  /** Omit or set true for ordinary model navigation; false reserves the ref for a person. */
  readonly modelMayOpen?: boolean;
}

/** Native TypeScript spelling for one declared person-facing publication. */
export type Prompt = PromptDeclaration;

/** A host-controlled publication backed by an argument-free read-only Tool. */
export interface ResourceDeclaration {
  readonly opens: string;
  readonly uri: string;
  readonly description: string;
  readonly name?: string;
  readonly mimeType?: string;
}

/** Native TypeScript spelling for one declared host-facing publication. */
export type Resource = ResourceDeclaration;
