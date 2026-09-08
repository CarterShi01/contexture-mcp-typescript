import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ContextureError } from '../core/foundation/errors.js';
import { Auth } from './identity.js';
import { isLogLevel, type LogLevel } from './logging.js';

export type Transport = 'stdio' | 'streamable-http';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8000;
export const DEFAULT_PATH = '/mcp';
export const LOOPBACK = Object.freeze(new Set(['127.0.0.1', 'localhost', '::1', '[::1]']));

/** A request to serve a Contexture application cannot be honoured safely. */
export class ServeError extends ContextureError {
  override readonly name = 'ServeError';

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause });
  }
}

/** Validated transport policy shared by CLI and programmatic server startup. */
export class ContextureOptions {
  readonly transport: Transport;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly path: string | undefined;
  readonly auth: Auth | undefined;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowAnonymous: boolean;
  readonly logLevel: LogLevel;
  readonly maxRequestBodyBytes: number | undefined;

  constructor(
    options: {
      readonly transport?: Transport;
      readonly host?: string;
      readonly port?: number;
      readonly path?: string;
      readonly auth?: Auth;
      readonly allowedHosts?: Iterable<string>;
      readonly allowedOrigins?: Iterable<string>;
      readonly allowAnonymous?: boolean;
      readonly logLevel?: LogLevel;
      readonly maxRequestBodyBytes?: number;
    } = {},
  ) {
    this.transport = options.transport ?? 'stdio';
    this.host = options.host;
    this.port = options.port;
    this.path = options.path;
    this.auth = options.auth;
    this.allowedHosts = Object.freeze([...(options.allowedHosts ?? [])]);
    this.allowedOrigins = Object.freeze([...(options.allowedOrigins ?? [])]);
    this.allowAnonymous = options.allowAnonymous ?? false;
    this.logLevel = options.logLevel ?? 'info';
    this.maxRequestBodyBytes = options.maxRequestBodyBytes;
    this.validate();
    Object.freeze(this);
  }

  get resolvedHost(): string {
    return this.host ?? DEFAULT_HOST;
  }

  get resolvedPort(): number {
    return this.port ?? DEFAULT_PORT;
  }

  get resolvedPath(): string {
    return this.path ?? DEFAULT_PATH;
  }

  get url(): string {
    return `http://${urlHost(this.resolvedHost)}:${this.resolvedPort}${this.resolvedPath}`;
  }

  private validate(): void {
    if (!isLogLevel(this.logLevel))
      throw new ServeError(`Unknown Contexture log level ${JSON.stringify(this.logLevel)}.`);
    if (this.transport !== 'stdio' && this.transport !== 'streamable-http') {
      throw new ServeError(`Unknown Contexture transport ${JSON.stringify(this.transport)}.`);
    }
    if (this.transport === 'stdio') {
      const stated = [
        this.host === undefined ? undefined : 'host',
        this.port === undefined ? undefined : 'port',
        this.path === undefined ? undefined : 'path',
        this.auth === undefined ? undefined : 'auth',
        this.allowedHosts.length === 0 ? undefined : 'allowedHosts',
        this.allowedOrigins.length === 0 ? undefined : 'allowedOrigins',
        this.allowAnonymous ? 'allowAnonymous' : undefined,
        this.maxRequestBodyBytes === undefined ? undefined : 'maxRequestBodyBytes',
      ].filter((value): value is string => value !== undefined);
      if (stated.length > 0) {
        throw new ServeError(
          `transport='stdio' cannot use ${stated.join(', ')}: stdio has no address to bind or HTTP request to authenticate.`,
        );
      }
      return;
    }
    if (!Number.isInteger(this.resolvedPort) || this.resolvedPort < 0 || this.resolvedPort > 65535)
      throw new ServeError('port must be an integer from 0 through 65535.');
    if (isScopedIpv6(this.resolvedHost))
      throw new ServeError('host must not contain an IPv6 zone identifier.');
    if (!this.resolvedPath.startsWith('/')) throw new ServeError('path must begin with /.');
    if (this.resolvedPath.includes('?') || this.resolvedPath.includes('#'))
      throw new ServeError('path must not contain ? or #.');
    if (!isCanonicalPath(this.resolvedPath))
      throw new ServeError('path must use its URL-canonical, percent-encoded form.');
    if (this.auth !== undefined && !(this.auth instanceof Auth))
      throw new ServeError('auth must be an Auth instance.');
    if (
      this.maxRequestBodyBytes !== undefined &&
      (!Number.isSafeInteger(this.maxRequestBodyBytes) || this.maxRequestBodyBytes <= 0)
    )
      throw new ServeError('maxRequestBodyBytes must be a positive integer number of bytes.');
    if (!isLoopbackHost(this.resolvedHost)) {
      if (this.allowedHosts.length === 0 && this.allowedOrigins.length === 0) {
        throw new ServeError(
          `host=${JSON.stringify(this.resolvedHost)} is not loopback; state allowedHosts and/or allowedOrigins for DNS rebinding protection.`,
        );
      }
    }
  }
}

