/**
 * Signed, stateless session tokens for the dashboard administrator.
 *
 * Token format:
 *   `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, "v1." + payload))>`
 *
 * WebCrypto only (never `node:crypto`) so the same module can be used by the
 * Next.js proxy, by route handlers and by server components without runtime
 * surprises.
 */

export const SESSION_COOKIE_NAME = "decepticon_session";
export const SESSION_TOKEN_VERSION = "v1";
/** 7 days — long enough for a self-hosted operator, short enough to expire. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Shared secret the in-container terminal server uses to call its own API
 * (it holds no browser cookie). Both sides read
 * `DECEPTICON_INTERNAL_API_TOKEN`; when unset the bypass does not exist.
 */
export const INTERNAL_TOKEN_HEADER = "x-decepticon-internal-token";

export interface SessionPayload {
  /** Account id that signed in — always "local" for the single-admin deploy. */
  sub: string;
  /** Issued at, epoch milliseconds. */
  iat: number;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  try {
    const binary = atob(padded + padding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Branch-free byte comparison — no early exit on the first differing byte. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${SESSION_TOKEN_VERSION}.${body}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a session token. Returns null for anything that is not a correctly
 * signed, well-formed, unexpired token — never throws on attacker input.
 */
export async function verifySession(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): Promise<SessionPayload | null> {
  if (!token || !secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, body, signature] = parts;
  if (version !== SESSION_TOKEN_VERSION || !body || !signature) return null;

  const signatureBytes = base64UrlDecode(signature);
  if (!signatureBytes) return null;

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      signatureBytes as unknown as BufferSource,
      new Uint8Array(encoder.encode(`${version}.${body}`)) as unknown as BufferSource,
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const payloadBytes = base64UrlDecode(body);
  if (!payloadBytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { sub, iat, exp } = parsed as Partial<SessionPayload>;
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp <= now) return null;

  return { sub, iat, exp };
}

export function matchesInternalToken(
  provided: string | null | undefined,
  expected: string | undefined | null,
): boolean {
  if (!provided || !expected) return false;
  return constantTimeEqual(encoder.encode(provided), encoder.encode(expected));
}

/**
 * Whether the request reached us over HTTPS. Self-hosted dashboards are served
 * on plain http://localhost (compose binds 127.0.0.1), where a `Secure` cookie
 * would be dropped by the browser — so `Secure` follows the actual scheme, and
 * TLS-terminating proxies are honoured through `x-forwarded-proto`.
 */
export function isHttpsRequest(protocol: string, forwardedProto?: string | null): boolean {
  const forwarded = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  const scheme = forwarded || protocol.replace(":", "").toLowerCase();
  return scheme === "https" || scheme === "wss";
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}

export function sessionCookieOptions(secure: boolean): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
