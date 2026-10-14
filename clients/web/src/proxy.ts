/**
 * Proxy (Next.js 16 rename of `middleware`) — the authentication boundary for
 * the dashboard.
 *
 * Everything not explicitly public requires a valid session cookie:
 *   - page requests  → 307 to /login?next=<path>
 *   - API requests   → 401 JSON (the UI's fetch handlers surface these)
 *
 * Public: /login, /api/auth/*, /api/health (container + launcher probes),
 * static assets (excluded by the matcher), and in-container callers that
 * present DECEPTICON_INTERNAL_API_TOKEN.
 *
 * The routing decision itself lives in `lib/auth-routing.ts` (pure, unit
 * tested); this file only wires Next.js' request/response objects to it.
 *
 * Note: the terminal WebSocket lives on its own port and never passes through
 * here — `server/terminal-server.ts` performs its own cookie check.
 */

import { NextResponse, type NextRequest } from "next/server";
import { decideRoute } from "@/lib/auth-routing";
import {
  INTERNAL_TOKEN_HEADER,
  matchesInternalToken,
  SESSION_COOKIE_NAME,
  verifySession,
} from "@/lib/session";

/** Read env dynamically so bundlers never inline (and freeze) these values. */
function envVar(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const secret = envVar("DECEPTICON_SESSION_SECRET");
  const hasCredential = Boolean(
    envVar("DECEPTICON_ADMIN_PASSWORD_HASH") || envVar("DECEPTICON_ADMIN_PASSWORD"),
  );
  // Unconfigured deployments fail closed: nothing is authenticated, and /login
  // explains what is missing.
  const internal = matchesInternalToken(
    request.headers.get(INTERNAL_TOKEN_HEADER),
    envVar("DECEPTICON_INTERNAL_API_TOKEN"),
  );
  const session =
    secret && hasCredential
      ? await verifySession(request.cookies.get(SESSION_COOKIE_NAME)?.value, secret)
      : null;

  const decision = decideRoute({
    pathname,
    search,
    authDisabled: envVar("DECEPTICON_AUTH_DISABLED") === "true",
    internal,
    hasSession: session !== null,
  });

  switch (decision.action) {
    case "next":
      return NextResponse.next();
    case "unauthorized":
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    case "redirect":
      return NextResponse.redirect(new URL(decision.to, request.url));
  }
}

export const config = {
  // Everything except Next.js internals (including dev HMR sockets) and static
  // assets.
  matcher: ["/((?!_next/|favicon.ico|logo.png|icon.png|.*\\.(?:png|svg|ico)$).*)"],
};
