import {
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';

import { Principal } from '../core/foundation/principal.js';

/** Business-owned token validation. Contexture never issues credentials. */
export interface TokenVerifier {
  verify(token: string): Promise<Principal | undefined>;
}

/** Validated Contexture identity retained in the SDK request extra. */
export const PRINCIPAL_EXTRA = 'contexture.principal';

/** Authentication facts for one HTTP MCP resource server. */
export class Auth {
  readonly issuer: URL;
  readonly resource: URL;
  readonly requiredScopes: readonly string[];

  constructor(
    readonly verifier: TokenVerifier,
    options: {
      readonly issuer: string | URL;
      readonly resource: string | URL;
      readonly requiredScopes?: Iterable<string>;
    },
  ) {
    if (verifier === null || typeof verifier !== 'object' || typeof verifier.verify !== 'function')
      throw new TypeError('Auth verifier must implement verify(token).');
    this.issuer = absoluteHttpUrl(options.issuer, 'issuer');
    this.resource = absoluteHttpUrl(options.resource, 'resource');
    this.requiredScopes = Object.freeze([...(options.requiredScopes ?? [])]);
    Object.freeze(this);
  }

  gate(): (request: Request) => Promise<AuthInfo | Response> {
    return requireBearerAuth({
      verifier: this.sdkVerifier(),
      requiredScopes: [...this.requiredScopes],
      resourceMetadataUrl: `${this.resource.origin}/.well-known/oauth-protected-resource${this.resource.pathname}`,
    });
  }

  sdkVerifier(): OAuthTokenVerifier {
    return { verifyAccessToken: async (token) => this.verify(token) };
  }

  async verify(token: string): Promise<AuthInfo> {
    const principal = await this.verifier.verify(token);
    if (principal === undefined)
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token verification failed.');
    const expiresAt = expiration(principal);
    return {
      token,
      clientId: principal.clientId ?? '',
      scopes: [...principal.scopes],
      expiresAt,
      resource: this.resource,
      extra: { [PRINCIPAL_EXTRA]: principal },
    };
  }
}

/** Recover the application identity from SDK request context facts. */
export function principalOf(authInfo: AuthInfo | undefined): Principal | undefined {
  const value = authInfo?.extra?.[PRINCIPAL_EXTRA];
  return value instanceof Principal ? value : undefined;
}

function absoluteHttpUrl(value: string | URL, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`Auth ${name} must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new TypeError(`Auth ${name} must be an absolute http(s) URL.`);
  return parsed;
}

function expiration(principal: Principal): number {
  const value = principal.claims.exp;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      'Verified Principal must include numeric claims.exp (seconds since Unix epoch).',
    );
  return value;
}
