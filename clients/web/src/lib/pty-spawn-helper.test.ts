/**
 * node-pty ships its darwin `spawn-helper` (mode 0644) in the npm tarball, and
 * `posix_spawnp` refuses to exec it — every PTY then dies with the bare
 * "posix_spawnp failed." The repair is pure filesystem work, so it is exercised
 * against a real temp tree instead of a mocked `fs`: the point of the test is
 * that the exact file `posix_spawnp` execs ends up executable, which a stub
 * cannot show.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensurePtySpawnHelper, SPAWN_HELPER_MODE } from "./pty-spawn-helper";

/** A package tree laid out like an installed node-pty, with `mode` on the helper. */
function packageTree(mode: number | null, arch = "arm64"): string {
  const root = mkdtempSync(join(tmpdir(), "pty-spawn-helper-"));
  if (mode !== null) {
    const dir = join(root, "prebuilds", `darwin-${arch}`);
    mkdirSync(dir, { recursive: true });
    const helper = join(dir, "spawn-helper");
    writeFileSync(helper, "");
    chmodSync(helper, mode);
  }
  return root;
}

/** The permission bits alone — `statSync().mode` also carries the file-type bits. */
const permissions = (path: string): number => statSync(path).mode & 0o777;

test("non-darwin hosts need no helper — forkpty/conpty never exec one", () => {
  for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
    const result = ensurePtySpawnHelper({ platform, arch: "arm64", packageRoot: "/nonexistent" });
    assert.deepEqual(result, { status: "not-needed" });
  }
});

test("an already executable helper is left untouched", () => {
  const root = packageTree(SPAWN_HELPER_MODE);
  const helper = join(root, "prebuilds", "darwin-arm64", "spawn-helper");
  try {
    assert.deepEqual(ensurePtySpawnHelper({ platform: "darwin", arch: "arm64", packageRoot: root }),
      { status: "ok", path: helper });
    assert.equal(permissions(helper), SPAWN_HELPER_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the 0644 helper node-pty publishes is made executable, and stays executable", () => {
  const root = packageTree(0o644);
  const helper = join(root, "prebuilds", "darwin-arm64", "spawn-helper");
  try {
    assert.equal(permissions(helper), 0o644);
    assert.deepEqual(ensurePtySpawnHelper({ platform: "darwin", arch: "arm64", packageRoot: root }),
      { status: "repaired", path: helper });
    assert.equal(permissions(helper), SPAWN_HELPER_MODE);
    // Second startup (the server is restarted on every hotswap) must not chmod again.
    assert.deepEqual(ensurePtySpawnHelper({ platform: "darwin", arch: "arm64", packageRoot: root }),
      { status: "ok", path: helper });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the helper for the running arch is selected, not the other darwin prebuild", () => {
  const root = packageTree(0o644, "x64");
  const x64 = join(root, "prebuilds", "darwin-x64", "spawn-helper");
  try {
    assert.deepEqual(ensurePtySpawnHelper({ platform: "darwin", arch: "x64", packageRoot: root }),
      { status: "repaired", path: x64 });
    assert.equal(permissions(x64), SPAWN_HELPER_MODE);
    // The other arch's prebuild is not installed in this tree, so asking for it
    // reports ENOENT rather than silently repairing/loading a foreign binary.
    const arm64 = ensurePtySpawnHelper({ platform: "darwin", arch: "arm64", packageRoot: root });
    assert.equal(arm64.status, "unavailable");
    assert.equal(arm64.status === "unavailable" && arm64.reason, "missing");
    assert.equal(arm64.status === "unavailable" && arm64.path, join(root, "prebuilds", "darwin-arm64", "spawn-helper"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing prebuild reports ENOENT instead of throwing, with the remedy path", () => {
  const root = packageTree(null);
  const helper = join(root, "prebuilds", "darwin-arm64", "spawn-helper");
  try {
    const result = ensurePtySpawnHelper({ platform: "darwin", arch: "arm64", packageRoot: root });
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" && result.path, helper);
    assert.equal(result.status === "unavailable" && result.reason, "missing");
    assert.match(result.status === "unavailable" ? result.error : "", /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a helper the server cannot make executable reports the failure instead of throwing", () => {
  // The helper's parent is a file, so neither the access probe nor chmod can
  // succeed and neither error is ENOENT — the branch that must degrade to a
  // diagnosable result rather than crash the server at startup.
  const root = mkdtempSync(join(tmpdir(), "pty-spawn-helper-"));
  const helper = join(root, "prebuilds", "darwin-arm64", "spawn-helper");
  mkdirSync(join(root, "prebuilds"), { recursive: true });
  writeFileSync(join(root, "prebuilds", "darwin-arm64"), "");
  try {
    const result = ensurePtySpawnHelper({ platform: "darwin", arch: "arm64", packageRoot: root });
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" && result.path, helper);
    assert.equal(result.status === "unavailable" && result.reason, "not-executable");
    assert.match(result.status === "unavailable" ? result.error : "", /ENOTDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
