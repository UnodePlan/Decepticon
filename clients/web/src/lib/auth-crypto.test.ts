import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ADMIN_USERNAME,
  adminCredentials,
  adminUsername,
  hashPassword,
  isAuthConfigured,
  verifyAdminCredentials,
  verifyPassword,
} from "./auth-crypto";
import { SCRYPT_PARAMS } from "./auth-crypto";

const PASSWORD = "correct horse battery staple";

test("hashPassword emits scrypt$salt$key and round-trips", async () => {
  const hash = await hashPassword(PASSWORD);
  const [algorithm, salt, key] = hash.split("$");
  assert.equal(algorithm, "scrypt");
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await verifyPassword(PASSWORD, hash), true);
});

test("hashes are salted — the same password never produces the same hash", async () => {
  const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword(PASSWORD, second), true);
});

test("wrong password, wrong algorithm and malformed hashes are all rejected", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword("", hash), false);
  assert.equal(await verifyPassword(`${PASSWORD} `, hash), false);
  assert.equal(await verifyPassword(PASSWORD, hash.replace("scrypt", "pbkdf2")), false);
  assert.equal(await verifyPassword(PASSWORD, "scrypt$zz$zz"), false);
  assert.equal(await verifyPassword(PASSWORD, ""), false);
  assert.equal(await verifyPassword(PASSWORD, null), false);
  assert.equal(await verifyPassword(PASSWORD, undefined), false);
});

test("scrypt parameters stay at the documented cost", () => {
  assert.deepEqual(SCRYPT_PARAMS, { N: 16384, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 });
});

test("adminUsername falls back to the documented default and trims", () => {
  assert.equal(adminUsername({}), DEFAULT_ADMIN_USERNAME);
  assert.equal(adminUsername({ DECEPTICON_ADMIN_USERNAME: "  " }), DEFAULT_ADMIN_USERNAME);
  assert.equal(adminUsername({ DECEPTICON_ADMIN_USERNAME: " operator " }), "operator");
});

test("adminCredentials prefers the pre-computed hash and rejects plaintext-less config", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(
    (await adminCredentials({ DECEPTICON_ADMIN_PASSWORD_HASH: hash }))?.passwordHash,
    hash,
  );
  // A plaintext password is derived once into the same scrypt format.
  const derived = await adminCredentials({ DECEPTICON_ADMIN_PASSWORD: PASSWORD });
  assert.match(derived?.passwordHash ?? "", /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword(PASSWORD, derived?.passwordHash), true);
  // Plaintext must never win over an explicit hash.
  const preferred = await adminCredentials({
    DECEPTICON_ADMIN_PASSWORD: PASSWORD,
    DECEPTICON_ADMIN_PASSWORD_HASH: hash,
  });
  assert.equal(preferred?.passwordHash, hash);
  assert.equal(await adminCredentials({}), null);
});

test("isAuthConfigured requires both a credential and a session secret", () => {
  assert.equal(isAuthConfigured({}), false);
  assert.equal(isAuthConfigured({ DECEPTICON_ADMIN_PASSWORD: PASSWORD }), false);
  assert.equal(isAuthConfigured({ DECEPTICON_SESSION_SECRET: "s" }), false);
  assert.equal(
    isAuthConfigured({ DECEPTICON_ADMIN_PASSWORD_HASH: "scrypt$a$b", DECEPTICON_SESSION_SECRET: "s" }),
    true,
  );
  assert.equal(isAuthConfigured({ DECEPTICON_ADMIN_PASSWORD: PASSWORD, DECEPTICON_SESSION_SECRET: "s" }), true);
});

test("verifyAdminCredentials rejects either half of the pair", async () => {
  const expected = { username: "admin", passwordHash: await hashPassword(PASSWORD) };
  assert.equal(await verifyAdminCredentials({ username: "admin", password: PASSWORD }, expected), true);
  assert.equal(await verifyAdminCredentials({ username: " admin ", password: PASSWORD }, expected), true);
  assert.equal(await verifyAdminCredentials({ username: "root", password: PASSWORD }, expected), false);
  assert.equal(await verifyAdminCredentials({ username: "admin", password: "nope" }, expected), false);
  assert.equal(await verifyAdminCredentials({ username: "", password: "" }, expected), false);
});

test("a wrong username still burns a full password derivation", async () => {
  const expected = { username: "admin", passwordHash: await hashPassword(PASSWORD) };
  const start = performance.now();
  await verifyAdminCredentials({ username: "nobody", password: PASSWORD }, expected);
  const elapsed = performance.now() - start;
  // scrypt at N=16384 takes tens of milliseconds; a short-circuit would return
  // in well under a millisecond and leak that the account name was unknown.
  assert.ok(elapsed > 5, `expected scrypt work, took ${elapsed}ms`);
});
