/**
 * node-pty's macOS prebuilt helper is shipped without the execute bit.
 *
 * On darwin node-pty does not forkpty: it `posix_spawnp`s a small `spawn-helper`
 * binary from its own prebuilds directory
 * (`node-pty/lib/unixTerminal.js` → `prebuilds/darwin-<arch>/spawn-helper`), and
 * that helper is what sets the controlling terminal and `execvp`s the real
 * command. The npm tarball for the stable line carries the binary as mode 0644
 * (verified against `node-pty@1.1.0`: `tar -tvzf` reports `-rw-r--r-- … package/
 * prebuilds/darwin-arm64/spawn-helper`), so `posix_spawnp` answers EACCES and
 * node-pty throws the bare `posix_spawnp failed.` — a message with no path, no
 * errno and no remedy, which is why the terminal looks broken rather than
 * misinstalled. Linux/Windows are unaffected (forkpty / conpty, no helper).
 *
 * Upstream fixed the packaging in 1.2.0-beta.2, not on the stable line, so an
 * install of `^1.1.0` keeps the 0644 binary. Two things restore the bit:
 * node-pty's own `install` script only rebuilds (and only when it compiled from
 * source), and package managers that skip install scripts (pnpm default,
 * `--ignore-scripts`, or a node_modules tree copied between machines) never run
 * it. The terminal server is the only place that spawns a PTY, so it repairs the
 * bit here — immediately before the first spawn it performs — instead of relying
 * on an install hook that may not have run.
 */

import { constants, accessSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Mode the helper needs to be `posix_spawnp`-able; node-pty's source build uses the same. */
export const SPAWN_HELPER_MODE = 0o755;

export type PtySpawnHelperResult =
  /** Not darwin: node-pty uses forkpty/conpty and never touches a helper. */
  | { status: "not-needed" }
  /** The helper is executable by this process; nothing was written. */
  | { status: "ok"; path: string }
  /** The execute bit was missing and has been restored. */
  | { status: "repaired"; path: string }
  /**
   * The helper cannot be executed and the server cannot fix it (missing,
   * unresolvable, or a read-only/non-owned tree). `error` is the OS message so
   * the caller can print the actual remedy instead of guessing.
   */
  | {
    status: "unavailable";
    path: string;
    reason: "unresolved" | "missing" | "not-executable";
    error: string;
  };

export interface PtySpawnHelperOptions {
  /** Defaults to `process.platform`; injected by tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`; injected by tests. */
  arch?: string;
  /** Defaults to the resolved node-pty package root; injected by tests. */
  packageRoot?: string;
}

/**
 * Make node-pty's darwin `spawn-helper` executable, if this host needs it.
 *
 * Idempotent, and a no-op when the helper already runs: the `X_OK` probe asks
 * the kernel the same question `posix_spawnp` asks, so a helper that is
 * executable only via group/other bits is left alone.
 */
export function ensurePtySpawnHelper(options: PtySpawnHelperOptions = {}): PtySpawnHelperResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { status: "not-needed" };

  let packageRoot: string;
  try {
    // Resolved from this module, so a hoisted root install and a nested
    // `clients/web/node_modules` install both find the copy `import "node-pty"`
    // loads.
    packageRoot = options.packageRoot ?? dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  } catch (err) {
    return {
      status: "unavailable",
      path: "node-pty/package.json",
      reason: "unresolved",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const arch = options.arch ?? process.arch;
  const path = join(packageRoot, "prebuilds", `darwin-${arch}`, "spawn-helper");

  try {
    accessSync(path, constants.X_OK);
    return { status: "ok", path };
  } catch (err) {
    // EACCES/EPERM: present but not executable. ENOENT: the prebuild for this
    // arch was never installed, and no chmod can invent it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "unavailable", path, reason: "missing", error: (err as Error).message };
    }
  }

  try {
    chmodSync(path, SPAWN_HELPER_MODE);
    accessSync(path, constants.X_OK);
    return { status: "repaired", path };
  } catch (err) {
    return {
      status: "unavailable",
      path,
      reason: "not-executable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
