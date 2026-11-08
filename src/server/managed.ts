/**
 * Opt-in native Host candidate. No accepted managed wire revision or permissive
 * identity/approval policy is supplied; the legacy server remains independent.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server as NodeServer, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { GraphError, freezeJSON } from '../core/graph/canonical.js';
import type { FrozenJSON } from '../core/graph/canonical.js';
import type { JSONObject } from '../core/graph/model.js';
import { ManagedRuntime } from '../application/managed-runtime.js';
import type { ManagedRequest, ManagedRequestOptions } from '../application/managed-runtime.js';
import { RunLeaseService } from '../application/managed-run-leases.js';
import type { RunLeaseContext } from '../application/managed-run-leases.js';
import type {
  HttpServerHandle,
  McpConnectionLifecycle,
  ServerIdentity,
  StdioTransportLifecycle,
} from './host-lifecycle.js';
export type {
  HttpServerHandle,
  McpConnectionLifecycle,
  ServerIdentity,
  StdioTransportLifecycle,
} from './host-lifecycle.js';

export const MANAGED_HOST_PROFILE = 'contexture.native-host-candidate/v1';
export const MANAGED_PROFILE_META = 'contexture/profile';
export const MANAGED_REFERENCE_META = 'contexture/reference';
export const MANAGED_PROFILE_HEADER = 'contexture-managed-profile';
export const MANAGED_REFERENCE_HEADER = 'contexture-reference';
export const MANAGED_RUN_HEADER = 'contexture-run';

export interface ManagedHostInput {
  readonly transport: 'http' | 'stdio' | 'rest';
  readonly request?: Request;
  readonly signal: AbortSignal;
}

export interface ManagedHostScope {
  readonly selection?: readonly string[];
  readonly publicationSelection?: readonly string[];
}

export interface ManagedTransportHost {
  /**
   * Authenticate and bind the actual CURRENT runtime identity/authority context
   * (e.g. AsyncLocalStorage), then dispatch exactly once in that context. Never
   * deserialize identity, approval or a run context from business JSON.
   */
  enter<T>(input: ManagedHostInput, dispatch: (scope: ManagedHostScope) => Promise<T>): Promise<T>;
}

export type ManagedRunCarrier =
  | Readonly<{
      kind: 'channel';
      /** Protected trusted connection/server configuration, not request metadata. */
      current(): RunLeaseContext | undefined;
    }>
  | Readonly<{
      kind: 'header';
      /** Independently authenticate/approve the exact token on EVERY request. */
      approve(token: string, input: ManagedHostInput): Promise<RunLeaseContext>;
    }>;

export interface ManagedHostOptions {
  readonly identity: ServerIdentity;
  readonly runtime: ManagedRuntime;
  readonly host: ManagedTransportHost;
  readonly runs?: Readonly<{ service: RunLeaseService; carrier: ManagedRunCarrier }>;
  readonly mcpPath?: string;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  /** No reserved REST gateway paths are invented: mount every desired operation explicitly. */
  readonly navigation?: readonly ManagedNavigationMount[];
}

export type ManagedNavigationOperation =
  | 'routes'
  | 'inspect'
  | 'open'
  | 'members'
  | 'uses'
  | 'invoke'
  | 'invoke_read_only'
  | 'prompts'
  | 'resources'
  | 'prompt.get'
  | 'resource.read';
export interface ManagedNavigationMount {
  readonly path: string;
  readonly operation: ManagedNavigationOperation;
}

const invokeSchema = z.strictObject({
  ref: z.string(),
  arguments: z.record(z.string(), z.unknown()).nullable().optional(),
});
const inspectSchema = z.strictObject({ refs: z.array(z.string()).min(1).max(1000) });
const openSchema = z.strictObject({ ref: z.string() });
const emptySchema = z.strictObject({});
const toolDefinitions: Tool[] = [
  {
    name: 'contexture_discover',
    description: 'List CURRENT authorized routes in one pinned managed generation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'contexture_inspect',
    description: 'Inspect generation-qualified references in one pinned managed generation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1000 },
      },
      required: ['refs'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'contexture_open',
    description: 'Open one authorized Role or Skill; never execute it.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  ...(['contexture_invoke_read_only', 'contexture_invoke'] as const).map((name) => ({
    name,
    description: 'Invoke only the exact pinned native binding after CURRENT authorization.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref: { type: 'string' }, arguments: { type: ['object', 'null'] } },
      required: ['ref'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: name === 'contexture_invoke_read_only' },
  })),
];

