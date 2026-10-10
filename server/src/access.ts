import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Cloudflare Access identity verification (docs/SYNC.md §2, docs/BACKEND.md).
 *
 * Every sync request must carry a valid Access JWT. Access signs it and exposes
 * it as the `Cf-Access-Jwt-Assertion` header (and the `CF_Authorization`
 * cookie); we verify its signature against the team's rotating JWKS and check
 * the audience and issuer. The verified identity (the user's email, falling back
 * to the subject) scopes every change — a device id is never trusted for this.
 */

export interface AccessEnv {
  readonly ACCESS_AUD: string;
  readonly ACCESS_TEAM_DOMAIN: string;
}

export interface Identity {
  readonly userId: string;
}

type JwkSet = ReturnType<typeof createRemoteJWKSet>;
const jwksByIssuer = new Map<string, JwkSet>();

function jwksFor(issuer: string): JwkSet {
  let set = jwksByIssuer.get(issuer);
  if (set === undefined) {
    set = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, set);
  }
  return set;
}

function readToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header !== null && header.length > 0) return header;
  const cookie = request.headers.get('Cookie');
  if (cookie === null) return null;
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]!) : null;
}

function identityFrom(payload: JWTPayload): Identity | null {
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const userId = email ?? payload.sub;
  return userId !== undefined && userId.length > 0 ? { userId } : null;
}

export async function verifyAccess(request: Request, env: AccessEnv): Promise<Identity | null> {
  if (env.ACCESS_AUD.length === 0 || env.ACCESS_TEAM_DOMAIN.length === 0) return null;
  const token = readToken(request);
  if (token === null) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: env.ACCESS_AUD,
    });
    return identityFrom(payload);
  } catch {
    return null;
  }
}
