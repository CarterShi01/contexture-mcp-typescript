import {
  createServer,
  type IncomingMessage,
  type Server as NodeServer,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';

import type { ToolCallContext } from '../core/index.js';
import {
  ApplicationRuntime,
  InputValidationError,
  ModelValidationError,
  Principal,
  RootSelection,
} from '../core/index.js';
import type { RestMethod, RestRoute } from './route.js';

const METHODS = new Set<RestMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Protocol facts an authenticator may inspect, without a Controller reference. */
export interface WebRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, readonly string[]>>;
}

/** Authenticate one REST request before Contexture invokes its Tool. */
export type Authenticator = (
  request: WebRequest,
) => Principal | undefined | Promise<Principal | undefined>;

/** A live Node HTTP REST listener that its caller may close. */
export interface RestServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/** Options for RestSurface.listen; `port: 0` selects an available local port. */
export interface RestListenOptions {
  readonly host?: string;
  readonly port?: number;
}

/** Validated allowlist over the same Binding used by the Contexture gateway. */
export class RestRouter {
  readonly #routes: ReadonlyMap<string, RestRoute>;

  constructor(
    readonly runtime: ApplicationRuntime,
    routes: readonly RestRoute[],
  ) {
    this.#routes = validateRoutes(runtime, routes);
    Object.freeze(this);
  }

