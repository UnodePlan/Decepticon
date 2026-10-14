/**
 * Administrator credential handling.
 *
 * Credentials are never hard-coded: the account is described entirely by
 * environment variables (see `.env.example`). The canonical format is an
 * scrypt digest — `scrypt$<saltHex>$<derivedKeyHex>` (N=16384, r=8, p=1,
 * dkLen=32) — which {@link hashPassword} emits, so an operator can generate
 * one with:
 *
 *   cd clients/web && npx tsx -e "import {hashPassword} from './src/lib/auth-crypto'; console.log(await hashPassword(process.argv[1]))" -- 'my-password'
 *
 * `pbkdf2$sha256$<iterations>$<saltHex>$<derivedKeyHex>` is accepted as well so
 * a hash produced by another tool (e.g. the Go launcher) can be pasted in.
 * Verification is constant-time in both the password and the username, so a
 * failed login never reveals whether the account name exists.
 */

import { createHash, pbkdf2, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const DEFAULT_ADMIN_USERNAME = "admin";

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 } as const;

/** Iterations for the `pbkdf2$sha256$…` alternative accepted by {@link verifyPassword}. */
export const PBKDF2_ITERATIONS = 210_000;
const KEY_LENGTH = 32;

/**
 * A syntactically valid hash checked against when the submitted payload is
 * unusable (empty password, absent configuration). Deriving against it keeps
 * the response time of a rejected login indistinguishable from a real one.
 * Random by construction — no password ever produces it.
 */
const DECOY_SALT = "6f1a4f9d0e1c3b2a5d7e8f904a1b2c3d";

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(
    password,
    salt,
    SCRYPT_PARAMS.keyLength,
    { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_PARAMS.maxmem },
    (error, key) => (error ? reject(error) : resolve(key)),
  );
  return promise;
}

async function derivePbkdf2(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  pbkdf2(password, salt, iterations, KEY_LENGTH, "sha256", (error, key) =>
    error ? reject(error) : resolve(key),
  );
  return promise;
}

export async function hashPassword(password: string, salt: Buffer = randomBytes(16)): Promise<string> {
  const key = await derive(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export interface StoredHash {
  algorithm: "scrypt" | "pbkdf2";
  salt: Buffer;
  key: string;
  iterations: number;
}

/**
 * Parse the stored formats:
 *   scrypt$<saltHex>$<derivedKeyHex>
 *   pbkdf2$sha256$<iterations>$<saltHex>$<derivedKeyHex>
 */
export function parsePasswordHash(storedHash: string | null | undefined): StoredHash | null {
  const parts = (storedHash ?? "").split("$");

  if (parts.length === 3 && parts[0] === "scrypt" && /^[0-9a-f]{16,64}$/.test(parts[1]) && /^[0-9a-f]{64}$/.test(parts[2])) {
    return { algorithm: "scrypt", salt: Buffer.from(parts[1], "hex"), key: parts[2], iterations: SCRYPT_PARAMS.N };
  }

  if (
    parts.length === 5 &&
    parts[0] === "pbkdf2" &&
    parts[1] === "sha256" &&
    /^[0-9]+$/.test(parts[2]) &&
    Number(parts[2]) >= 10_000 &&
    /^[0-9a-f]{16,64}$/.test(parts[3]) &&
    /^[0-9a-f]{64}$/.test(parts[4])
  ) {
    return {
      algorithm: "pbkdf2",
      salt: Buffer.from(parts[3], "hex"),
      key: parts[4],
      iterations: Number(parts[2]),
    };
  }

  return null;
}

/** Constant-time comparison of two hex digests, length-independent. */
function digestsEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Verify `password` against a stored hash. Always performs exactly one key
 * derivation, even when the stored hash is missing or malformed.
 */
export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  const parsed = parsePasswordHash(storedHash);
  const candidate = parsed
    ? await (parsed.algorithm === "scrypt"
        ? derive(password, parsed.salt)
        : derivePbkdf2(password, parsed.salt, parsed.iterations))
    : await derive(password, Buffer.from(DECOY_SALT, "hex"));

  if (!parsed) return false;
  return timingSafeEqual(candidate, Buffer.from(parsed.key, "hex"));
}

/**
 * Resolve the single administrator account from the environment.
 * Returns null when no credential is configured, which callers MUST surface
 * as "authentication is not configured" rather than allowing access.
 */
export async function adminCredentials(
  env: Record<string, string | undefined>,
): Promise<{ username: string; passwordHash: string } | null> {
  const username = adminUsername(env);
  const configuredHash = env.DECEPTICON_ADMIN_PASSWORD_HASH?.trim();
  if (configuredHash) return { username, passwordHash: configuredHash };

  const plaintext = env.DECEPTICON_ADMIN_PASSWORD;
  if (!plaintext) return null;

  // Derive once per process: the operator set a plaintext password instead of
  // a pre-computed hash, and scrypt is deliberately too slow to run per request.
  if (derivedCache?.plaintext !== plaintext) {
    derivedCache = { plaintext, passwordHash: await hashPassword(plaintext) };
    console.warn(
      "[auth] DECEPTICON_ADMIN_PASSWORD is set in plaintext. Prefer " +
        "DECEPTICON_ADMIN_PASSWORD_HASH (scrypt$saltHex$derivedKeyHex).",
    );
  }
  return { username, passwordHash: derivedCache.passwordHash };
}

let derivedCache: { plaintext: string; passwordHash: string } | null = null;

export function adminUsername(env: Record<string, string | undefined>): string {
  return env.DECEPTICON_ADMIN_USERNAME?.trim() || DEFAULT_ADMIN_USERNAME;
}

export function isAuthConfigured(env: Record<string, string | undefined>): boolean {
  const hasCredential = Boolean(env.DECEPTICON_ADMIN_PASSWORD_HASH?.trim() || env.DECEPTICON_ADMIN_PASSWORD);
  return hasCredential && Boolean(env.DECEPTICON_SESSION_SECRET?.trim());
}

/**
 * Constant-time credential check. Both halves always run, so an unknown
 * username is indistinguishable from a wrong password.
 */
export async function verifyAdminCredentials(
  submitted: { username: string; password: string },
  expected: { username: string; passwordHash: string },
): Promise<boolean> {
  const usernameMatches = digestsEqual(submitted.username.trim(), expected.username);
  const passwordMatches = await verifyPassword(submitted.password, expected.passwordHash);
  return usernameMatches && passwordMatches;
}
