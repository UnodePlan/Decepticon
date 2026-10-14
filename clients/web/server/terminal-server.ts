#!/usr/bin/env node
/**
 * Terminal WebSocket Server — spawns Decepticon CLI in a PTY.
 *
 * Session-persistent architecture:
 *   PTY processes are keyed by engagement slug and survive WebSocket
 *   disconnects. When the browser reconnects (tab refresh, network blip,
 *   hotswap), it reattaches to the SAME PTY — no new CLI banner, no lost
 *   state, no [Reconnecting...] spam.
 *
 *   PTYs are only destroyed when:
 *     1. The CLI process itself exits (user typed Ctrl+C, engagement finished)
 *     2. No WebSocket reconnects within ORPHAN_TTL (60s) after disconnect
 *     3. The terminal server shuts down (SIGTERM)
 *
 *   Every new PTY is seeded with the dashboard's saved run settings
 *   (`src/lib/run-settings.ts` → the `DECEPTICON_RUN_*` vars), read over
 *   this container's own `/api/settings` endpoint immediately before the spawn,
 *   so a save made just before connecting is picked up. A running PTY is never
 *   mutated, so a saved change applies to the NEXT session — the boundary the
 *   settings page labels.
 *
 * Protocol (Server → Client):
 *   - JSON { type: "threadId", threadId: "..." }
 *   - JSON { type: "pong" }
 *   - JSON { type: "reattached", scrollback: "..." } — sent on reattach with recent output
 *   - Raw text — PTY stdout/stderr
 *
 * Protocol (Client → Server):
 *   - JSON { type: "resize", cols, rows }
 *   - JSON { type: "ping" }
 *   - Raw text — stdin for PTY
 */

import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { resolve, dirname } from "path";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SESSION_COOKIE_NAME, verifySession } from "../src/lib/session";
import { runSettingsEnv, type RunSettingsSnapshot } from "../src/lib/run-settings";
import { ensurePtySpawnHelper, type PtySpawnHelperResult } from "../src/lib/pty-spawn-helper";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.TERMINAL_PORT ?? "3003", 10);
const WEB_PORT = process.env.WEB_PORT ?? "3000";
const CLI_PATH = resolve(__dirname, "../../cli/src/index.tsx");
const LANGGRAPH_API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const ORPHAN_TTL = 60_000; // Kill orphaned PTYs after 60s with no WS
const SCROLLBACK_LIMIT = 50_000; // chars of recent output to buffer for reattach
const THREAD_VALIDATION_TIMEOUT_MS = 10_000; // Bound validation like thread creation.

