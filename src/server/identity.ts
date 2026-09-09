import {
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
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
      resourceMetadataUrl: this.resourceMetadataUrl,
    });
  }

  get resourceMetadataUrl(): string {
    return getOAuthProtectedResourceMetadataUrl(this.resource);
  }

  /** Serve RFC 9728/8414 discovery documents for this protected resource. */
  metadata(request: Request): Response | undefined {
    if (new URL(request.url).pathname !== new URL(this.resourceMetadataUrl).pathname)
      return undefined;
    if (request.method !== 'GET')
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
    return Response.json({
      resource: this.resource.toString(),
      authorization_servers: [this.issuer.toString()],
      scopes_supported: [...this.requiredScopes],
    });
  }

  sdkVerifier(): OAuthTokenVerifier {
    return { verifyAccessToken: async (token) => this.verify(token) };
  }

  async verify(token: string): Promise<AuthInfo> {
    const verified = await this.verifier.verify(token);
    if (verified === undefined)
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token verification failed.');
    const principal = roundTrippedPrincipal(verified);
    const expiresAt = expiration(principal);
    return {
      token,
      clientId: principal.clientId ?? '',
      scopes: [...principal.scopes].sort(compareCodePoints),
      expiresAt,
      resource: this.resource,
      extra: { [PRINCIPAL_EXTRA]: principal },
    };
  }
}

/**
 * Keep the SDK payload self-contained instead of preserving identity in a
 * token-keyed side table. The token claim is authoritative when it names an
 * issuer: SDK-native authentication also recovers issuer from `claims.iss`.
 */
function roundTrippedPrincipal(principal: Principal): Principal {
  const issuer = issuerFromClaims(principal);
  return new Principal({
    ...(principal.subject === undefined ? {} : { subject: principal.subject }),
    ...(principal.clientId === undefined ? {} : { clientId: principal.clientId }),
    ...(issuer === undefined ? {} : { issuer }),
    scopes: principal.scopes,
    claims: principal.claims,
  });
}

function issuerFromClaims(principal: Principal): string | undefined {
  if (!Object.hasOwn(principal.claims, 'iss')) return principal.issuer;
  const issuer = principal.claims.iss;
  return issuer === undefined || issuer === null ? undefined : String(issuer);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference =
      (leftPoints[index]?.codePointAt(0) ?? 0) - (rightPoints[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
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
