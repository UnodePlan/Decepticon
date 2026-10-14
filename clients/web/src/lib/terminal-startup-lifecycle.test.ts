/** Exercise terminal startup against controlled socket, process, network, and clock boundaries. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import { runSettingsEnv } from "./run-settings";
import type { PtySpawnHelperResult } from "./pty-spawn-helper";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, resolve: complete };
}

class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = Socket.OPEN;
  messages: string[] = [];
  closeCode: number | null = null;
  send(message: string): void {
    assert.equal(this.readyState, Socket.OPEN, "must never send on a closed socket");
    this.messages.push(message);
  }
  close(code = 1000): void {
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close");
  }
}

type Response = { status: number; ok: boolean; json: () => Promise<{ thread_id: string }> };
type Request = { method?: string; signal?: AbortSignal };
function response(status: number, threadId = "created"): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => ({ thread_id: threadId }) };
}

function server(options: {
  fetch?: (url: string, request: Request) => Promise<Response>;
  scope?: Promise<Buffer>;
  /** Saved model policy the terminal server reads before spawning a PTY. */
  settings?: Record<string, unknown>;
  settingsStatus?: number;
  /** What the node-pty spawn-helper probe reports on this host. */
  spawnHelper?: PtySpawnHelperResult;
  /** Replaces `pty.spawn`, to exercise the spawn-failure path. */
  spawn?: () => never;
  /** The server process's own environment, which every PTY inherits. */
  env?: Record<string, string>;
} = {}) {
  const calls: { url: string; method: string }[] = [];
  const terms: { threadId: string; killed: boolean }[] = [];
  const spawnArgs: string[][] = [];
  const spawnEnvs: Record<string, string>[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let handler!: (socket: Socket, request: { headers: { origin: string }; url: string }) => Promise<void>;
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const sourceUrl = new URL("../../server/terminal-server.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace(/^import .*;\r?$/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href));
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    WebSocket: Socket,
    WebSocketServer: class {
      on(event: string, callback: typeof handler): void {
        if (event === "connection") handler = callback;
      }
      close(): void {}
    },
    pty: { spawn(_command: string, args: string[], config: { env: Record<string, string> }) {
      if (options.spawn) options.spawn();
      const term = { threadId: config.env.DECEPTICON_THREAD_ID, killed: false };
      terms.push(term);
      spawnArgs.push(args);
      spawnEnvs.push(config.env);
      return {
        pid: terms.length, onData(): void {}, onExit(): void {},
        kill(): void { term.killed = true; },
      };
    } },
    resolve, dirname, join, fileURLToPath, createHash,
    // The harness strips the server's imports, so the settings helper the
    // server calls before every spawn is injected here.
    runSettingsEnv,
    // …and so is the node-pty spawn-helper probe: the real one touches the
    // installed tree, which a lifecycle test must not depend on.
    ensurePtySpawnHelper: () => options.spawnHelper ?? { status: "not-needed" },
    readFile: async () => {
      if (options.scope) return options.scope;
      throw new Error("No approval documents");
    },
    fetch: async (url: string, request: Request = {}) => {
      // Each new PTY is seeded with the saved model policy through the
      // dashboard's settings API. That read is not a thread-lifecycle step, so
      // it is answered here and kept out of `calls`.
      if (url.endsWith("/api/settings")) {
        const status = options.settingsStatus ?? 200;
        return { status, ok: status >= 200 && status < 300, json: async () => options.settings ?? {} };
      }
      calls.push({ url, method: request.method ?? "GET" });
      if (request.method === "PATCH") return response(200);
      return options.fetch ? options.fetch(url, request) : response(200);
    },
    process: { env: options.env ?? {}, on(): void {}, exit(): never { throw new Error("Unexpected exit"); } },
    console: { log(message: string) { logs.push(message); }, error(message: string) { errors.push(message); } },
    URL, Buffer, AbortController,
    setTimeout(callback: () => void, delay: number): number {
      const id = ++timerId;
      timers.set(id, { due: now + delay, callback });
      return id;
    },
    clearTimeout(id: number): void { timers.delete(id); },
  });
  assert.equal(typeof handler, "function");
  return {
    calls, terms, timers, spawnArgs, spawnEnvs, logs, errors,
    connect(socket: Socket, threadId = "existing"): Promise<void> {
      return handler(socket, {
        headers: { origin: "http://localhost:3000" },
        url: `/terminal?engagementSlug=owned-case&engagementId=owned&agentId=soundwave&threadId=${threadId}`,
      });
    },
    advance(milliseconds: number): void {
      now += milliseconds;
      for (const [id, timer] of timers) {
        if (timer.due <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

test("a CI shell environment is not forwarded into the PTY", async () => {
  // The dashboard is frequently started from a CI/CD shell, which exports
  // `CI=true` for the *server*. Ink's `is-in-ci` probe reads it from the child's
  // environment and then prints each frame instead of repainting: the banner is
  // never erased, every later repaint begins with a fullscreen clear, and the
  // bottom-anchored prompt is redrawn below the logo — the operator sees the
  // banner "flash" while typing. The PTY is driven over a WebSocket by the
  // browser terminal, never by a CI runner, so the server must strip the marker.
  const fixture = server({ env: { PATH: "/usr/bin", CI: "true", CONTINUOUS_INTEGRATION: "1", NO_COLOR: "1" } });
  const socket = new Socket();
  await fixture.connect(socket, "");
  const env = fixture.spawnEnvs[0] ?? {};
  // `is-in-ci` matches on key PRESENCE (`key in env`), so an empty value would
  // still trip it — the keys have to be gone, not blanked.
  assert.equal("CI" in env, false);
  assert.equal("CONTINUOUS_INTEGRATION" in env, false);
  // Unrelated environment (the operator's colour policy among it) is inherited
  // untouched; only the CI markers are shell-only.
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NO_COLOR, "1");
});

test("two starts in flight for one key spawn exactly one PTY", async () => {
  // The startup path awaits the scope read, a thread round-trip and the saved
  // settings before it spawns, and `sessions` is only written at the very end.
  // Two sockets for one engagement key — a double `init()` in React StrictMode,
  // a reconnect racing the first connect, two tabs — therefore both found the
  // map empty and both reached the spawn. Each then registered its own Session
  // under the same key, so the earlier PTY was orphaned in the map's place:
  // nothing ever closed it, its WebSocket was never wired, and the operator's
  // terminal kept landing on a different process. The spawn re-checks the map.
  const scope = deferred<Buffer>();
  const fixture = server({ scope: scope.promise });
  const first = new Socket();
  const second = new Socket();
  const pending = [fixture.connect(first, ""), fixture.connect(second, "")];
  scope.resolve(Buffer.from("{}"));
  await Promise.all(pending);

  assert.equal(fixture.terms.length, 1);
  assert.equal(fixture.spawnEnvs.length, 1);
  // The socket that lost the race is handed the live session rather than left
  // dangling: it gets the threadId and the earlier one is told to stand down.
  assert.ok(second.messages.some((message) => message.includes("\"threadId\"")), "loser must be wired to the live session");
  assert.equal(first.closeCode, 4001);
});


for (const state of [2, 3]) {
  test(`socket state ${state} after scope read prevents startup`, async () => {
    const scope = deferred<Buffer>();
    const fixture = server({ scope: scope.promise });
    const socket = new Socket();
    const pending = fixture.connect(socket, "");
    socket.readyState = state;
    socket.emit("close");
    scope.resolve(Buffer.from("{}"));
    await pending;
    assert.deepEqual({ calls: fixture.calls, terms: fixture.terms }, { calls: [], terms: [] });
  });
}

test("disconnect during thread creation prevents persistence and PTY spawn", async () => {
  const entered = deferred<void>();
  const creation = deferred<Response>();
  const fixture = server({ fetch: async () => { entered.resolve(); return creation.promise; } });
  const socket = new Socket();
  const pending = fixture.connect(socket, "");
  await entered.promise;
  socket.close();
  creation.resolve(response(200));
  await pending;
  assert.deepEqual({ methods: fixture.calls.map((call) => call.method), terms: fixture.terms },
    { methods: ["POST"], terms: [] });
});

test("closed older startup cannot overwrite a reconnect session", async () => {
  const entered = deferred<void>();
  const creation = deferred<Response>();
  let creates = 0;
  const fixture = server({ fetch: async () => {
    if (++creates === 1) { entered.resolve(); return creation.promise; }
    return response(200, "reconnected");
  } });
  const oldSocket = new Socket();
  const pending = fixture.connect(oldSocket, "");
  await entered.promise;
  oldSocket.close();
  const currentSocket = new Socket();
  await fixture.connect(currentSocket, "");
  creation.resolve(response(200, "stale"));
  await pending;
  currentSocket.close();
  fixture.advance(60_000);
  assert.deepEqual(fixture.terms, [{ threadId: "reconnected", killed: true }]);
});

test("disconnect after startup retains the PTY until orphan expiry", async () => {
  const fixture = server();
  const socket = new Socket();
  await fixture.connect(socket, "");
  socket.close();
  fixture.advance(59_999);
  assert.equal(fixture.terms[0].killed, false);
  fixture.advance(1);
  assert.equal(fixture.terms[0].killed, true);
});

test("closed scope read cannot displace an already attached socket", async () => {
  const scope = deferred<Buffer>();
  const fixture = server({ scope: scope.promise });
  scope.resolve(Buffer.from("{}"));
  const attached = new Socket();
  await fixture.connect(attached, "");
  const stale = new Socket();
  const pending = fixture.connect(stale, "");
  stale.close();
  await pending;
  assert.equal(attached.readyState, Socket.OPEN);
});

test("a new PTY is seeded with the saved model policy", async () => {
  const fixture = server({
    settings: {
      globalModelOverride: "openai/gpt-5.5",
      modelOverrides: { soundwave: "auth/claude-sonnet-5" },
    },
  });
  const socket = new Socket();
  await fixture.connect(socket, "");
  assert.deepEqual(
    {
      global: fixture.spawnEnvs[0]?.DECEPTICON_RUN_MODEL_OVERRIDE,
      roles: JSON.parse(fixture.spawnEnvs[0]?.DECEPTICON_RUN_MODEL_OVERRIDES ?? "null"),
    },
    { global: "openai/gpt-5.5", roles: { soundwave: "auth/claude-sonnet-5" } },
  );
});

test("an unreachable settings API leaves the PTY on the deployment baseline", async () => {
  for (const settingsStatus of [401, 500]) {
    const fixture = server({ settingsStatus });
    const socket = new Socket();
    await fixture.connect(socket, "");
    assert.equal("DECEPTICON_RUN_MODEL_OVERRIDE" in (fixture.spawnEnvs[0] ?? {}), false);
    assert.equal("DECEPTICON_RUN_MODEL_OVERRIDES" in (fixture.spawnEnvs[0] ?? {}), false);
  }
});

test("a repaired spawn-helper is reported once at startup, before the server listens", async () => {
  const fixture = server({
    spawnHelper: { status: "repaired", path: "/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper" },
  });
  const socket = new Socket();
  await fixture.connect(socket, "");
  assert.deepEqual(fixture.logs.slice(0, 2), [
    `[terminal-server] node-pty spawn-helper was missing its execute bit — repaired: /app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`,
    `[terminal-server] Listening on ws://localhost:3003`,
  ]);
  assert.equal(fixture.logs.filter((line) => line.includes("spawn-helper")).length, 1);
  assert.deepEqual(fixture.errors, []);
});

test("an unusable spawn-helper is reported with the remedy, and the PTY failure names the file", async () => {
  const helperPath = "/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";
  const fixture = server({
    spawnHelper: {
      status: "unavailable",
      path: helperPath,
      reason: "not-executable",
      error: "EACCES: permission denied, chmod '/app/…/spawn-helper'",
    },
    spawn: () => { throw new Error("posix_spawnp failed."); },
  });
  const socket = new Socket();
  await fixture.connect(socket, "");
  assert.deepEqual(fixture.terms, []);
  assert.equal(socket.closeCode, 1011);
  const errors = socket.messages.filter((message) => message.startsWith("\r\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /posix_spawnp failed\./);
  assert.match(errors[0], new RegExp(helperPath.replace(/[/.]/g, "\\$&")));
  assert.match(errors[0], /chmod \+x/);
  assert.match(fixture.errors[0], /spawn-helper is not executable \(not-executable\)/);
});

test("an unrelated spawn failure is not blamed on the helper", async () => {
  const fixture = server({
    spawnHelper: { status: "not-needed" },
    spawn: () => { throw new Error("EACCES: permission denied, posix_spawn '/usr/bin/node'"); },
  });
  const socket = new Socket();
  await fixture.connect(socket, "");
  const errors = socket.messages.filter((message) => message.startsWith("\r\n"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /posix_spawn '\/usr\/bin\/node'/);
  assert.doesNotMatch(errors[0], /spawn-helper/);
  // The vm context has its own `Error`, so `err instanceof Error` is false there
  // and the server stringifies the object; that prefix is a harness artifact, not
  // server output.
  assert.deepEqual(fixture.errors,
    [`[terminal-server] PTY spawn failed: Error: EACCES: permission denied, posix_spawn '/usr/bin/node'`]);
});

test("the PTY loads tsx's default entry, which keeps the CLI's CommonJS JSON requires parseable", async () => {
  const fixture = server();
  const socket = new Socket();
  await fixture.connect(socket, "");
  const argv = fixture.spawnArgs[0] ?? [];
  // The args cross a vm realm boundary, so compare values rather than identity.
  assert.deepEqual([...argv.slice(0, 2)], ["--import", "tsx"]);
  // `--import tsx` loads the package's default entry; pin which file that is so
  // the probe below exercises what the PTY actually starts, not a sibling entry.
  const require = createRequire(import.meta.url);
  const entry = require.resolve("tsx");
  assert.match(entry, /loader\.mjs$/);

  // `tsx/esm` installs only the module hooks, and before tsx 4.22.2 the sync
  // hook rewrote *every* JSON module (`format: "json"`) to ESM source — even
  // the ones a CommonJS `require()` still parses as JSON. Ink's `cli-boxes`
  // does exactly that, so on Node 24.11/25.1 the CLI died with
  // `Unexpected token 'v', "var single"... is not valid JSON` before its first
  // frame. The default entry also installs the CJS hook, so run the same
  // specifier against a real `require('./x.json')` and require it to survive.
  const root = mkdtempSync(join(tmpdir(), "pty-loader-"));
  try {
    writeFileSync(join(root, "fixture.json"), '{"single":{"top":"-"},"n":2}');
    const stdout = execFileSync(
      process.execPath,
      ["--import", entry, "-e", "console.log(JSON.stringify(require('./fixture.json')))"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(stdout.trim(), '{"single":{"top":"-"},"n":2}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
