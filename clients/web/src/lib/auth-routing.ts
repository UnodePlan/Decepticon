/**
 * The dashboard's routing policy, as a pure function.
 *
 * `proxy.ts` owns the Next.js plumbing (reading cookies, verifying the
 * signature, building responses); this module owns the decision, so the
 * boundary can be unit-tested without a Next.js runtime.
 */

/** Exact paths that must stay reachable without a session. */
export const PUBLIC_PATHS = new Set(["/api/health"]);

/** Prefixes that must stay reachable without a session. */
export const PUBLIC_PATH_PREFIXES = ["/api/auth/"];

/** Path of the sign-in screen; never guarded, and skipped once signed in. */
export const LOGIN_PATH = "/login";

export function isPublicApi(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export interface RouteInput {
  pathname: string;
  /** Query string including the leading "?", or "" (used for /login?next=…). */
  search: string;
  /** `DECEPTICON_AUTH_DISABLED=true` — development-only opt-out. */
  authDisabled: boolean;
  /** Trusted in-container caller (shared header token). */
  internal: boolean;
  /** The request carries a valid, unexpired session cookie. */
  hasSession: boolean;
}

export type RouteDecision =
  | { action: "next" }
  | { action: "redirect"; to: string }
  | { action: "unauthorized" };

/**
 * Decide what the proxy does with a request.
 *
 * Unconfigured deployments fail closed: `hasSession` is false, so every page
 * redirects to /login (which explains what is missing) and every API answers
 * 401. `authDisabled` is the only way to reach the pre-auth behaviour.
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const { pathname, search, authDisabled, internal, hasSession } = input;

  if (authDisabled) {
    // No sign-in at all: the login screen is pointless, so it bounces home.
    return pathname === LOGIN_PATH ? { action: "redirect", to: "/" } : { action: "next" };
  }

  if (pathname === LOGIN_PATH) {
    // A signed-in operator has nothing to do on the login screen.
    return hasSession ? { action: "redirect", to: "/" } : { action: "next" };
  }

  if (isPublicApi(pathname)) return { action: "next" };

  if (internal || hasSession) return { action: "next" };

  if (pathname.startsWith("/api/")) return { action: "unauthorized" };

  // Root is the default destination — no need to echo it back as `next`.
  if (pathname === "/") return { action: "redirect", to: LOGIN_PATH };
  const next = `${pathname}${search}`;
  return { action: "redirect", to: `${LOGIN_PATH}?next=${encodeURIComponent(next)}` };
}