/** Validate authentication after legacy and canonical HTTP policy have been merged. */
export function validateHttpAccess(options: ContextureOptions): void {
  if (
    options.transport === 'streamable-http' &&
    !isLoopbackHost(options.resolvedHost) &&
    options.auth === undefined &&
    !options.allowAnonymous
  ) {
    throw new ServeError(
      `host=${JSON.stringify(options.resolvedHost)} is not loopback. Pass auth, or state allowAnonymous: true only when unauthenticated access is intentional.`,
    );
  }
}

/** Validate the concrete TCP address reported by a newly bound listener. */
export async function validateBoundHost(
  options: ContextureOptions,
  actualHost: string,
  resolveHost: HostResolver = resolveHostAddresses,
): Promise<void> {
  new ContextureOptions({
    transport: options.transport,
    host: actualHost,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    allowAnonymous: options.allowAnonymous,
    logLevel: options.logLevel,
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });
  if (sameBindHost(options.resolvedHost, actualHost)) return;

  const declaredHost = unwrapHost(options.resolvedHost);
  let resolved: readonly string[];
  try {
    resolved = isIP(declaredHost) === 0 ? await resolveHost(declaredHost) : [];
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new ServeError(
      `Could not resolve ContextureOptions host ${JSON.stringify(options.resolvedHost)}${detail}.`,
      { cause: error },
    );
  }
  if (!resolved.some((address) => sameBindHost(address, actualHost))) {
    throw new ServeError(
      `ContextureOptions host ${JSON.stringify(options.resolvedHost)} does not match listener bind host ${JSON.stringify(actualHost)}.`,
    );
  }
}

export function sameBindHost(declared: string, actual: string): boolean {
  return canonicalBindHost(declared) === canonicalBindHost(actual);
}

function canonicalBindHost(host: string): string {
  const unwrapped = unwrapHost(host);
  return isLoopbackHost(unwrapped)
    ? 'loopback'
    : (canonicalIpHost(unwrapped) ?? unwrapped.toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  const unwrapped = unwrapHost(host);
  if (unwrapped.toLowerCase() === 'localhost') return true;
  const canonical = canonicalIpHost(unwrapped);
  if (canonical === undefined) return false;
  if (isIP(canonical) === 4) return canonical.split('.', 1)[0] === '127';
  if (canonical === '::1') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/i.exec(canonical);
  return mapped !== null && Number.parseInt(mapped[1]!, 16) >> 8 === 127;
}

function urlHost(host: string): string {
  return host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host;
}

function isCanonicalPath(path: string): boolean {
  if (/%(?![0-9a-f]{2})/i.test(path)) return false;
  try {
    return new URL(path, 'http://127.0.0.1').pathname === path;
  } catch {
    return false;
  }
}

type HostResolver = (host: string) => Promise<readonly string[]>;

async function resolveHostAddresses(host: string): Promise<readonly string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);
}

function unwrapHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function canonicalIpHost(host: string): string | undefined {
  const family = isIP(host);
  if (family === 0) return undefined;
  if (family === 4) return host;
  try {
    const hostname = new URL(`http://[${host}]`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return host.toLowerCase();
  }
}

function isScopedIpv6(host: string): boolean {
  const unwrapped = unwrapHost(host);
  return isIP(unwrapped) === 6 && unwrapped.includes('%');
}