const ALLOWED_ORIGINS = new Set(
  (process.env.TERMINAL_ALLOWED_ORIGINS ?? `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

// ── node-pty darwin helper ───────────────────────────────────────

/**
 * node-pty's darwin prebuilds ship `spawn-helper` with mode 0644, so the first
 * `pty.spawn` dies with a bare `posix_spawnp failed.` (details in
 * `src/lib/pty-spawn-helper.ts`). Repair the execute bit once, before the
 * socket is opened, and say so in the log — if the tree is read-only the line
 * names the exact path and the `chmod` to run, instead of leaving an operator
 * to decode the PTY error.
 */
function preparePtySpawnHelper(): PtySpawnHelperResult {
  const result = ensurePtySpawnHelper();
  if (result.status === "repaired") {
    console.log(`[terminal-server] node-pty spawn-helper was missing its execute bit — repaired: ${result.path}`);
  } else if (result.status === "unavailable") {
    console.error(
      `[terminal-server] node-pty spawn-helper is not executable (${result.reason}): ${result.path}. ` +
        `PTYs will fail with "posix_spawnp failed."; ${ptySpawnHelperRemedy(result)}.`,
    );
  }
  return result;
}

/**
 * The one thing an operator can act on: how to get this host's helper
 * executable again. `unresolved`/`missing` cannot be `chmod`-ed into existence —
 * only a working install can supply the binary.
 */
function ptySpawnHelperRemedy(result: Extract<PtySpawnHelperResult, { status: "unavailable" }>): string {
  if (result.reason === "missing" || result.reason === "unresolved") {
    return `reinstall the workspace dependencies (\`npm install\`) so node-pty's darwin prebuilt is present (${result.error})`;
  }
  return `restore the execute bit with \`chmod +x ${result.path}\` (${result.error})`;
}

const spawnHelper = preparePtySpawnHelper();

/**
 * Name the file behind node-pty's opaque darwin failure.
 *
 * Only the "helper is not executable" case gets a hint: that is the one this
 * server can diagnose but not always repair in place, and the one whose
 * node-pty message carries neither path nor errno. Any other spawn failure
 * (missing `node`, bad cwd, non-darwin host) keeps its own message instead of
 * being blamed on the helper.
 */
function ptySpawnFailureHint(message: string): string | null {
  if (!message.includes("posix_spawnp") || spawnHelper.status !== "unavailable") return null;
  return `node-pty spawn-helper is not executable (${spawnHelper.path}): ${ptySpawnHelperRemedy(spawnHelper)}`;
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[terminal-server] Listening on ws://localhost:${PORT}`);

// ── Session Pool ─────────────────────────────────────────────────

interface Session {
  key: string;
  term: pty.IPty;
  ws: WebSocket | null;         // currently-attached WS (null = orphaned)
  scrollback: string;           // ring buffer of recent output
  threadId: string;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;                // PTY exited
  exitCode: number | null;
}

const sessions = new Map<string, Session>();

function sessionKey(slug: string, assistant: string): string {
  return `${slug}:${assistant}`;
}

const PLAN_DOCUMENTS = ["roe.json", "threat-profile.json", "conops.json", "deconfliction.json", "contact.json", "data-handling.json", "abort.json", "cleanup.json"];

async function approvedScope(slug: string): Promise<{ target: string; type: string; redApproved: boolean } | null> {
  const root = join(process.env.WORKSPACE_PATH ?? "/workspace", slug);
  try {
    const roeBytes = await readFile(join(root, "plan", "roe.json"));
    const roe = JSON.parse(roeBytes.toString()) as { in_scope?: Array<{ target?: string; type?: string }>; authorization_reference?: string };
    const target = roe.in_scope?.[0]?.target;
    if (!target || !roe.authorization_reference?.trim()) return null;
    const marker = (await readFile(join(root, ".red-approved"), "utf-8").catch(() => "")).trim();
    const direct = `roe:${createHash("sha256").update(roeBytes).digest("hex")}`;
    const bundle = createHash("sha256");
    let bundleComplete = true;
    for (const filename of PLAN_DOCUMENTS) {
      try {
        bundle.update(filename).update("\0").update(await readFile(join(root, "plan", filename))).update("\0");
      } catch { bundleComplete = false; break; }
    }
    return { target, type: roe.in_scope?.[0]?.type ?? "", redApproved: marker === direct || (bundleComplete && marker === bundle.digest("hex")) };
  } catch { return null; }
}

function appendScrollback(session: Session, data: string): void {
  session.scrollback += data;
  if (session.scrollback.length > SCROLLBACK_LIMIT) {
    const trimmed = session.scrollback.slice(-SCROLLBACK_LIMIT);
    // Resume at a line boundary so replay never starts mid escape sequence,
    // which would mis-color or swallow output on the client after term.reset().
    const nl = trimmed.indexOf("\n");
    session.scrollback = nl >= 0 && nl < trimmed.length - 1 ? trimmed.slice(nl + 1) : trimmed;
  }
}

function destroySession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  if (session.orphanTimer) clearTimeout(session.orphanTimer);
  if (!session.dead) {
    try { session.term.kill(); } catch { /* already dead */ }
  }
  sessions.delete(key);
  console.log(`[terminal-server] Session ${key} destroyed`);
}

// ── Helpers ──────────────────────────────────────────────────────

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try { return ALLOWED_ORIGINS.has(new URL(origin).origin); } catch { return false; }
}

