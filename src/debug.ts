import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { ModelValidationError } from './core/foundation/errors.js';
import { NodeCatalog } from './introspection.js';
import { formatCatalogJson } from './catalog-json.js';
import { DEBUG_ASSETS } from './debug-assets.js';

export interface DebugAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function loopback(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  if (isIP(host) === 4) return host.split('.')[0] === '127';
  if (isIP(host) === 6) return new URL(`http://[${host}]`).hostname === '[::1]';
  return false;
}

function trustedAuthority(authority: string): boolean {
  if (authority.includes('@') || authority.includes('/') || /\s/.test(authority)) return false;
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::([0-9]+))?$/.exec(authority);
  if (match === null || !loopback(match[1] ?? match[2]!)) return false;
  const port = match[3] === undefined ? 80 : Number(match[3]);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65535;
}

function trustedOrigin(origin: string, authority: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === 'http:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.host.toLowerCase() === authority.toLowerCase() &&
      trustedAuthority(parsed.host)
    );
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** Native loopback HTTP adapter over one immutable Catalog, never a Tool gateway. */
export class CatalogDebugServer {
  readonly #payload: Buffer;
  readonly #nodes: ReadonlyMap<string, Buffer>;
  readonly #assets: ReadonlyMap<string, { readonly payload: Buffer; readonly contentType: string }>;
  readonly #etag: string;
  #active = false;

  constructor(readonly catalog: NodeCatalog) {
    if (!(catalog instanceof NodeCatalog))
      throw new ModelValidationError('Constructed Node Catalog required.');
    const snapshot = catalog.snapshot();
    this.#payload = Buffer.from(snapshot.toJson(null));
    this.#etag = `"${snapshot.contentDigest}"`;
    this.#nodes = new Map(
      snapshot.nodes.map((node) => [
        node.ref,
        Buffer.from(formatCatalogJson(node, { spaced: true })),
      ]),
    );
    this.#assets = new Map(
      Object.entries(DEBUG_ASSETS).map(([path, value]) => [
        path,
        { payload: Buffer.from(value.body), contentType: value.contentType },
      ]),
    );
    Object.freeze(this);
  }

  async start(
    options: { readonly host?: string; readonly port?: number } = {},
  ): Promise<DebugAddress> {
    const host = options.host === undefined ? '127.0.0.1' : options.host;
    const port = options.port === undefined ? 0 : options.port;
    if (typeof host !== 'string' || !loopback(host))
      throw new ModelValidationError('Catalog debug HTTP is loopback-only.');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
      throw new ModelValidationError('Debug port must be between zero and 65535.');
    if (this.#active) throw new ModelValidationError('Catalog debug server is already active.');
    this.#active = true;
    const server = createServer((request, response) => this.#request(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          server.off('listening', ready);
          reject(error);
        };
        const ready = () => {
          server.off('error', failed);
          resolve();
        };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(port, host);
      });
    } catch (error) {
      this.#active = false;
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      this.#active = false;
      throw new ModelValidationError('Catalog debug requires a TCP loopback address.');
    }
    let closing: Promise<void> | undefined;
    return Object.freeze({
      host: address.address,
      port: address.port,
      url: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
      close: () => {
        if (closing === undefined)
          closing = new Promise<void>((resolve, reject) => {
            server.close((error) => {
              this.#active = false;
              if (error !== undefined) reject(error);
              else resolve();
            });
            server.closeAllConnections();
          });
        return closing;
      },
    });
  }

  #request(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader('Cache-Control', 'no-cache');
    const head = request.method === 'HEAD';
    const send = (
      status: number,
      payload: Buffer,
      contentType = 'application/json; charset=utf-8',
    ) => {
      response.statusCode = status;
      response.setHeader('Content-Type', contentType);
      response.setHeader('Content-Length', payload.length);
      response.end(head ? undefined : payload);
    };
    const error = (status: number, message: string) =>
      send(status, Buffer.from(formatCatalogJson({ error: message })));
    const authority = request.headers.host;
    const hostCount = request.rawHeaders.filter(
      (_, index, values) => index % 2 === 0 && values[index]!.toLowerCase() === 'host',
    ).length;
    if (authority === undefined || hostCount !== 1 || !trustedAuthority(authority)) {
      error(400, 'Untrusted Host header.');
      return;
    }
    const origin = request.headers.origin;
    const originCount = request.rawHeaders.filter(
      (_, index, values) => index % 2 === 0 && values[index]!.toLowerCase() === 'origin',
    ).length;
    if (origin !== undefined && (originCount !== 1 || !trustedOrigin(origin, authority))) {
      error(403, 'Cross-origin request refused.');
      return;
    }
    if (request.method !== 'GET' && !head) {
      error(405, 'Read-only endpoint.');
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${authority}`).pathname;
    } catch (failure) {
      if (failure instanceof TypeError) {
        error(400, 'Invalid request URL.');
        return;
      }
      throw failure;
    }
    if (head && pathname !== '/api/catalog') {
      error(404, 'Not found.');
      return;
    }
    const asset = this.#assets.get(pathname);
    if (asset !== undefined) {
      send(200, asset.payload, asset.contentType);
      return;
    }
    if (pathname === '/healthz') {
      send(200, Buffer.from('{"status":"ok"}'));
      return;
    }
    let payload: Buffer | undefined;
    if (pathname === '/api/catalog') payload = this.#payload;
    else if (pathname.startsWith('/api/nodes/')) {
      try {
        payload = this.#nodes.get(decodeURIComponent(pathname.slice('/api/nodes/'.length)));
      } catch (failure) {
        if (failure instanceof URIError) {
          error(400, 'Invalid catalog ref encoding.');
          return;
        }
        throw failure;
      }
      if (payload === undefined) {
        error(404, 'Unknown catalog ref.');
        return;
      }
    }
    if (payload === undefined) {
      error(404, 'Not found.');
      return;
    }
    response.setHeader('ETag', this.#etag);
    if (request.headers['if-none-match'] === this.#etag) {
      response.statusCode = 304;
      response.end();
      return;
    }
    send(200, payload);
  }
}
