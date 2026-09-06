/** A person-controlled MCP Prompt pointing at one existing Contexture node. */
export interface PromptDeclaration {
  readonly opens: string;
  readonly description: string;
  readonly name?: string;
  readonly modelMayOpen?: boolean;
}

/** Native TypeScript name for one declared person-facing MCP Prompt. */
export type Prompt = PromptDeclaration;
