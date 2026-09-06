/** A person-controlled MCP Prompt pointing at one existing Contexture node. */
export interface PromptDeclaration {
  readonly opens: string;
  readonly description: string;
  readonly name?: string;
  readonly modelMayOpen?: boolean;
}
