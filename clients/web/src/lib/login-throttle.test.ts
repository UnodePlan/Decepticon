import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearFailures,
  recordFailure,
  retryAfterSeconds,
  type ThrottleState,
} from "./login-throttle";

const OPTIONS = { maxFailures: 3, windowMs: 60_000 };

test("an unknown key is never locked out", () => {
  assert.equal(retryAfterSeconds(undefined, 1_000, OPTIONS), 0);
});

test("failures accumulate until the limit, then report a retry delay", () => {
  const store = new Map<string, ThrottleState>();
  const key = "login:127.0.0.1";

  recordFailure(store, key, 0, OPTIONS);
  recordFailure(store, key, 10, OPTIONS);
  assert.equal(retryAfterSeconds(store.get(key), 10, OPTIONS), 0);

  recordFailure(store, key, 20, OPTIONS);
  assert.equal(retryAfterSeconds(store.get(key), 20, OPTIONS), 60);
  // The window is measured from the FIRST failure in the current streak.
  assert.equal(retryAfterSeconds(store.get(key), 30_000, OPTIONS), 30);
});

test("the window expires and the counter resets with a new streak", () => {
  const store = new Map<string, ThrottleState>();
  const key = "login:127.0.0.1";
  for (const at of [0, 1, 2]) recordFailure(store, key, at, OPTIONS);
  assert.ok(retryAfterSeconds(store.get(key), 2, OPTIONS) > 0);

  assert.equal(retryAfterSeconds(store.get(key), 60_000, OPTIONS), 0);

  recordFailure(store, key, 61_000, OPTIONS);
  assert.deepEqual(store.get(key), { failures: 1, firstFailureAt: 61_000 });
});

test("a successful sign-in clears the streak", () => {
  const store = new Map<string, ThrottleState>();
  const key = "login:127.0.0.1";
  for (const at of [0, 1, 2]) recordFailure(store, key, at, OPTIONS);
  clearFailures(store, key);
  assert.equal(retryAfterSeconds(store.get(key), 2, OPTIONS), 0);
  assert.equal(store.has(key), false);
});

test("keys are scoped per client so one attacker cannot lock everyone out", () => {
  const store = new Map<string, ThrottleState>();
  for (const at of [0, 1, 2]) recordFailure(store, "login:10.0.0.1", at, OPTIONS);
  assert.ok(retryAfterSeconds(store.get("login:10.0.0.1"), 2, OPTIONS) > 0);
  assert.equal(retryAfterSeconds(store.get("login:10.0.0.2"), 2, OPTIONS), 0);
});
