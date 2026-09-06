import { McpServer } from '@modelcontextprotocol/server';

/** Metadata required to identify a Contexture MCP server. */
export interface ServerIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Construct the official MCP server adapter without registering capabilities.
 *
 * Gateway registration belongs to the upcoming compilation layer. Keeping the
 * SDK import here proves and enforces that the authoring core is SDK-neutral.
 */
export function createMcpServer(identity: ServerIdentity): McpServer {
  return new McpServer({ name: identity.name, version: identity.version });
}