async function createThread(engagementId: string, agentId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${LANGGRAPH_API_URL}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: { engagement_id: engagementId, decepticon_assistant: agentId } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Thread create: ${res.status}`);
    const { thread_id: threadId } = await res.json() as { thread_id?: unknown };
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Thread create: missing thread ID");
    }
    return threadId;
  } finally {
    clearTimeout(timer);
  }
}

async function threadExists(threadId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THREAD_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${LANGGRAPH_API_URL}/threads/${encodeURIComponent(threadId)}`, {
      signal: controller.signal,
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Thread read: ${response.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hand a socket to the session that already owns the key, if there is one.
 * Returns false once the key is free (a dead session is reaped first) — then
 * the caller may spawn.
 */
function takeOver(key: string, ws: WebSocket): boolean {
  const session = sessions.get(key);
  if (session && !session.dead) {
    attachWs(ws, session);
    return true;
  }
  if (session) destroySession(key);
  return false;
}

/**
 * Decide what a freshly connected socket should be wired to, creating nothing
 * itself: the thread a brand-new session will run on, or an existing session.
 *
 * The decision has to be re-made after every awaited step. `sessions` is only
 * written once the PTY exists, so without these re-checks two connections for
 * one key — including the two a StrictMode mount opens — both reached the spawn
 * and each registered its own Session under the same key. The earlier PTY was
 * then orphaned in the map's place: never closed, never wired to a socket,
 * while every later reattach landed on whichever process registered last. The
 * terminal kept jumping between processes and typing went to a PTY nobody was
 * rendering. Exactly one live session per key.
 *
 * Returns `{ kind: "stop" }` when the socket is done — it was closed while a
 * step was in flight, or another connection won the key and this socket has
 * already been attached to the winner — and `{ kind: "spawn", threadId }` when
 * this socket owns the key: the thread was already reported to the client and
 * persisted, so the caller spawns the PTY straight away.
 */
async function resolveSession(
  ws: WebSocket, key: string, engagementId: string, agentId: string, requestedThreadId: string,
): Promise<{ kind: "spawn"; threadId: string } | { kind: "stop" }> {
  if (takeOver(key, ws)) return { kind: "stop" };

  // The client's own thread ID wins; validate it before creating anything.
  let threadId = requestedThreadId;
  if (threadId) {
    try {
      if (!(await threadExists(threadId))) threadId = "";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(ws, { type: "error", message: `Thread validation failed: ${message}` });
      ws.close(1011, "Thread validation failed");
      return { kind: "stop" };
    }
    if (ws.readyState !== WebSocket.OPEN) return { kind: "stop" };
  }

  // A connection that completed startup while this one was validating has
  // already spawned the PTY for this key — share it instead of doubling it.
  if (takeOver(key, ws)) return { kind: "stop" };

  if (!threadId) {
    try {
      threadId = await createThread(engagementId, agentId);
      console.log(`[terminal-server] Created thread: ${threadId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[terminal-server] Thread creation failed: ${msg}`);
      sendJson(ws, { type: "error", message: `Thread creation failed: ${msg}` });
      ws.close(1011, "Thread creation failed");
      return { kind: "stop" };
    }
    if (ws.readyState !== WebSocket.OPEN) return { kind: "stop" };
  }

  // A connection that spawned while the thread create was in flight owns the
  // session now: this socket shares it rather than spawning a second PTY.
  if (takeOver(key, ws)) return { kind: "stop" };

  // This socket owns the key: report the thread the PTY will run on now, so the
  // client learns it while the PTY paints. The caller spawns immediately after.
  if (threadId) {
    sendJson(ws, { type: "threadId", threadId });
    if (engagementId) persistThreadId(engagementId, threadId);
  }
  return { kind: "spawn", threadId };
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function persistThreadId(engagementId: string, threadId: string): void {
  const webUrl = `http://localhost:${process.env.PORT ?? 3000}`;
  // This process holds no browser session, so the dashboard API is called with
  // the in-container shared secret instead of a cookie.
  const internalToken = process.env.DECEPTICON_INTERNAL_API_TOKEN?.trim();
  fetch(`${webUrl}/api/engagements/${engagementId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(internalToken ? { "x-decepticon-internal-token": internalToken } : {}),
    },
    body: JSON.stringify({ threadId }),
  }).catch(() => {});
}

// ── Saved run settings ────────────────────────────────────────────

const SETTINGS_READ_TIMEOUT_MS = 3_000; // Bound the read; a slow API must not stall a PTY.

/**
 * Saved run settings, read from the dashboard's settings API before each spawn.
 *
 * The read goes through the public endpoint (with the shared internal token)
 * rather than importing `@/lib/system-settings-store`: the store module is
 * TSX-compiled by Next's loader and the settings route is the single place that
 * knows how a snapshot is assembled, so there is exactly one reader to keep in
 * step. A missing/unreachable API yields `{}` — the PTY then inherits the
 * deployment env baseline (an operator's `DECEPTICON_LLM_*` / `DECEPTICON_BUDGET__*`
 * / `DECEPTICON_MODEL_*`), and the dashboard's own GET is what reports the
 * failure, not this process.
 */
async function loadRunSettingsEnv(): Promise<Record<string, string>> {
  const webUrl = `http://localhost:${process.env.PORT ?? 3000}`;
  const internalToken = process.env.DECEPTICON_INTERNAL_API_TOKEN?.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS_READ_TIMEOUT_MS);
  try {
    const response = await fetch(`${webUrl}/api/settings`, {
      headers: internalToken ? { "x-decepticon-internal-token": internalToken } : {},
      signal: controller.signal,
    });
    if (!response.ok) return {};
    const snapshot = (await response.json()) as RunSettingsSnapshot;
    return runSettingsEnv(snapshot);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

// ── Connection Handler ───────────────────────────────────────────

/**
 * Browser sessions are validated against the signed session cookie. When no
 * session secret is configured there is no session system to check against
 * (unconfigured deployments fail closed in the Next.js proxy / login API), so
 * the check is a no-op exactly then.
 */
async function hasValidSession(cookieHeader: string | undefined): Promise<boolean> {
  const secret = process.env.DECEPTICON_SESSION_SECRET?.trim();
  if (!secret) return true;
  const token = cookieHeader
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  return (await verifySession(token, secret)) !== null;
}

wss.on("connection", async (ws: WebSocket, req) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    ws.close(1008, "Origin not allowed");
    return;
  }

  if (!(await hasValidSession(req.headers.cookie))) {
    ws.close(1008, "Unauthorized");
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const engagementId = url.searchParams.get("engagementId") ?? "";
  const engagementSlug = url.searchParams.get("engagementSlug") ?? "";
  const agentId = url.searchParams.get("agentId") ?? "soundwave";
  const targetType = url.searchParams.get("targetType") ?? "";
  const targetValue = url.searchParams.get("targetValue") ?? "";
  const authorizationConfirmed = url.searchParams.get("authorizationConfirmed") === "true";
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(engagementSlug)) {
    ws.close(1008, "Invalid engagementSlug");
    return;
  }

  if (!["soundwave", "decepticon", "blue_cell"].includes(agentId)) {
    ws.close(1008, "Unsupported run mode");
    return;
  }
  const scope = await approvedScope(engagementSlug);
  // A disconnect during startup has no session close handler yet.
  if (ws.readyState !== WebSocket.OPEN) return;
  if (agentId === "decepticon" && !scope?.redApproved) {
    ws.close(1008, "Red scope is not approved");
    return;
  }
  // ── Resolve what this socket is wired to ──
  // Reattach to a live session, join the thread a concurrent start is creating,
  // or take ownership of the key and spawn below. Nothing here can spawn twice
  // for one key.
  const key = sessionKey(engagementSlug, agentId);
  const resolution = await resolveSession(ws, key, engagementId, agentId, url.searchParams.get("threadId") ?? "");
  if (resolution.kind === "stop") return;
  const threadId = resolution.threadId;

  // Saved run settings → PTY env, read immediately before the spawn so a save
  // made just before connecting is picked up. An already-running session is
  // reattached inside `resolveSession`: it keeps the policy its process started
  // with, because a PTY is never re-spawned under a live key.
  const runSettings = await loadRunSettingsEnv();
  if (ws.readyState !== WebSocket.OPEN) return;

  // The settings read is awaited as well: a connection that spawned meanwhile
  // owns the key, so this socket shares its PTY instead of spawning a second.
  if (takeOver(key, ws)) return;

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...runSettings,
    // A CI/CD shell exports `CI=true` for the *server*; it is inherited by every
    // PTY unless removed, and it alone breaks the CLI: Ink's `is-in-ci` probe
    // short-circuits the renderer to "print each frame instead of repainting",
    // so the banner is written once and never erased, later repaints start with
    // a fullscreen `\x1b[2J\x1b[3J\x1b[H` clear, and the bottom-anchored
    // prompt/status block is redrawn below the logo instead of in place —
    // the screen keeps jumping back to the logo while keys are still read.
    // `is-in-ci` tests `key in env`, so the markers must be deleted, not blanked
    // (an empty value still counts). A PTY this server spawns is driven over a
    // WebSocket by the browser terminal, never by a CI runner. `NO_COLOR` is
    // deliberately left alone: measured on this spawn path it changes neither
    // the prompt nor the repaint cadence (only two `FORCE_COLOR` warnings go
    // away), and the operator's colour policy stays theirs. The CLI's own vars
    // below stay authoritative.
    TERM: "xterm-256color",
    FORCE_COLOR: "1",
    DECEPTICON_ASSISTANT_ID: agentId,
    DECEPTICON_WEB_TERMINAL: "true",
    DECEPTICON_ENGAGEMENT: engagementSlug,
    DECEPTICON_WORKSPACE_PATH: engagementSlug ? `/workspace/${engagementSlug}` : "/workspace",
    DECEPTICON_API_URL: LANGGRAPH_API_URL,
    DECEPTICON_TARGET_TYPE: scope?.type ?? targetType,
    DECEPTICON_TARGET: scope?.target ?? targetValue,
    DECEPTICON_AUTHORIZATION_CONFIRMED: scope ? "true" : authorizationConfirmed ? "true" : "false",
  };
  // See the note above: `is-in-ci` matches on key presence, so the CI markers
  // must be *removed* from the inherited environment rather than blanked.
  delete env.CI;
  delete env.CONTINUOUS_INTEGRATION;
  if (threadId) env.DECEPTICON_THREAD_ID = threadId;

  let term: pty.IPty;
  try {
    // `--import tsx` — never `tsx/esm`. tsx's ESM-only entry installs just the
    // module hooks, and before tsx 4.22.2 its sync hook rewrote *every* JSON
    // module to ESM (`format: "json"`), including the ones a CommonJS
    // `require()` still parses as JSON. On Node 24.11/25.1
    // `require('./boxes.json')` therefore threw `Unexpected token 'v', "var
    // single"... is not valid JSON` the moment Ink loaded cli-boxes, so every
    // PTY died before painting the first frame. The default entry loads the CJS
    // hook as well, which is what `require()` needs on every supported Node.
    term = pty.spawn("node", ["--import", "tsx", CLI_PATH], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: resolve(__dirname, "../.."),
      env,
    });
    console.log(`[terminal-server] PTY spawned: ${key} pid=${term.pid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[terminal-server] PTY spawn failed: ${msg}`);
    // node-pty collapses a failed exec of its darwin spawn-helper into the bare
    // "posix_spawnp failed." (pty.cc swallows the errno), so the operator's
    // terminal gets the file and the remedy next to the opaque message.
    const hint = ptySpawnFailureHint(msg);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n\x1b[31m[Error: ${msg}${hint ? ` — ${hint}` : ""}]\x1b[0m\r\n`);
    }
    ws.close(1011, "PTY spawn failed");
    return;
  }

  const newSession: Session = {
    key,
    term,
    ws,
    scrollback: "",
    threadId,
    orphanTimer: null,
    dead: false,
    exitCode: null,
  };
  sessions.set(key, newSession);

  // PTY → buffer + current WS
  term.onData((data: string) => {
    appendScrollback(newSession, data);
    if (newSession.ws?.readyState === WebSocket.OPEN) {
      newSession.ws.send(data);
    }
  });

  // PTY exit
  term.onExit(({ exitCode, signal }) => {
    console.log(`[terminal-server] PTY exited: ${key} pid=${term.pid} code=${exitCode} signal=${signal}`);
    newSession.dead = true;
    newSession.exitCode = exitCode;
    if (newSession.ws?.readyState === WebSocket.OPEN) {
      if (exitCode === 0) {
        newSession.ws.send(`\r\n\x1b[32m[Session completed]\x1b[0m\r\n`);
      } else {
        newSession.ws.send(`\r\n\x1b[33m[Process exited: code ${exitCode}${signal ? `, signal ${signal}` : ""}]\x1b[0m\r\n`);
      }
      newSession.ws.close(1000, "PTY exited");
    }
    // Don't destroy immediately — let reattach see the exit message. Guard on
    // session identity so a reconnect that respawns a fresh PTY under the same
    // key within the window isn't killed by this stale timer.
    setTimeout(() => {
      if (sessions.get(key) === newSession) destroySession(key);
    }, 5000);
  });

  wireWsToSession(ws, newSession);
});

// ── Wire a WebSocket to a Session ────────────────────────────────

/**
 * Point a socket at an existing session: cancel the orphan timer, take the
 * socket over from any live predecessor, replay what the operator missed, and
 * wire it. A reattach never respawns the PTY, so the process keeps the model
 * policy and environment it started with.
 */
function attachWs(ws: WebSocket, session: Session): void {
  console.log(`[terminal-server] Reattaching WS to existing session: ${session.key} (pid=${session.term.pid})`);

  if (session.orphanTimer) {
    clearTimeout(session.orphanTimer);
    session.orphanTimer = null;
  }

  // Detach the old WS if any. 4001 (app range) distinguishes "another connection
  // took over" from the genuine PTY-exit 1000 the client treats as session end.
  if (session.ws && session.ws !== ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.close(4001, "Replaced by new connection");
  }
  session.ws = ws;

  if (session.threadId) sendJson(ws, { type: "threadId", threadId: session.threadId });

  // Send scrollback so the client sees recent output without a full re-render.
  if (session.scrollback) {
    sendJson(ws, { type: "reattached" });
    ws.send(session.scrollback);
  }

  wireWsToSession(ws, session);
}

function wireWsToSession(ws: WebSocket, session: Session): void {
  ws.on("message", (raw: Buffer | string) => {
    const msg = raw.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "ping") {
        sendJson(ws, { type: "pong" });
        return;
      }
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        try {
          session.term.resize(
            Math.max(1, Math.min(500, parsed.cols)),
            Math.max(1, Math.min(200, parsed.rows)),
          );
        } catch { /* PTY may have exited */ }
        return;
      }
    } catch {
      // Not JSON — raw stdin
    }
    if (!session.dead) {
      try { session.term.write(msg); } catch { /* PTY exited */ }
    }
  });

  ws.on("close", () => {
    console.log(`[terminal-server] WS disconnected from session ${session.key}`);
    if (session.ws === ws) {
      session.ws = null;
      // Don't kill PTY — start orphan timer instead
      if (!session.dead) {
        session.orphanTimer = setTimeout(() => {
          if (!session.ws && !session.dead) {
            console.log(`[terminal-server] Orphan TTL expired for ${session.key} — destroying`);
            destroySession(session.key);
          }
        }, ORPHAN_TTL);
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[terminal-server] WS error on ${session.key}: ${err.message}`);
    // Don't kill PTY — let the close handler start orphan timer
  });
}

// ── Server lifecycle ─────────────────────────────────────────────

wss.on("error", (err) => {
  console.error(`[terminal-server] Server error: ${err.message}`);
});

function shutdown() {
  console.log(`[terminal-server] Shutting down, destroying ${sessions.size} sessions...`);
  for (const key of [...sessions.keys()]) destroySession(key);
  wss.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("uncaughtException", (err) => {
  console.error(`[terminal-server] Uncaught: ${err.message}`);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[terminal-server] Unhandled rejection:`, reason);
});
