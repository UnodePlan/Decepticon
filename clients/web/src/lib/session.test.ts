import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTERNAL_TOKEN_HEADER,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_TOKEN_VERSION,
  isHttpsRequest,
  matchesInternalToken,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "./session";

const SECRET = "test-session-secret";

async function token(overrides: Partial<{ sub: string; iat: number; exp: number }> = {}): Promise<string> {
  const now = Date.now();
  return signSession({ sub: "local", iat: now, exp: now + 60_000, ...overrides }, SECRET);
}

test("a freshly signed token verifies and preserves its payload", async () => {
  const now = Date.now();
  const signed = await signSession({ sub: "local", iat: now, exp: now + 60_000 }, SECRET);
  assert.equal(signed.split(".").length, 3);
  assert.equal(signed.startsWith(`${SESSION_TOKEN_VERSION}.`), true);

  const payload = await verifySession(signed, SECRET, now);
  assert.deepEqual(payload, { sub: "local", iat: now, exp: now + 60_000 });
});

test("tampering with the payload or signature is rejected", async () => {
  const signed = await token();
  const [version, body, signature] = signed.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "root", iat: 0, exp: Date.now() + 60_000 })).toString("base64url");

  assert.equal(await verifySession(`${version}.${body}.${signature}x`, SECRET), null);
  assert.equal(await verifySession(`${version}.${forged}.${signature}`, SECRET), null);
  assert.equal(await verifySession(signed, "other-secret"), null);
  assert.equal(await verifySession(signed, ""), null);
});

test("expired tokens and malformed input are rejected without throwing", async () => {
  const expired = await token({ iat: 0, exp: 1_000 });
  assert.equal(await verifySession(expired, SECRET), null);
  // Expiry is exclusive: a token expiring exactly now is already invalid.
  const boundary = await token({ exp: 5_000 });
  assert.equal(await verifySession(boundary, SECRET, 5_000), null);
  assert.equal((await verifySession(boundary, SECRET, 4_999))?.sub, "local");

  for (const value of ["", "garbage", "v2.a.b", "v1..b", "v1.a.", "v1.a.b.c", null, undefined, "v1.a.b"]) {
    assert.equal(await verifySession(value, SECRET), null, `expected reject: ${JSON.stringify(value)}`);
  }
});

test("payload fields are validated, not trusted", async () => {
  const encoder = new TextEncoder();
  const now = Date.now();
  const cases = [
    { iat: now, exp: now + 1_000 },
    { sub: "", iat: now, exp: now + 1_000 },
    { sub: "local", exp: now + 1_000 },
    { sub: "local", iat: now, exp: "soon" },
    { sub: "local", iat: now, exp: Number.NaN },
    { sub: "local", iat: now, exp: Number.POSITIVE_INFINITY },
  ];

  for (const payload of cases) {
    const body = Buffer.from(encoder.encode(JSON.stringify(payload))).toString("base64url");
    const signature = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      encoder.encode(`${SESSION_TOKEN_VERSION}.${body}`),
    );
    const forged = `${SESSION_TOKEN_VERSION}.${body}.${Buffer.from(signature).toString("base64url")}`;
    assert.equal(await verifySession(forged, SECRET, now), null, JSON.stringify(payload));
  }
});

test("session cookies are HttpOnly, SameSite=Lax and follow the request scheme", () => {
  assert.deepEqual(sessionCookieOptions(true), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  assert.equal(sessionCookieOptions(false).secure, false);
  assert.equal(SESSION_COOKIE_NAME, "decepticon_session");

  assert.equal(isHttpsRequest("https:", null), true);
  assert.equal(isHttpsRequest("http:", null), false);
  assert.equal(isHttpsRequest("http:", "https"), true);
  assert.equal(isHttpsRequest("http:", "https, http"), true);
  assert.equal(isHttpsRequest("http:", "http"), false);
  assert.equal(isHttpsRequest("http:", null), false);
});

test("matchesInternalToken never matches empty values and is length-safe", () => {
  assert.equal(matchesInternalToken("shared", "shared"), true);
  assert.equal(matchesInternalToken("shared", "other"), false);
  assert.equal(matchesInternalToken("shared", undefined), false);
  assert.equal(matchesInternalToken(undefined, "shared"), false);
  assert.equal(matchesInternalToken("", ""), false);
  assert.equal(matchesInternalToken("shared-longer", "shared"), false);
  assert.equal(INTERNAL_TOKEN_HEADER, "x-decepticon-internal-token");
});