function invalid(): never {
  throw new GraphError('schema_invalid', 'Invalid managed Host request');
}

function reference(value: unknown): string {
  if (typeof value !== 'string' || !value) invalid();
  return value;
}

function failure(error: unknown, signal?: AbortSignal): ProtocolError {
  if (signal?.aborted)
    return new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Managed request cancelled');
  if (error instanceof GraphError)
    return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Managed request refused', {
      code: error.code,
    });
  if (error instanceof z.ZodError)
    return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid managed arguments');
  return new ProtocolError(ProtocolErrorCode.InternalError, 'Managed Host operation failed');
}

/**
 * Runs, coordinator and durable owners stay under caller custody. close() joins
 * this adapter's requests/connections only; shut it down before its runtime owners.
 */
export class ManagedHostAdapter {
  readonly #runtime: ManagedRuntime;
  readonly #host: ManagedTransportHost;
  readonly #options: ManagedHostOptions;
  readonly #http: ReturnType<typeof createMcpHandler>;
  readonly #active = new Set<Promise<unknown>>();
  readonly #controllers = new Set<AbortController>();
  readonly #connections = new Set<McpServer>();
  readonly #listeners = new Set<NodeServer>();
  readonly #sockets = new Set<Socket>();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: ManagedHostOptions) {
    this.#runtime = options.runtime;
    this.#host = Object.freeze({ enter: options.host.enter.bind(options.host) });
    this.#options = Object.freeze({
      ...options,
      identity: Object.freeze({ ...options.identity }),
      ...(options.navigation === undefined
        ? {}
        : {
            navigation: Object.freeze(
              options.navigation.map((mount) => Object.freeze({ ...mount })),
            ),
          }),
      ...(options.runs === undefined
        ? {}
        : {
            runs: Object.freeze({
              service: options.runs.service,
              carrier: Object.freeze(
                options.runs.carrier.kind === 'channel'
                  ? {
                      kind: 'channel' as const,
                      current: options.runs.carrier.current.bind(options.runs.carrier),
                    }
                  : {
                      kind: 'header' as const,
                      approve: options.runs.carrier.approve.bind(options.runs.carrier),
                    },
              ),
            }),
          }),
    });
    if (
      !(options.runtime instanceof ManagedRuntime) ||
      (options.runs !== undefined &&
        (!(options.runs.service instanceof RunLeaseService) ||
          !options.runs.service.isFor(options.runtime) ||
          !['channel', 'header'].includes(options.runs.carrier.kind))) ||
      !/^\/[^?#]*$/u.test(options.mcpPath ?? '/mcp') ||
      [options.maxBodyBytes ?? 1_048_576, options.maxResponseBytes ?? 8_388_608].some(
        (n) => !Number.isSafeInteger(n) || n < 1,
      )
    )
      throw new TypeError('Explicit valid managed Host options are required');
    const mounts = options.navigation ?? [];
    if (
      new Set(mounts.map((m) => m.path)).size !== mounts.length ||
      mounts.some(
        (m) =>
          !/^\/[^?#]*$/u.test(m.path) ||
          m.path === (options.mcpPath ?? '/mcp') ||
          ![
            'routes',
            'inspect',
            'open',
            'members',
            'uses',
            'invoke',
            'invoke_read_only',
            'prompts',
            'resources',
            'prompt.get',
            'resource.read',
          ].includes(m.operation),
      )
    )
      throw new TypeError('Explicit unique managed navigation mounts are required');
    this.#http = createMcpHandler(
      (context) => {
        if (context.requestInfo === undefined) invalid();
        return this.build({ transport: 'http', request: context.requestInfo }).server;
      },
      { responseMode: 'json' },
    );
  }

  private async request<T>(
    input: ManagedHostInput,
    action: (request: ManagedRequest) => T | Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new GraphError('not_ready', 'Managed Host closed');
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const bound = Object.freeze({ ...input, signal });
    this.#controllers.add(controller);
    const executeScope = async (scope: ManagedHostScope): Promise<T> => {
      signal.throwIfAborted();
      if (this.#closed) throw new GraphError('not_ready', 'Managed Host closed');
      const options: ManagedRequestOptions = {
        ...(scope.selection === undefined
          ? {}
          : { selection: Object.freeze([...scope.selection]) }),
        ...(scope.publicationSelection === undefined
          ? {}
          : { publicationSelection: Object.freeze([...scope.publicationSelection]) }),
        signal,
      };
      const token = input.request?.headers.get(MANAGED_RUN_HEADER);
      const runs = this.#options.runs;
      if (
        token !== undefined &&
        token !== null &&
        (runs === undefined || runs.carrier.kind !== 'header')
      )
        invalid();
      let run: RunLeaseContext | undefined;
      if (runs?.carrier.kind === 'channel') run = runs.carrier.current();
      else if (runs?.carrier.kind === 'header' && token !== undefined && token !== null) {
        if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) invalid();
        run = await runs.carrier.approve(token, bound);
        if (run === undefined) invalid();
      }
      const execute = async (request: ManagedRequest): Promise<T> => {
        if (run !== undefined) request.attenuate(options);
        const result = await action(request);
        await request.validateReturn();
        const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
        if (bytes > (this.#options.maxResponseBytes ?? 8_388_608))
          throw new GraphError('too_large', 'Managed response exceeds Host budget');
        return result;
      };
      return run === undefined
        ? this.#runtime.request(execute, options)
        : runs!.service.request(run, execute, signal);
    };
    let entered = 0;
    let completed = false;
    let task: Promise<T> | undefined;
    const operation = Promise.resolve().then(async () => {
      try {
        const returned = await this.#host.enter(bound, (scope) => {
          if (completed || entered++ !== 0) invalid();
          task = executeScope(scope);
          return task;
        });
        completed = true;
        if (task === undefined || entered !== 1) invalid();
        const actual = await task;
        if (returned !== actual) invalid();
        return actual;
      } finally {
        completed = true;
        if (task !== undefined) await Promise.allSettled([task]);
      }
    });
    this.#active.add(operation);
    try {
      return await operation;
    } finally {
      this.#active.delete(operation);
      this.#controllers.delete(controller);
    }
  }

  private build(connection: Omit<ManagedHostInput, 'signal'>): McpServer {
    const server = new McpServer(this.#options.identity, {
      instructions:
        'Opt-in native managed Host candidate, not an accepted normative profile. ' +
        `Every operation requires ${MANAGED_PROFILE_META}=${MANAGED_HOST_PROFILE}; ` +
        `prompt/resource gets require the listed ${MANAGED_REFERENCE_META}.`,
    });
    server.server.registerCapabilities({
      tools: {},
      prompts: {},
      resources: {},
      completions: {},
      experimental: { [MANAGED_HOST_PROFILE]: {} },
    });
    const dispatch = async <T>(
      meta: Readonly<Record<string, unknown>> | undefined,
      signal: AbortSignal,
      action: (request: ManagedRequest) => T | Promise<T>,
    ): Promise<T> => {
      try {
        if (meta?.[MANAGED_PROFILE_META] !== MANAGED_HOST_PROFILE) invalid();
        if (
          connection.transport === 'http' &&
          connection.request?.headers.get(MANAGED_PROFILE_HEADER) !== MANAGED_HOST_PROFILE
        )
          invalid();
        if (Object.hasOwn(meta, MANAGED_RUN_HEADER)) invalid();
        return await this.request({ ...connection, signal }, action);
      } catch (error) {
        throw failure(error, signal);
      }
    };
    const meta = (request: ManagedRequest): { _meta: JSONObject } => ({
      _meta: { [MANAGED_HOST_PROFILE]: request.coordinates },
    });
    server.server.setRequestHandler('tools/list', (r, ctx) =>
      dispatch(r.params?._meta, ctx.mcpReq.signal, (request) => {
        if (r.params?.cursor !== undefined) invalid();
        return { tools: toolDefinitions, ...meta(request) };
      }),
    );
    server.server.setRequestHandler('tools/call', (r, ctx) =>
      dispatch(r.params._meta, ctx.mcpReq.signal, async (request) => {
        let value: FrozenJSON;
        switch (r.params.name) {
          case 'contexture_discover':
            emptySchema.parse(r.params.arguments ?? {});
            value = { routes: await request.routes() };
            break;
          case 'contexture_inspect': {
            const { refs } = inspectSchema.parse(r.params.arguments);
            const cards = [];
            for (const ref of [...new Set(refs)]) cards.push(await request.inspect(ref));
            value = { cards };
            break;
          }
          case 'contexture_open': {
            const { ref } = openSchema.parse(r.params.arguments);
            value = {
              owner_active: await request.open(ref),
              members: await request.relation(ref, 'members'),
              uses: await request.relation(ref, 'uses'),
            };
            break;
          }
          case 'contexture_invoke':
          case 'contexture_invoke_read_only': {
            const { ref, arguments: args } = invokeSchema.parse(r.params.arguments);
            value = {
              value: await request.invoke(ref, args ?? {}, {
                readOnly: r.params.name === 'contexture_invoke_read_only',
              }),
            };
            break;
          }
          default:
            invalid();
        }
        const output = { ...request.coordinates, ...value };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
          ...meta(request),
        };
      }),
    );
    server.server.setRequestHandler('prompts/list', (r, ctx) =>
      dispatch(r.params?._meta, ctx.mcpReq.signal, async (request) => {
        if (r.params?.cursor !== undefined) invalid();
        const publications = await request.listPublications('prompt');
        return {
          prompts: publications.map((p) => ({
            name: reference(p.name),
            description: reference(p.description),
            _meta: { [MANAGED_REFERENCE_META]: p.ref },
          })),
          ...meta(request),
        };
      }),
    );
    server.server.setRequestHandler('prompts/get', (r, ctx) =>
      dispatch(r.params._meta, ctx.mcpReq.signal, async (request) => {
        emptySchema.parse(r.params.arguments ?? {});
        const program = await request.prompt(
          r.params.name,
          reference(r.params._meta?.[MANAGED_REFERENCE_META]),
        );
        return {
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: JSON.stringify(program) },
            },
          ],
          ...meta(request),
        };
      }),
    );
    server.server.setRequestHandler('resources/list', (r, ctx) =>
      dispatch(r.params?._meta, ctx.mcpReq.signal, async (request) => {
        if (r.params?.cursor !== undefined) invalid();
        const publications = await request.listPublications('resource');
        return {
          resources: publications.map((p) => ({
            name: reference(p.name),
            uri: reference(p.uri),
            mimeType: reference(p.mime_type),
            _meta: { [MANAGED_REFERENCE_META]: p.ref },
          })),
          ...meta(request),
        };
      }),
    );
    server.server.setRequestHandler('resources/templates/list', (r, ctx) =>
      dispatch(r.params?._meta, ctx.mcpReq.signal, (request) => ({
        resourceTemplates: [],
        ...meta(request),
      })),
    );
    server.server.setRequestHandler('resources/read', (r, ctx) =>
      dispatch(r.params._meta, ctx.mcpReq.signal, async (request) => ({
        contents: [
          {
            uri: r.params.uri,
            text: await request.readResource(
              r.params.uri,
              reference(r.params._meta?.[MANAGED_REFERENCE_META]),
            ),
          },
        ],
        ...meta(request),
      })),
    );
    server.server.setRequestHandler('completion/complete', (r, ctx) =>
      dispatch(r.params._meta, ctx.mcpReq.signal, async (request) => {
        // No invented goto publication or argument grammar.
        await request.listPublications('prompt');
        return { completion: { values: [], total: 0, hasMore: false }, ...meta(request) };
      }),
    );
    return server;
  }

  /** Connect the real SDK transport, exposing only the connection's close lifecycle. */
  async connectStdio(
    transport: StdioTransportLifecycle = new StdioServerTransport(),
  ): Promise<McpConnectionLifecycle> {
    const server = await this.connectStdioServer(transport);
    return Object.freeze({ close: () => server.close() });
  }

  private async connectStdioServer(transport: StdioTransportLifecycle): Promise<McpServer> {
    if (this.#closed) throw new GraphError('not_ready', 'Managed Host closed');
    if (this.#options.runs?.carrier.kind === 'header')
      throw new TypeError('Header run carriers are HTTP-only');
    if (!(transport instanceof StdioServerTransport))
      throw new TypeError('Managed stdio requires the official SDK StdioServerTransport');
    const server = this.build({ transport: 'stdio' });
    this.#connections.add(server);
    server.server.onclose = () => this.#connections.delete(server);
    try {
      await server.connect(transport);
      return server;
    } catch (error) {
      this.#connections.delete(server);
      throw error;
    }
  }
  /** Run real process stdin/stdout until EOF or explicit adapter close, then drain. */
  async serveStdio(): Promise<void> {
    let finish: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    process.stdin.once('end', finish);
    try {
      const server = await this.connectStdioServer(new StdioServerTransport());
      const onclose = server.server.onclose;
      server.server.onclose = () => {
        onclose?.();
        finish();
      };
      await completion;
      await this.close();
    } finally {
      process.stdin.off('end', finish);
    }
  }

  /** Web-standard official SDK MCP face, or an exact published REST route. */
  async fetch(request: Request): Promise<Response> {
    try {
      if (this.#closed) throw new GraphError('not_ready', 'Managed Host closed');
      if (request.headers.get(MANAGED_PROFILE_HEADER) !== MANAGED_HOST_PROFILE) invalid();
      if (new URL(request.url).pathname === (this.#options.mcpPath ?? '/mcp')) {
        if (request.method === 'GET' || request.method === 'HEAD')
          return await this.#http.fetch(request);
        const bytes = await this.bodyBytes(request);
        const body = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(body).set(bytes);
        return await this.#http.fetch(new Request(request, { body }));
      }
      const path = new URL(request.url);
      if (path.search || path.hash) invalid();
      const input =
        request.method === 'GET' || request.method === 'HEAD' ? {} : await this.body(request);
      const mount = this.#options.navigation?.find((m) => m.path === path.pathname);
      const output: JSONObject = await this.request(
        { transport: 'rest', request, signal: request.signal },
        async (managed) => {
          if (mount !== undefined) {
            managed.assertHostMount(mount.path);
            const read = ['routes', 'prompts', 'resources'].includes(mount.operation);
            if (request.method !== (read ? 'GET' : 'POST')) invalid();
            return {
              ...managed.coordinates,
              value: await this.navigate(managed, mount.operation, input),
            };
          }
          return {
            ...managed.coordinates,
            value: await managed.route(
              request.method,
              path.pathname,
              reference(request.headers.get(MANAGED_REFERENCE_HEADER)),
              input,
            ),
          };
        },
      );
      const headers = {
        [MANAGED_PROFILE_HEADER]: MANAGED_HOST_PROFILE,
        'contexture-generation': reference(output.generation_uuid),
      };
      return request.method === 'HEAD'
        ? new Response(null, { headers })
        : Response.json(output, { headers });
    } catch (error) {
      const safe = failure(error, request.signal);
      return Response.json(
        { error: { code: safe.code, message: safe.message, data: safe.data } },
        { status: safe.code === ProtocolErrorCode.InternalError ? 500 : 400 },
      );
    }
  }
  private async navigate(
    managed: ManagedRequest,
    operation: ManagedNavigationOperation,
    input: unknown,
  ): Promise<FrozenJSON> {
    switch (operation) {
      case 'routes':
        emptySchema.parse(input);
        return { routes: await managed.routes() };
      case 'prompts':
        emptySchema.parse(input);
        return { prompts: await managed.listPublications('prompt') };
      case 'resources':
        emptySchema.parse(input);
        return { resources: await managed.listPublications('resource') };
      case 'inspect': {
        const { refs } = inspectSchema.parse(input);
        const cards: JSONObject[] = [];
        for (const ref of [...new Set(refs)]) cards.push(await managed.inspect(ref));
        return { cards };
      }
      case 'open': {
        const { ref } = openSchema.parse(input);
        return {
          owner_active: await managed.open(ref),
          members: await managed.relation(ref, 'members'),
          uses: await managed.relation(ref, 'uses'),
        };
      }
      case 'members':
      case 'uses': {
        const { ref } = openSchema.parse(input);
        return { [operation]: await managed.relation(ref, operation) };
      }
      case 'invoke':
      case 'invoke_read_only': {
        const { ref, arguments: args } = invokeSchema.parse(input);
        return {
          value: await managed.invoke(ref, args ?? {}, {
            readOnly: operation === 'invoke_read_only',
          }),
        };
      }
      case 'prompt.get': {
        const { name, ref } = z.strictObject({ name: z.string(), ref: z.string() }).parse(input);
        return managed.prompt(name, ref);
      }
      case 'resource.read': {
        const { uri, ref } = z.strictObject({ uri: z.string(), ref: z.string() }).parse(input);
        return { uri, text: await managed.readResource(uri, ref) };
      }
    }
  }

  private async body(request: Request): Promise<FrozenJSON> {
    const bytes = await this.bodyBytes(request);
    try {
      return freezeJSON(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) invalid();
      throw error;
    }
  }
  private async bodyBytes(request: Request): Promise<Uint8Array> {
    const limit = this.#options.maxBodyBytes ?? 1_048_576;
    if (Number(request.headers.get('content-length')) > limit)
      throw new GraphError('too_large', 'Host body too large');
    const reader = request.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        request.signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new GraphError('too_large', 'Host body too large');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  /** Concrete loopback-only native listener. External deployment needs its own Host listener. */
  async listen(
    options: {
      readonly port?: number;
      readonly allowedOrigins?: readonly string[];
    } = {},
  ): Promise<HttpServerHandle> {
    if (this.#closed) throw new GraphError('not_ready', 'Managed Host closed');
    const server = createServer((request, response) => {
      const operation = this.serveNode(request, response, options.allowedOrigins ?? []);
      this.#active.add(operation);
      void operation.then(
        () => this.#active.delete(operation),
        () => {
          this.#active.delete(operation);
          if (!response.destroyed) response.destroy();
        },
      );
    });
    server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this.#closed) {
      server.close();
      throw new GraphError('not_ready', 'Managed Host closed');
    }
    this.#listeners.add(server);
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing native listener');
    return {
      url: `http://127.0.0.1:${address.port}${this.#options.mcpPath ?? '/mcp'}`,
      close: () => this.close(),
    };
  }

  private async serveNode(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    origins: readonly string[],
  ): Promise<void> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const abort = (): void => controller.abort();
    incoming.once('aborted', abort);
    outgoing.once('close', abort);
    try {
      const address = incoming.socket.localPort;
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const key = incoming.rawHeaders[i]!;
        if (
          headers.has(key) &&
          [MANAGED_RUN_HEADER, MANAGED_PROFILE_HEADER, MANAGED_REFERENCE_HEADER].includes(
            key.toLowerCase(),
          )
        )
          invalid();
        headers.append(key, incoming.rawHeaders[i + 1]!);
      }
      const url = new URL(incoming.url ?? '/', `http://127.0.0.1:${address}`);
      const validationRequest = new Request(url, { headers });
      const rejected =
        hostHeaderValidationResponse(validationRequest, ['127.0.0.1']) ??
        (origins.length
          ? originValidationResponse(validationRequest, [...origins])
          : headers.has('origin')
            ? new Response('Origin not approved', { status: 403 })
            : undefined);
      let response: Response;
      if (rejected !== undefined) {
        incoming.resume();
        response = rejected;
      } else {
        const limit = this.#options.maxBodyBytes ?? 1_048_576;
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (Number(headers.get('content-length')) > limit) {
          incoming.resume();
          throw new GraphError('too_large', 'Host body too large');
        }
        for await (const data of incoming.iterator({ destroyOnReturn: false })) {
          const chunk: Uint8Array = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
          size += chunk.byteLength;
          if (size > limit) {
            incoming.resume();
            throw new GraphError('too_large', 'Host body too large');
          }
          chunks.push(chunk);
        }
        const request = new Request(url, {
          method: incoming.method ?? 'GET',
          headers,
          signal: controller.signal,
          ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET')
            ? {}
            : { body: Buffer.concat(chunks, size) }),
        });
        response = await this.fetch(request);
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body === null) outgoing.end();
      else {
        const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
        await new Promise<void>((resolve, reject) => {
          body.once('error', reject);
          outgoing.once('error', reject);
          outgoing.once('finish', resolve);
          outgoing.once('close', () => {
            if (!outgoing.writableFinished) reject(new Error('Response closed'));
          });
          body.pipe(outgoing);
        });
      }
    } catch (error) {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        const safe = failure(error, controller.signal);
        outgoing.writeHead(error instanceof GraphError && error.code === 'too_large' ? 413 : 400, {
          'content-type': 'application/json',
        });
        outgoing.end(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
      } else if (!outgoing.destroyed) outgoing.destroy();
    } finally {
      this.#controllers.delete(controller);
      incoming.off('aborted', abort);
      outgoing.off('close', abort);
    }
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#closing = (async () => {
      const listeners = [...this.#listeners].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
      );
      for (const socket of this.#sockets) socket.destroy();
      await this.#http.close();
      await Promise.all([...this.#connections].map((server) => server.close()));
      while (this.#active.size) await Promise.allSettled([...this.#active]);
      await Promise.all(listeners);
      this.#listeners.clear();
      this.#connections.clear();
    })();
    return this.#closing;
  }
}
