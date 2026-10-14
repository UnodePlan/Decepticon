import { NextRequest, NextResponse } from "next/server";
import {
  adminCredentials,
  adminUsername,
  isAuthConfigured,
  verifyAdminCredentials,
} from "@/lib/auth-crypto";
import { resolveAuth, authSecret, isAuthDisabled } from "@/lib/auth-bridge";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  isHttpsRequest,
  sessionCookieOptions,
  signSession,
} from "@/lib/session";
import { clearFailures, recordFailure, retryAfterSeconds, type ThrottleState } from "@/lib/login-throttle";

/** One container owns the whole deployment, so an in-process map is enough. */
const failures = new Map<string, ThrottleState>();

async function readCredentials(request: NextRequest): Promise<{ username: string; password: string } | null> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) return null;
    const { username, password } = body as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string") return null;
    return { username, password };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = `login:${forwarded || request.headers.get("x-real-ip") || "local"}`;

  const retryAfter = retryAfterSeconds(failures.get(key), Date.now());
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: "Too many attempts" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const secret = authSecret(process.env);
  if (!secret || !isAuthConfigured(process.env)) {
    // Fail closed: with no credential configured there is no way in, and the
    // operator gets an explicit diagnostic instead of a silent bypass.
    return NextResponse.json(
      {
        error:
          "Authentication is not configured — set DECEPTICON_ADMIN_USERNAME and " +
          "DECEPTICON_ADMIN_PASSWORD_HASH (plus DECEPTICON_SESSION_SECRET).",
      },
      { status: 503 },
    );
  }

  const submitted = await readCredentials(request);
  const expected = submitted ? await adminCredentials(process.env) : null;
  if (!submitted || !expected || !(await verifyAdminCredentials(submitted, expected))) {
    recordFailure(failures, key, Date.now());
    // Identical body and status for unknown account, wrong password and a
    // malformed request: the response never reveals which part failed.
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  clearFailures(failures, key);

  const now = Date.now();
  const token = await signSession(
    { sub: "local", iat: now, exp: now + SESSION_MAX_AGE_SECONDS * 1000 },
    secret,
  );

  const response = NextResponse.json({ authenticated: true, username: expected.username });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    ...sessionCookieOptions(
      isHttpsRequest(request.nextUrl.protocol, request.headers.get("x-forwarded-proto")),
    ),
  });
  return response;
}

/** Reports the current session so the header can render sign-in/out state. */
export async function GET() {
  if (isAuthDisabled(process.env)) {
    // Development escape hatch: every request already resolves to the local
    // owner, so report a signed-in shell rather than a permanent "not signed
    // in" hint that contradicts the pages behind it.
    return NextResponse.json({ authenticated: true, username: adminUsername(process.env) });
  }
  const result = await resolveAuth();
  if (!result) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, username: result.session?.username ?? null });
}
