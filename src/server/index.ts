import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { Gateway } from '../core/model/system-api.js';
import type { GatewayName } from '../core/mcp-interface/tool.js';
import { Publications } from './surface/publications.js';

export { compileRuntimeApplication, compileStructuralApplication } from './application.js';
export type { DisclosureApplication, RuntimeApplication } from './application.js';
export { RestRouter } from './rest.js';
export type { RestMethod, RestRoute } from './rest.js';
export { Gateway, GATEWAY } from '../core/model/system-api.js';
export type { GatewayTool } from '../core/model/system-api.js';
export { Publications } from './surface/publications.js';
export type { PromptCard, ResourceCard } from './surface/publications.js';

/** Metadata required to identify a Contexture MCP server. */
export interface ServerIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Construct the official MCP server adapter without registering capabilities.
 *
 * Keeping the SDK import here proves and enforces that the authoring core is
 * SDK-neutral.
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
  publications?: Publications,
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
  if (publications !== undefined) installPublications(server, publications);
  return Object.freeze({
    server,
    gateway,
    gatewayNames: Object.freeze(gateway.tools.map((tool) => tool.name)),
  });
}

function installPublications(server: McpServer, publications: Publications): void {
  for (const prompt of publications.promptCards()) {
    if (prompt.name === 'goto') {
      server.registerPrompt(
        prompt.name,
        { description: prompt.description, argsSchema: z.strictObject({ ref: z.string() }) },
        async ({ ref }) => promptResult(await publications.goto(ref)),
      );
    } else {
      server.registerPrompt(prompt.name, { description: prompt.description }, async () =>
        promptResult(await publications.command(prompt.name)),
      );
    }
  }
  for (const resource of publications.resourceCards()) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({
        contents: [{ uri: uri.href, text: String(await publications.read(uri.href)) }],
      }),
    );
  }
}

function promptResult(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
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
