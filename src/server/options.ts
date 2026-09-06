import { ContextureError } from '../core/foundation/errors.js';

export type Transport = 'stdio' | 'streamable-http';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8000;
export const DEFAULT_PATH = '/mcp';
export const LOOPBACK = Object.freeze(new Set(['127.0.0.1', 'localhost', '::1', '[::1]']));

/** A request to serve a Contexture application cannot be honoured safely. */
export class ServeError extends ContextureError {
  override readonly name = 'ServeError';
}

/** Validated transport policy shared by CLI and programmatic server startup. */
export class ContextureOptions {
  readonly transport: Transport;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly path: string | undefined;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowAnonymous: boolean;

  constructor(
    options: {
      readonly transport?: Transport;
      readonly host?: string;
      readonly port?: number;
      readonly path?: string;
      readonly allowedHosts?: Iterable<string>;
      readonly allowedOrigins?: Iterable<string>;
      readonly allowAnonymous?: boolean;
    } = {},
  ) {
    this.transport = options.transport ?? 'stdio';
    this.host = options.host;
    this.port = options.port;
    this.path = options.path;
    this.allowedHosts = Object.freeze([...(options.allowedHosts ?? [])]);
    this.allowedOrigins = Object.freeze([...(options.allowedOrigins ?? [])]);
    this.allowAnonymous = options.allowAnonymous ?? false;
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
    return `http://${this.resolvedHost}:${this.resolvedPort}${this.resolvedPath}`;
  }

  private validate(): void {
    if (this.transport !== 'stdio' && this.transport !== 'streamable-http') {
      throw new ServeError(`Unknown Contexture transport ${JSON.stringify(this.transport)}.`);
    }
    if (this.transport === 'stdio') {
      const stated = [
        this.host === undefined ? undefined : 'host',
        this.port === undefined ? undefined : 'port',
        this.path === undefined ? undefined : 'path',
        this.allowedHosts.length === 0 ? undefined : 'allowedHosts',
        this.allowedOrigins.length === 0 ? undefined : 'allowedOrigins',
        this.allowAnonymous ? 'allowAnonymous' : undefined,
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
    if (!this.resolvedPath.startsWith('/')) throw new ServeError('path must begin with /.');
    if (!LOOPBACK.has(this.resolvedHost)) {
      if (this.allowedHosts.length === 0 && this.allowedOrigins.length === 0) {
        throw new ServeError(
          `host=${JSON.stringify(this.resolvedHost)} is not loopback; state allowedHosts and/or allowedOrigins for DNS rebinding protection.`,
        );
      }
      if (!this.allowAnonymous) {
        throw new ServeError(
          `host=${JSON.stringify(this.resolvedHost)} is not loopback. State allowAnonymous: true only when unauthenticated access is intentional.`,
        );
      }
    }
  }
}
