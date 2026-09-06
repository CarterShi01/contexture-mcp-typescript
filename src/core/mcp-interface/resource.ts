/** A host-controlled MCP Resource backed by an argument-free read-only Tool. */
export interface ResourceDeclaration {
  readonly opens: string;
  readonly uri: string;
  readonly description: string;
  readonly name?: string;
  readonly mimeType?: string;
}

/** Native TypeScript name for one declared host-backed MCP Resource. */
export type Resource = ResourceDeclaration;
