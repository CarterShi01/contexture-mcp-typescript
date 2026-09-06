import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { Gateway, type GatewayName } from '../core/index.js';

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

/** Official-SDK adapter whose only model-controlled tools are Contexture's gateway. */
export interface ContextureMcpServer {
  readonly server: McpServer;
  readonly gateway: Gateway;
  readonly gatewayNames: readonly GatewayName[];
}

/** Register the fixed Contexture gateway, never a business Tool, with the official SDK. */
export function createContextureMcpServer(
  identity: ServerIdentity,
  gateway: Gateway,
): ContextureMcpServer {
  const server = createMcpServer(identity);
  for (const tool of gateway.tools) {
    switch (tool.name) {
      case 'contexture_discover':
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: z.strictObject({}),
            annotations: { readOnlyHint: true },
          },
          async () => toolResult(() => gateway.discover()),
        );
        break;
      case 'contexture_open':
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: z.strictObject({ ref: z.string() }),
            annotations: { readOnlyHint: true },
          },
          async ({ ref }) => toolResult(() => gateway.open(ref)),
        );
        break;
      case 'contexture_invoke_read_only':
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: invocationSchema,
            annotations: { readOnlyHint: true },
          },
          async ({ ref, arguments: arguments_ }) =>
            toolResult(() => gateway.invokeReadOnly(ref, arguments_)),
        );
        break;
      case 'contexture_invoke':
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: invocationSchema,
            annotations: { readOnlyHint: false },
          },
          async ({ ref, arguments: arguments_ }) =>
            toolResult(() => gateway.invoke(ref, arguments_)),
        );
        break;
    }
  }
  return Object.freeze({
    server,
    gateway,
    gatewayNames: Object.freeze(gateway.tools.map((tool) => tool.name)),
  });
}

const invocationSchema = z.strictObject({
  ref: z.string(),
  arguments: z.record(z.string(), z.unknown()).nullable().optional(),
});

async function toolResult(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contexture request failed.';
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
}
