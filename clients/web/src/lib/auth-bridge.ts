/**
 * Auth bridge — single-admin local deploy.
 *
 * Decepticon is self-hosted and single-tenant: one administrator account is
 * configured through the environment (see `.env.example`), and every request
 * that clears the check resolves to the workspace owner `"local"` — the same
 * `userId` the existing `Engagement` rows already carry. Signing in therefore
 * never changes data ownership: pre-existing engagements stay visible.
 *
 * Route handlers keep the historical contract — `requireAuth()` throws
 * {@link AuthError} when the request is unauthenticated.
 */

import { cookies, headers } from "next/headers";
import {
  INTERNAL_TOKEN_HEADER,
  SESSION_COOKIE_NAME,
  matchesInternalToken,
  verifySession,
} from "@/lib/session";
import { isAuthConfigured } from "@/lib/auth-crypto";

/** Owner id shared by every pre-existing row; authentication never changes it. */
export const LOCAL_OWNER_ID = "local";

export class AuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export interface SessionInfo {
  /** Authenticated administrator username. */
  username: string;
  /** Session expiry, epoch milliseconds. */
  expiresAt: number;
}

export interface AuthResult {
  userId: string;
  session: SessionInfo | null;
  /** True for trusted in-container callers (shared header token), false for cookie sessions. */
  internal: boolean;
}

export function authSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.DECEPTICON_SESSION_SECRET?.trim() || null;
}

export function hasInternalToken(
  provided: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return matchesInternalToken(provided, env.DECEPTICON_INTERNAL_API_TOKEN?.trim());
}

/**
 * Explicit, development-only escape hatch: `DECEPTICON_AUTH_DISABLED=true`
 * restores the historical "single local user, no sign-in" behaviour. It must
 * be set deliberately — an empty configuration fails closed instead. Never
 * enable it on a host reachable by anything but the local operator.
 */
export function isAuthDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DECEPTICON_AUTH_DISABLED === "true";
}

/**
 * Resolve the caller from the session cookie, or null when the request is not
 * authenticated (or when authentication is not configured at all).
 */
export async function resolveAuth(
  env: Record<string, string | undefined> = process.env,
): Promise<AuthResult | null> {
  if (isAuthDisabled(env)) {
    return { userId: LOCAL_OWNER_ID, session: null, internal: true };
  }

  if (hasInternalToken((await headers()).get(INTERNAL_TOKEN_HEADER), env)) {
    return { userId: LOCAL_OWNER_ID, session: null, internal: true };
  }

  const secret = authSecret(env);
  if (!secret || !isAuthConfigured(env)) return null;

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const payload = await verifySession(token, secret);
  if (!payload) return null;

  return {
    userId: LOCAL_OWNER_ID,
    session: { username: env.DECEPTICON_ADMIN_USERNAME?.trim() || "admin", expiresAt: payload.exp },
    internal: false,
  };
}

/** Throwing variant used by every existing `/api/**` route handler. */
export async function requireAuth(): Promise<AuthResult> {
  const result = await resolveAuth();
  if (!result) throw new AuthError();
  return result;
}

/** Non-throwing variant for pages and UI hydration. */
export async function getSession(): Promise<SessionInfo | null> {
  return (await resolveAuth())?.session ?? null;
}

export function isAuthEnabled(): boolean {
  return isAuthConfigured(process.env);
}
