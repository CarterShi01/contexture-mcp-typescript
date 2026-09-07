import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { Gateway } from '../core/model/system-api.js';
import { RootSelection } from '../core/model/root-selection.js';
import { principalOf } from './identity.js';
import { COMPLETION_LIMIT, GOTO_ARGUMENT, GOTO_PROMPT, truncatedCompletion } from './messages.js';
import type { GatewayName } from '../core/mcp-interface/tool.js';
import { Publications } from './surface/publications.js';

export { compileRuntimeApplication, compileStructuralApplication } from './application.js';
export type { DisclosureApplication, RuntimeApplication } from './application.js';
export type {
  CompiledApplication,
  CompiledNode,
  CompiledRole,
  CompiledSkill,
  CompiledTool,
  Index,
  ReferenceCrossing,
  SignpostLevel,
} from '../core/model/compiler.js';
export { RestRouter, RestSurface } from './rest.js';
export type {
  Authenticator,
  RestListenOptions,
  RestMethod,
  RestRoute,
  RestServerHandle,
  WebRequest,
} from './rest.js';
export {
  DISCLOSURE_GATEWAY,
  EXECUTION_GATEWAY,
  Gateway,
  GATEWAY,
  takenByPersonMessage,
  unresolvedMessage,
  wrongDoorMessage,
} from '../core/model/system-api.js';
export type { GatewayTool } from '../core/model/system-api.js';
export { Publications } from './surface/publications.js';
export type { PromptCard, ResourceCard } from './surface/publications.js';
export {
  buildInstructions,
  INSTRUCTIONS_LIMIT,
  neutralInstructions,
  ROSTER_BUDGET,
  SELF_CONTAINED_PREFIX,
} from './instructions.js';
export {
  COMMAND_CLOSING,
  COMMAND_PREAMBLE,
  commandDescription,
  COMPLETION_LIMIT,
  GOTO_ARGUMENT,
  GOTO_ARGUMENT_DESCRIPTION,
  GOTO_DESCRIPTION,
  GOTO_PROMPT,
  PREAMBLE,
  REF_RULE,
  SIGNPOST_PREAMBLE,
  signpost,
  truncatedCompletion,
} from './messages.js';
export {
  ContextureOptions,
  DEFAULT_HOST,
  DEFAULT_PATH,
  DEFAULT_PORT,
  LOOPBACK,
  ServeError,
} from './options.js';
export { configureLogging, LOG_LEVELS } from './logging.js';
export type { LogLevel } from './logging.js';
export type { Transport } from './options.js';
export { buildServer, ContextureServer, PACKAGE_VERSION } from './server.js';
export type { HttpServerHandle } from './server.js';
export { Launch, claudeCodeConfig, cliCommands, codexConfig, cursorConfig } from './launch.js';
export { FixedRootSelector, HeaderRootSelector, ROOTS_HEADER } from './root-selector.js';
export type { RootCeiling, RootSelector } from './root-selector.js';
export { Auth, principalOf, PRINCIPAL_EXTRA } from './identity.js';
export type { TokenVerifier } from './identity.js';

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
export function createMcpServer(
  identity: ServerIdentity,
  options: { readonly instructions?: string } = {},
): McpServer {
  return new McpServer({ name: identity.name, version: identity.version }, options);
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
  options: { readonly selection?: RootSelection; readonly instructions?: string } = {},
): ContextureMcpServer {
  const selection = options.selection ?? RootSelection.all();
  const server = createMcpServer(
    identity,
    options.instructions === undefined ? {} : { instructions: options.instructions },
  );
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
          async () => toolResult(() => gateway.discover(selection)),
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
          async ({ ref }) =>
            toolResult(async () => {
              publications?.checkModelOpen(ref, selection);
              return gateway.open(ref, selection);
            }),
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
          async ({ ref, arguments: arguments_ }, context) =>
            toolResult(() =>
              gateway.invokeReadOnly(
                ref,
                arguments_,
                { principal: principalOf(context.http?.authInfo) },
                selection,
              ),
            ),
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
          async ({ ref, arguments: arguments_ }, context) =>
            toolResult(() =>
              gateway.invoke(
                ref,
                arguments_,
                { principal: principalOf(context.http?.authInfo) },
                selection,
              ),
            ),
        );
        break;
    }
  }
  if (publications !== undefined) installPublications(server, publications, selection);
  return Object.freeze({
    server,
    gateway,
    gatewayNames: Object.freeze(gateway.tools.map((tool) => tool.name)),
  });
}

function installPublications(
  server: McpServer,
  publications: Publications,
  selection: RootSelection,
): void {
  for (const prompt of publications.promptCards(selection)) {
    if (prompt.name === GOTO_PROMPT) {
      server.registerPrompt(
        prompt.name,
        {
          description: prompt.description,
          argsSchema: z.strictObject({ [GOTO_ARGUMENT]: z.string() }),
        },
        async ({ ref }) => promptResult(await publications.goto(ref, selection)),
      );
    } else {
      server.registerPrompt(prompt.name, { description: prompt.description }, async () =>
        promptResult(await publications.command(prompt.name, selection)),
      );
    }
  }
  for (const resource of publications.resourceCards(selection)) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({
        contents: [{ uri: uri.href, text: String(await publications.read(uri.href, selection)) }],
      }),
    );
  }
  installCompletion(server, publications, selection);
}

/**
 * Register the protocol completion handler directly instead of using the SDK's
 * schema helper. The helper derives `total` from its already-truncated values;
 * Contexture must report the real selected-graph total to tell a person whether
 * a ref list is complete.
 */
function installCompletion(
  server: McpServer,
  publications: Publications,
  selection: RootSelection,
): void {
  server.server.registerCapabilities({ completions: {} });
  server.server.setRequestHandler('completion/complete', async (request) => {
    const ref = request.params.ref;
    const argument = request.params.argument;
    if (ref.type !== 'ref/prompt' || ref.name !== GOTO_PROMPT || argument.name !== GOTO_ARGUMENT) {
      return { completion: { values: [], total: 0, hasMore: false } };
    }
    const completed = publications.complete(argument.value, selection, COMPLETION_LIMIT);
    const values = [...completed.values];
    if (completed.total > values.length && values.length > 0) {
      values[values.length - 1] = truncatedCompletion(values.length, completed.total);
    }
    return {
      completion: {
        values,
        total: completed.total,
        hasMore: completed.total > completed.values.length,
      },
    };
  });
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
