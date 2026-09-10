import {
  createServer,
  type IncomingMessage,
  type Server as NodeServer,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { ApplicationCompilation } from '../core/model/compiler.js';
import { Gateway } from '../core/model/system-api.js';
import { RootSelection, SurfaceSelectionError } from '../core/model/root-selection.js';
import { PACKAGE_VERSION } from '../core/foundation/vocabulary.js';

import { compileRuntimeApplication, type RuntimeApplication } from './application.js';
import { createContextureMcpServer, type ContextureMcpServer } from './index.js';
import { buildInstructions } from './instructions.js';
import { ContextureOptions, ServeError, validateBoundHost, validateHttpAccess } from './options.js';
import { configureLogging, log } from './logging.js';
import { Auth, principalOf } from './identity.js';
import type { RootSelector, SurfaceSelector } from './root-selector.js';

export { PACKAGE_VERSION } from '../core/foundation/vocabulary.js';

/** A live streamable-HTTP Contexture server that its caller may close. */
export interface HttpServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/** One compiled application and its transport-specific MCP assembly. */
export class ContextureServer {
  #built: ContextureMcpServer | undefined;
  readonly #requestSelections = new WeakMap<Request, RootSelection>();
  readonly application: RuntimeApplication;
  readonly name: string;
  readonly version: string;
  readonly selection: RootSelection;
  readonly auth: Auth | undefined;
  readonly instructions: string | undefined;
  readonly surfaceSelector: SurfaceSelector | undefined;
  readonly rootSelector: RootSelector | undefined;

  constructor(
    declaration: ApplicationCompilation,
    options: {
      readonly version?: string;
      readonly selection?: RootSelection;
      readonly auth?: Auth;
      readonly instructions?: string;
      readonly surfaceSelector?: SurfaceSelector;
      readonly rootSelector?: RootSelector;
    } = {},
  ) {
    this.application = compileRuntimeApplication(declaration);
    this.name = this.application.index.name;
    this.version = options.version ?? PACKAGE_VERSION;
    this.selection = (options.selection ?? RootSelection.all()).resolve(this.application.index);
    this.auth = options.auth;
    this.instructions = options.instructions;
    if (options.surfaceSelector !== undefined && options.rootSelector !== undefined) {
      throw new ServeError('State surfaceSelector or legacy rootSelector, not both.');
    }
    this.surfaceSelector = options.surfaceSelector ?? options.rootSelector;
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
      {
        selection,
        instructions:
          this.instructions ?? buildInstructions(this.application.disclosure.select(selection)),
      },
    );
  }

  /** Start stdio until its host disconnects, or return a closeable HTTP listener. */
  async start(
    options: ContextureOptions = new ContextureOptions(),
  ): Promise<HttpServerHandle | undefined> {
    configureLogging(options.logLevel);
    if (options.auth !== undefined && this.auth !== undefined) {
      throw new ServeError(
        'State HTTP auth in ContextureOptions or buildServer options, not both.',
      );
    }
    if (options.transport === 'stdio') {
      if (this.auth !== undefined || this.surfaceSelector !== undefined)
        throw new ServeError('stdio cannot use HTTP identity or surface selection.');
      return this.serveStdio();
    }
    const httpOptions = withLegacyAuth(options, this.auth);
    validateHttpAccess(httpOptions);
    return this.listenHttp(httpOptions);
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
    const serving = this.application.runtime.serve(async () => {
      const handler = createMcpHandler(
        (context) => this.buildForSelection(this.selectionForRequest(context)).server,
        {
          responseMode: 'json',
        },
      );
      const gate = options.auth?.gate();
      const activeRequests = new Set<Promise<void>>();
      const requestControllers = new Map<Promise<void>, AbortController>();
      const serveRequest = async (
        request: IncomingMessage,
        response: ServerResponse,
        signal: AbortSignal,
      ): Promise<void> => {
        try {
          const webRequest = await nodeRequest(request, options, signal);
          const metadata = options.auth?.metadata(webRequest);
          if (metadata !== undefined) {
            await writeResponse(response, metadata);
            return;
          }
          if (new URL(request.url ?? '/', options.url).pathname !== options.resolvedPath) {
            response.writeHead(404).end('Not Found');
            return;
          }
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
          if (this.surfaceSelector !== undefined) {
            try {
              this.#requestSelections.set(
                webRequest,
                this.surfaceSelector.select(
                  this.application.index,
                  Object.fromEntries(webRequest.headers.entries()),
                  principalOf(authInfo),
                ),
              );
            } catch (error) {
              if (error instanceof SurfaceSelectionError) {
                await writeResponse(response, await invalidParamsResponse(webRequest, error));
                return;
              }
              throw error;
            }
          }
          await writeResponse(
            response,
            await handler.fetch(webRequest, authInfo === undefined ? {} : { authInfo }),
          );
        } catch (error) {
          if (response.destroyed || response.writableEnded) return;
          if (error instanceof RequestBodyTooLargeError) {
            response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(error.message);
            return;
          }
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(error instanceof Error ? error.message : 'Contexture HTTP request failed.');
        }
      };
      const node = createServer((request, response) => {
        const controller = new AbortController();
        const abort = () => {
          if (!response.writableFinished)
            controller.abort(new Error('HTTP request connection closed.'));
        };
        const socket = request.socket;
        request.once('aborted', abort);
        socket.once('close', abort);
        response.once('close', abort);
        response.once('error', abort);
        const active = serveRequest(request, response, controller.signal);
        activeRequests.add(active);
        requestControllers.set(active, controller);
        void active.then(
          () =>
            forgetRequest(
              active,
              request,
              response,
              socket,
              abort,
              activeRequests,
              requestControllers,
            ),
          (error: unknown) => {
            forgetRequest(
              active,
              request,
              response,
              socket,
              abort,
              activeRequests,
              requestControllers,
            );
            log(
              'error',
              error instanceof Error ? error.message : 'Contexture HTTP request failed.',
            );
          },
        );
      });
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = (): Promise<void> => {
        cleanupPromise ??= (async () => {
          const listenerClosing = node.listening ? close(node) : Promise.resolve();
          for (const controller of requestControllers.values()) {
            controller.abort(new Error('Contexture HTTP server is closing.'));
          }
          node.closeAllConnections();
          const [listenerResult, handlerResult] = await Promise.allSettled([
            listenerClosing,
            handler.close(),
          ]);
          await settleActiveRequests(activeRequests);
          await this.application.runtime.waitForIdle();
          if (listenerResult.status === 'rejected') throw listenerResult.reason;
          if (handlerResult.status === 'rejected') throw handlerResult.reason;
        })();
        return cleanupPromise;
      };
      try {
        try {
          await listen(node, tcpBindHost(options.resolvedHost), options.resolvedPort);
        } catch (error) {
          if (isNameResolutionError(error)) {
            throw new ServeError(
              `Could not resolve ContextureOptions host ${JSON.stringify(options.resolvedHost)}.`,
              { cause: error },
            );
          }
          throw error;
        }
        const address = node.address();
        if (address === null || typeof address === 'string')
          throw new ServeError('HTTP server did not expose a TCP address.');
        await validateBoundHost(options, address.address);
        const handle: HttpServerHandle = Object.freeze({
          url: `http://${formatUrlHost(options.resolvedHost)}:${address.port}${options.resolvedPath}`,
          close: async () => {
            stop?.();
            await serving;
          },
        });
        log('info', `Serving MCP on ${handle.url}`);
        started?.(handle);
        await stopped;
      } finally {
        await cleanup();
      }
    });
    void serving.catch((error: unknown) => failed?.(error));
    return ready;
  }

  /** Resolve the request-local selected surface only for HTTP factory instances. */
  private selectionForRequest(context: McpRequestContext): RootSelection {
    if (this.surfaceSelector === undefined || context.requestInfo === undefined)
      return this.selection;
    const selected = this.#requestSelections.get(context.requestInfo);
    if (selected !== undefined) {
      this.#requestSelections.delete(context.requestInfo);
      return selected;
    }
    return this.surfaceSelector.select(
      this.application.index,
      Object.fromEntries(context.requestInfo.headers.entries()),
      principalOf(context.authInfo),
    );
  }
}