  get routes(): readonly RestRoute[] {
    return Object.freeze([...this.#routes.values()]);
  }

  async handle(
    method: string,
    path: string,
    arguments_: unknown = undefined,
    context: ToolCallContext = {},
    selection: RootSelection = RootSelection.all(),
  ): Promise<unknown> {
    const route = routeFor(this.#routes, method, path);
    if (route === undefined)
      throw new ModelValidationError('No Contexture REST route matches this method and path.');
    return isReadMethod(route.method)
      ? this.runtime.invokeReadOnly(route.ref, arguments_, context, selection)
      : this.runtime.invoke(route.ref, arguments_, context, selection);
  }
}

/**
 * A real HTTP-facing allowlist over the same Binding used by the MCP gateway.
 *
 * `fetch()` is mountable in Fetch-compatible hosts. `listen()` is the small
 * built-in Node adapter and opens Channels for exactly the listener lifetime.
 */
export class RestSurface {
  readonly #routes: ReadonlyMap<string, RestRoute>;
  readonly maxBodyBytes: number;

  constructor(
    readonly runtime: ApplicationRuntime,
    routes: readonly RestRoute[],
    readonly authenticate: Authenticator | undefined = undefined,
    options: { readonly maxBodyBytes?: number } = {},
  ) {
    if (
      !Number.isSafeInteger(options.maxBodyBytes ?? 1024 * 1024) ||
      (options.maxBodyBytes ?? 1024 * 1024) < 1
    ) {
      throw new RangeError('RestSurface maxBodyBytes must be a positive integer.');
    }
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.#routes = validateRoutes(runtime, routes);
    Object.freeze(this);
  }

  get routes(): readonly RestRoute[] {
    return Object.freeze([...this.#routes.values()]);
  }

  /** Open application Channels around one externally owned serving lifetime. */
  async serve<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.runtime.serve(operation);
  }

  /** Handle exactly one standard Fetch request through the explicit route table. */
  async fetch(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    const path = new URL(request.url).pathname;
    const route = routeFor(this.#routes, method, path);
    if (route === undefined) {
      return problem(404, 'route-not-found', 'No REST route is published here.');
    }
    const webRequest = requestFacts(request, method, path);
    let principal: Principal | undefined;
    if (this.authenticate !== undefined) {
      try {
        principal = await this.authenticate(webRequest);
      } catch {
        return problem(
          500,
          'invalid-authenticator',
          'Authenticator failed to establish an identity.',
        );
      }
      if (principal === undefined) {
        return problem(401, 'unauthenticated', 'Authentication is required.');
      }
      if (!(principal instanceof Principal)) {
        return problem(500, 'invalid-authenticator', 'Authenticator returned an invalid identity.');
      }
    }
    try {
      const arguments_ = await requestArguments(request, route.method, this.maxBodyBytes);
      const context: ToolCallContext = Object.freeze({
        principal,
        host: webRequest,
        signal: request.signal,
      });
      const result = isReadMethod(route.method)
        ? await this.runtime.invokeReadOnly(route.ref, arguments_, context)
        : await this.runtime.invoke(route.ref, arguments_, context);
      return jsonResponse(route.status ?? 200, result, method === 'HEAD');
    } catch (error) {
      return responseForFailure(error);
    }
  }

  /** Start a Node HTTP listener and hold Channels open until `close()` resolves. */
  async listen(options: RestListenOptions = {}): Promise<RestServerHandle> {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new RangeError('RestSurface listen port must be an integer from 0 through 65535.');
    }
    let begin: ((handle: RestServerHandle) => void) | undefined;
    let fail: ((reason: unknown) => void) | undefined;
    const ready = new Promise<RestServerHandle>((resolve, reject) => {
      begin = resolve;
      fail = reject;
    });
    let stop: (() => void) | undefined;
    let closeListener: (() => Promise<void>) | undefined;
    const running = this.serve(async () => {
      const node = createServer(async (incoming, outgoing) => {
        try {
          await writeNodeResponse(outgoing, await this.fetch(nodeRequest(incoming, host, port)));
        } catch (error) {
          outgoing.writeHead(500, { 'content-type': 'application/problem+json; charset=utf-8' });
          outgoing.end(
            JSON.stringify({
              type: 'urn:contexture:problem:controller-failed',
              status: 500,
              title: 'controller failed',
              detail: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
      });
      await listenNode(node, host, port);
      const address = node.address();
      if (address === null || typeof address === 'string') {
        await closeNode(node);
        throw new Error('REST listener did not expose a TCP address.');
      }
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      let closed: Promise<void> | undefined;
      closeListener = (): Promise<void> => {
        if (closed === undefined) {
          closed = closeNode(node).then(() => stop?.());
        }
        return closed;
      };
      const originHost = address.address.includes(':') ? `[${address.address}]` : address.address;
      begin?.(
        Object.freeze({
          url: `http://${originHost}:${address.port}`,
          close: async () => {
            await closeListener?.();
            await running;
          },
        }),
      );
      await stopped;
    });
    void running.catch((error: unknown) => fail?.(error));
    return ready;
  }
}

function validateRoutes(
  runtime: ApplicationRuntime,
  routes: readonly RestRoute[],
): ReadonlyMap<string, RestRoute> {
  const registered = new Map<string, RestRoute>();
  for (const route of routes) {
    const normalized = normalizeRoute(route);
    const key = routeKey(normalized.method, normalized.path);
    if (registered.has(key)) {
      throw new ModelValidationError(`REST route ${key} is declared more than once.`);
    }
    let node;
    try {
      node = runtime.index.find(normalized.ref);
    } catch (error) {
      const reason = error instanceof Error ? ` (${error.message})` : '';
      throw new ModelValidationError(
        `REST route ${normalized.method} ${normalized.path} names no Tool: ${JSON.stringify(normalized.ref)}${reason}`,
      );
    }
    if (node.kind !== 'tool') {
      throw new ModelValidationError(
        `REST route ${normalized.method} ${normalized.path} names no Tool: ${JSON.stringify(normalized.ref)}.`,
      );
    }
    if (isReadMethod(normalized.method) !== node.readOnly) {
      const expected = node.readOnly ? 'GET/HEAD' : 'a writing method';
      throw new ModelValidationError(
        `REST route ${normalized.method} ${normalized.path} names ${JSON.stringify(normalized.ref)}; that Tool requires ${expected}.`,
      );
    }
    registered.set(key, normalized);
  }
  return registered;
}

function normalizeRoute(route: RestRoute): RestRoute {
  const method = String(route.method).toUpperCase().trim();
  const path = String(route.path).trim();
  const ref = String(route.ref).trim();
  if (!METHODS.has(method as RestMethod)) {
    throw new ModelValidationError(`REST method ${JSON.stringify(method)} is not supported.`);
  }
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('{')) {
    throw new ModelValidationError(
      `REST path ${JSON.stringify(path)} must be one fixed absolute path.`,
    );
  }
  if (path !== '/' && path.endsWith('/')) {
    throw new ModelValidationError(`REST path ${JSON.stringify(path)} must not end in '/'.`);
  }
  if (ref.length === 0) throw new ModelValidationError('A REST Route must name one Tool ref.');
  const status = route.status ?? 200;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new ModelValidationError('A REST Route status must be an HTTP status.');
  }
  return Object.freeze({ method: method as RestMethod, path, ref, status });
}

function routeFor(
  routes: ReadonlyMap<string, RestRoute>,
  method: string,
  path: string,
): RestRoute | undefined {
  return (
    routes.get(routeKey(method, path)) ??
    (method.toUpperCase() === 'HEAD' ? routes.get(routeKey('GET', path)) : undefined)
  );
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function requestFacts(request: Request, method: string, path: string): WebRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) headers[name.toLowerCase()] = value;
  const query: Record<string, readonly string[]> = {};
  for (const [name, value] of new URL(request.url).searchParams.entries()) {
    const values = query[name] ?? [];
    query[name] = Object.freeze([...values, value]);
  }
  return Object.freeze({
    method,
    path,
    headers: Object.freeze(headers),
    query: Object.freeze(query),
  });
}

async function requestArguments(
  request: Request,
  method: RestMethod,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  if (isReadMethod(method)) {
    const values: Record<string, string | readonly string[]> = {};
    for (const [name, value] of new URL(request.url).searchParams.entries()) {
      const current = values[name];
      values[name] =
        current === undefined
          ? value
          : Array.isArray(current)
            ? [...current, value]
            : [current, value];
    }
    return values;
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== undefined && contentType !== '' && contentType !== 'application/json') {
    throw new RequestFailure(
      415,
      'unsupported-media-type',
      'REST commands accept application/json.',
    );
  }
  const body = await readBody(request, maxBodyBytes);
  if (body.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new RequestFailure(400, 'invalid-json', 'Request body is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new RequestFailure(400, 'invalid-body', 'Request body must be a JSON object.');
  }
  return parsed;
}

/** Read incrementally so a hostile streaming request cannot bypass the body limit. */
async function readBody(request: Request, maxBodyBytes: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBodyBytes) {
        await reader.cancel();
        throw new RequestFailure(
          413,
          'body-too-large',
          'Request body exceeds the configured limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function responseForFailure(error: unknown): Response {
  if (error instanceof RequestFailure) return problem(error.status, error.kind, error.detail);
  if (error instanceof InputValidationError) {
    return problem(422, 'invalid-arguments', error.message);
  }
  if (error instanceof Error && error.name === 'PermissionError') {
    return problem(403, 'forbidden', error.message || 'Forbidden.');
  }
  if (error instanceof ModelValidationError) return problem(500, 'invalid-surface', error.message);
  if (error instanceof Error && error.name === 'ValueError') {
    return problem(422, 'rejected', error.message);
  }
  return problem(500, 'controller-failed', error instanceof Error ? error.name : 'UnknownError');
}

function jsonResponse(status: number, value: unknown, head: boolean): Response {
  let text: string;
  try {
    text = JSON.stringify(value, jsonReplacer) ?? 'null';
  } catch (error) {
    return responseForFailure(error);
  }
  const body = new TextEncoder().encode(text);
  return new Response(head ? null : body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function problem(status: number, kind: string, detail: string): Response {
  const text = JSON.stringify({
    type: `urn:contexture:problem:${kind}`,
    status,
    title: kind.replaceAll('-', ' '),
    detail,
  });
  const body = new TextEncoder().encode(text);
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'content-type': 'application/problem+json; charset=utf-8',
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeRequest(request: IncomingMessage, host: string, port: number): Request {
  const originHost = host.includes(':') ? `[${host}]` : host;
  const url = new URL(request.url ?? '/', `http://${originHost}:${port || 80}`);
  const method = request.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(request) as ReadableStream,
    duplex: 'half',
  } as RequestInit);
}

async function writeNodeResponse(target: ServerResponse, source: Response): Promise<void> {
  target.writeHead(source.status, Object.fromEntries(source.headers));
  if (source.body === null) {
    target.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(source.body as import('node:stream/web').ReadableStream)
      .on('error', reject)
      .on('end', resolve)
      .pipe(target);
  });
}

function listenNode(server: NodeServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeNode(server: NodeServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
