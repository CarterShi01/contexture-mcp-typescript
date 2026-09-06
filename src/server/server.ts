import {
  createServer,
  type IncomingMessage,
  type Server as NodeServer,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { ApplicationDeclaration } from '../application.js';
import { Gateway } from '../core/model/system-api.js';
import { RootSelection } from '../core/model/root-selection.js';

import { compileRuntimeApplication, type RuntimeApplication } from './application.js';
import { createContextureMcpServer, type ContextureMcpServer } from './index.js';
import { ContextureOptions } from './options.js';
import { Auth, principalOf } from './identity.js';
import type { RootSelector } from './root-selector.js';

export const PACKAGE_VERSION = '0.12.0rc1';

/** A live streamable-HTTP Contexture server that its caller may close. */
export interface HttpServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/** One compiled application and its transport-specific MCP assembly. */
export class ContextureServer {
  #built: ContextureMcpServer | undefined;
  readonly application: RuntimeApplication;
  readonly name: string;
  readonly version: string;
  readonly selection: RootSelection;
  readonly auth: Auth | undefined;
  readonly rootSelector: RootSelector | undefined;

  constructor(
    declaration: ApplicationDeclaration,
    options: {
      readonly version?: string;
      readonly selection?: RootSelection;
      readonly auth?: Auth;
      readonly rootSelector?: RootSelector;
    } = {},
  ) {
    this.application = compileRuntimeApplication(declaration);
    this.name = declaration.name;
    this.version = options.version ?? PACKAGE_VERSION;
    this.selection = (options.selection ?? RootSelection.all()).resolve(this.application.index);
    this.auth = options.auth;
    this.rootSelector = options.rootSelector;
    Object.freeze(this);
  }

  /** Build a fresh official-SDK adapter for one transport connection or HTTP service. */
  build(): ContextureMcpServer {
    if (this.#built === undefined) this.#built = this.buildForSelection(this.selection);
    return this.#built;
  }

  /** Build one fresh adapter whose complete public surface is fixed by selection. */
  private buildForSelection(selection: RootSelection): ContextureMcpServer {
    return createContextureMcpServer(
      { name: this.name, version: this.version },
      new Gateway(this.application.disclosure, this.application.runtime),
      this.application.publications,
      { selection },
    );
  }

  /** Start stdio until its host disconnects, or return a closeable HTTP listener. */
  async start(
    options: ContextureOptions = new ContextureOptions(),
  ): Promise<HttpServerHandle | undefined> {
    return options.transport === 'stdio' ? this.serveStdio() : this.listenHttp(options);
  }

  private async serveStdio(): Promise<undefined> {
    await this.application.runtime.serve(async () => {
      const transport = new StdioServerTransport();
      const completion = transportCompletion(transport);
      await this.build().server.connect(transport);
      await completion;
    });
    return undefined;
  }

  private async listenHttp(options: ContextureOptions): Promise<HttpServerHandle> {
    let stop: (() => void) | undefined;
    let started: ((handle: HttpServerHandle) => void) | undefined;
    let failed: ((error: unknown) => void) | undefined;
    const ready = new Promise<HttpServerHandle>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    void this.application.runtime
      .serve(async () => {
        const handler = createMcpHandler(
          (context) => this.buildForSelection(this.selectionForRequest(context)).server,
          {
            responseMode: 'json',
          },
        );
        const gate = this.auth?.gate();
        const node = createServer(async (request, response) => {
          try {
            if (new URL(request.url ?? '/', options.url).pathname !== options.resolvedPath) {
              response.writeHead(404).end('Not Found');
              return;
            }
            const webRequest = nodeRequest(request, options);
            const rejected =
              (options.allowedHosts.length === 0
                ? undefined
                : hostHeaderValidationResponse(webRequest, [...options.allowedHosts])) ??
              (options.allowedOrigins.length === 0
                ? undefined
                : originValidationResponse(webRequest, [...options.allowedOrigins]));
            if (rejected !== undefined) {
              await writeResponse(response, rejected);
              return;
            }
            const authInfo = gate === undefined ? undefined : await gate(webRequest);
            if (authInfo instanceof Response) {
              await writeResponse(response, authInfo);
              return;
            }
            await writeResponse(
              response,
              await handler.fetch(webRequest, authInfo === undefined ? {} : { authInfo }),
            );
          } catch (error) {
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(
              error instanceof Error ? error.message : 'Contexture HTTP request failed.',
            );
          }
        });
        try {
          await listen(node, options.resolvedHost, options.resolvedPort);
        } catch (error) {
          await handler.close();
          throw error;
        }
        const address = node.address();
        if (address === null || typeof address === 'string')
          throw new Error('HTTP server did not expose a TCP address.');
        const handle: HttpServerHandle = Object.freeze({
          url: `http://${options.resolvedHost}:${address.port}${options.resolvedPath}`,
          close: async () => {
            await close(node);
            stop?.();
          },
        });
        started?.(handle);
        await stopped;
        await handler.close();
      })
      .catch((error: unknown) => failed?.(error));
    return ready;
  }

  /** Resolve the request-local root surface only for HTTP factory instances. */
  private selectionForRequest(context: McpRequestContext): RootSelection {
    if (this.rootSelector === undefined || context.requestInfo === undefined) return this.selection;
    return this.rootSelector.select(
      this.application.index,
      Object.fromEntries(context.requestInfo.headers.entries()),
      principalOf(context.authInfo),
    );
  }
}

/** Compile one declaration into its server-owned application container. */
export function buildServer(
  declaration: ApplicationDeclaration,
  options: {
    readonly version?: string;
    readonly selection?: RootSelection;
    readonly auth?: Auth;
    readonly rootSelector?: RootSelector;
  } = {},
): ContextureServer {
  return new ContextureServer(declaration, options);
}

function transportCompletion(transport: StdioServerTransport): Promise<void> {
  return new Promise((resolve, reject) => {
    transport.onclose = resolve;
    transport.onerror = reject;
  });
}

function nodeRequest(request: IncomingMessage, options: ContextureOptions): Request {
  const url = new URL(request.url ?? '/', options.url);
  const method = request.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(request) as ReadableStream,
    duplex: 'half',
  } as RequestInit);
}

async function writeResponse(response: ServerResponse, source: Response): Promise<void> {
  response.writeHead(source.status, Object.fromEntries(source.headers));
  if (source.body === null) {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(source.body as import('node:stream/web').ReadableStream)
      .on('error', reject)
      .on('end', resolve)
      .pipe(response);
  });
}

function listen(server: NodeServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: NodeServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