/** Compile one declaration into its server-owned application container. */
export function buildServer(
  declaration: ApplicationCompilation,
  options: {
    readonly version?: string;
    readonly selection?: RootSelection;
    readonly auth?: Auth;
    readonly instructions?: string;
    readonly surfaceSelector?: SurfaceSelector;
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

async function nodeRequest(
  request: IncomingMessage,
  options: ContextureOptions,
  signal: AbortSignal,
): Promise<Request> {
  const url = new URL(request.url ?? '/', options.url);
  const method = request.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (options.maxRequestBodyBytes !== undefined) {
    const bytes = await boundedBody(request, options.maxRequestBodyBytes);
    if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers, signal });
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Request(url, { method, headers, body, signal });
  }
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers, signal });
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(request) as ReadableStream,
    duplex: 'half',
    signal,
  } as RequestInit);
}

class RequestBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds the configured ${limit}-byte limit.`);
  }
}

async function invalidParamsResponse(
  request: Request,
  error: SurfaceSelectionError,
): Promise<Response> {
  let id: string | number | null = null;
  try {
    const body = (await request.clone().json()) as { readonly id?: unknown };
    if (typeof body.id === 'string' || typeof body.id === 'number' || body.id === null) {
      id = body.id;
    }
  } catch {
    // Malformed JSON remains attributable only to the request as a whole.
  }
  return Response.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32602, message: error.message },
  });
}

async function boundedBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) {
    request.resume();
    throw new RequestBodyTooLargeError(limit);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > limit) {
      request.resume();
      throw new RequestBodyTooLargeError(limit);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function writeResponse(response: ServerResponse, source: Response): Promise<void> {
  response.writeHead(source.status, Object.fromEntries(source.headers));
  if (source.body === null) {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(source.body as import('node:stream/web').ReadableStream);
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      body.off('error', fail);
      response.off('error', fail);
      response.off('finish', succeed);
      response.off('close', closed);
      if (error !== undefined) {
        if (!body.destroyed) body.destroy();
        if (!response.destroyed) response.destroy();
        reject(error);
      } else {
        resolve();
      }
    };
    const fail = (error: unknown): void => finish(error);
    const succeed = (): void => finish();
    const closed = (): void => {
      if (response.writableFinished) succeed();
      else fail(new Error('HTTP response connection closed before completion.'));
    };
    body.once('error', fail);
    response.once('error', fail);
    response.once('finish', succeed);
    response.once('close', closed);
    body.pipe(response);
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

function withLegacyAuth(options: ContextureOptions, auth: Auth | undefined): ContextureOptions {
  if (auth === undefined) return options;
  return new ContextureOptions({
    transport: options.transport,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.path === undefined ? {} : { path: options.path }),
    auth,
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    allowAnonymous: options.allowAnonymous,
    logLevel: options.logLevel,
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });
}

function formatUrlHost(host: string): string {
  return host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host;
}

function tcpBindHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isNameResolutionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'].includes(String(error.code));
}

function forgetRequest(
  active: Promise<void>,
  request: IncomingMessage,
  response: ServerResponse,
  socket: Socket,
  abort: () => void,
  activeRequests: Set<Promise<void>>,
  requestControllers: Map<Promise<void>, AbortController>,
): void {
  request.off('aborted', abort);
  socket.off('close', abort);
  response.off('close', abort);
  response.off('error', abort);
  activeRequests.delete(active);
  requestControllers.delete(active);
}

async function settleActiveRequests(activeRequests: ReadonlySet<Promise<void>>): Promise<void> {
  while (activeRequests.size > 0) await Promise.allSettled([...activeRequests]);
}
