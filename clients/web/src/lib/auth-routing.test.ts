import assert from "node:assert/strict";
import { test } from "node:test";
import { LOGIN_PATH, decideRoute, isPublicApi, type RouteInput } from "./auth-routing";

const base: RouteInput = {
  pathname: "/",
  search: "",
  authDisabled: false,
  internal: false,
  hasSession: false,
};

test("public API paths are exactly /api/health and the /api/auth/* prefix", () => {
  assert.equal(isPublicApi("/api/health"), true);
  assert.equal(isPublicApi("/api/auth/login"), true);
  assert.equal(isPublicApi("/api/auth/logout"), true);
  // A prefix must not swallow an unrelated sibling route.
  assert.equal(isPublicApi("/api/healthcheck"), false);
  assert.equal(isPublicApi("/api/engagements"), false);
  assert.equal(isPublicApi("/api/authz"), false);
});

test("an unauthenticated page request redirects to the login screen", () => {
  assert.deepEqual(decideRoute({ ...base, pathname: "/engagements" }), {
    action: "redirect",
    to: "/login?next=%2Fengagements",
  });
  // The query string survives (and is encoded) so the operator lands back
  // on the exact view after signing in.
  assert.deepEqual(decideRoute({ ...base, pathname: "/engagements", search: "?page=2&filter=open" }), {
    action: "redirect",
    to: "/login?next=%2Fengagements%3Fpage%3D2%26filter%3Dopen",
  });
});

test("the root path redirects without an empty next parameter", () => {
  assert.deepEqual(decideRoute({ ...base, pathname: "/" }), { action: "redirect", to: "/login" });
});

test("an unauthenticated API request answers 401 instead of redirecting", () => {
  assert.deepEqual(decideRoute({ ...base, pathname: "/api/engagements" }), { action: "unauthorized" });
  assert.deepEqual(decideRoute({ ...base, pathname: "/api/workspace/x/files/a" }), {
    action: "unauthorized",
  });
  // Public API routes stay reachable without a session.
  assert.deepEqual(decideRoute({ ...base, pathname: "/api/health" }), { action: "next" });
  assert.deepEqual(decideRoute({ ...base, pathname: "/api/auth/login" }), { action: "next" });
});

test("a valid session reaches every guarded route", () => {
  const session = { ...base, hasSession: true };
  assert.deepEqual(decideRoute({ ...session, pathname: "/" }), { action: "next" });
  assert.deepEqual(decideRoute({ ...session, pathname: "/engagements" }), { action: "next" });
  assert.deepEqual(decideRoute({ ...session, pathname: "/api/engagements" }), { action: "next" });
});

test("/login is reachable when signed out and skipped when signed in", () => {
  assert.deepEqual(decideRoute({ ...base, pathname: LOGIN_PATH }), { action: "next" });
  assert.deepEqual(decideRoute({ ...base, pathname: LOGIN_PATH, hasSession: true }), {
    action: "redirect",
    to: "/",
  });
});

test("the in-container token bypasses the guard without a cookie", () => {
  assert.deepEqual(decideRoute({ ...base, pathname: "/api/engagements", internal: true }), {
    action: "next",
  });
  assert.deepEqual(decideRoute({ ...base, pathname: "/settings", internal: true }), {
    action: "next",
  });
});

test("DECEPTICON_AUTH_DISABLED opens everything and hides the login screen", () => {
  const disabled = { ...base, authDisabled: true };
  assert.deepEqual(decideRoute({ ...disabled, pathname: "/engagements" }), { action: "next" });
  assert.deepEqual(decideRoute({ ...disabled, pathname: "/api/engagements" }), { action: "next" });
  assert.deepEqual(decideRoute({ ...disabled, pathname: LOGIN_PATH }), {
    action: "redirect",
    to: "/",
  });
});

test("an unconfigured deployment fails closed for every guarded route", () => {
  // No credential + no session secret → the proxy can never produce a session.
  for (const pathname of ["/", "/engagements", "/settings", "/api/blue/status"]) {
    const decision = decideRoute({ ...base, pathname });
    assert.notEqual(decision.action, "next", `${pathname} must not be reachable`);
  }
});

test("every split settings route is guarded and keeps its deep link", () => {
  // The split made three new page routes; each one is as sensitive as the old
  // single /settings page, and each must send the operator back to exactly the
  // screen they asked for after signing in.
  for (const pathname of ["/settings", "/settings/models", "/settings/runtime", "/settings/status"]) {
    assert.deepEqual(decideRoute({ ...base, pathname }), {
      action: "redirect",
      to: `/login?next=${encodeURIComponent(pathname)}`,
    });
    assert.deepEqual(decideRoute({ ...base, pathname, hasSession: true }), { action: "next" });
    assert.deepEqual(decideRoute({ ...base, pathname, internal: true }), { action: "next" });
  }
});
