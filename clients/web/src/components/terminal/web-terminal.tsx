"use client";

/**
 * WebTerminal — xterm.js terminal embedding the Decepticon CLI.
 *
 * Connects to the standalone terminal WebSocket server which spawns
 * the CLI in a PTY. Reports the thread ID back to the parent via callback.
 *
 * Reconnection strategy:
 * - Silent reconnect with exponential backoff (1s → 2s → 4s, cap 4s)
 * - No terminal spam during reconnect — only a single status line
 * - Status bar shows connection state at all times
 * - After successful reconnect, clears the status message
 * - After 15 failed attempts, stops and offers manual retry
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { Terminal } from "xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { cn } from "@/lib/utils";
import { terminalWebSocketUrl } from "@/lib/browser-config";
import { useBrowserConfig } from "@/lib/browser-config-context";
import { useI18n } from "@/lib/i18n-context";
import type { TranslationKey } from "@/lib/i18n";
import { TerminalWriteCoalescer, type TimerHandle } from "@/lib/terminal-output-coalescer";

const MAX_RECONNECT_DELAY = 4000;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_ATTEMPTS = 15;

/**
 * Smallest pane area worth fitting the PTY to. A drawer collapse animates the
 * container width to 0, which leaves the padding (16px) non-zero for several
 * frames; fitting there clamps the terminal to the 2-column minimum, resizes
 * the PTY and makes the CLI reflow its whole frame twice (on collapse and
 * again on expand). Skipping the fit until the pane is usable leaves the PTY
 * untouched; the observer fires again when it regrows.
 */
const MIN_FIT_WIDTH_PX = 24;
const MIN_FIT_HEIGHT_PX = 24;

type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

/**
 * Fit only when the pane actually has a usable area.
 *
 * `clientWidth` is not enough: this container keeps 8px padding, so a
 * collapse/expand animation (width 400px → 0 → 400px) leaves ~16px of usable
 * width for several frames. Fitting there clamps the terminal to xterm's
 * 2-column minimum, which resizes the PTY and forces the CLI to reflow its
 * entire frame — twice, once on collapse and again on expand — for a pane the
 * operator is not looking at. The terminal surface rect is the honest measure;
 * when it is too small we leave the PTY size alone and the resize observer
 * fires again once the pane regrows.
 */
function fitPaneIfUsable(container: HTMLElement | null, term: Terminal | null, fit: FitAddon | null): boolean {
  const surface = term?.element ?? container;
  if (!surface || !surface.isConnected) return false;
  const rect = surface.getBoundingClientRect();
  if (rect.width < MIN_FIT_WIDTH_PX || rect.height < MIN_FIT_HEIGHT_PX) return false;
  // The addon is injected (and stubbed by the lifecycle tests); only call a real one.
  if (typeof fit?.fit !== "function") return false;
  fit.fit();
  return true;
}

/**
 * Strip parser-hostile bytes before writing to xterm.
 *
 * The PTY occasionally emits a lone ``\x7f`` (DEL) while the parser is in
 * ground state. xterm.js' VT parser then fires
 * ``Parsing error code=127`` for every offending byte, flooding the dev
 * console with thousands of identical errors after the agent banner.
 * DEL has no defined semantic in modern terminals; lone NUL is similarly
 * spurious. Dropping both removes the noise without losing real output.
 */
function sanitizeTermBytes(s: string): string {
  if (!s) return s;
  return s.replace(/[\x00\x7f]/g, "");
}

interface WebTerminalProps {
  engagementId: string;
  engagementSlug: string;
  targetType: string;
  targetValue: string;
  authorizationConfirmed: boolean;
  agentId?: string;
  threadId?: string;
  className?: string;
  onThreadId?: (threadId: string) => void;
}

export function WebTerminal({
  engagementId,
  engagementSlug,
  targetType,
  targetValue,
  authorizationConfirmed,
  agentId = "soundwave",
  threadId,
  className,
  onThreadId,
}: WebTerminalProps): React.ReactNode {
  const { t } = useI18n();
  const config = useBrowserConfig();
  const terminalEndpointRef = useRef(config.terminalWsUrl);
  terminalEndpointRef.current = config.terminalWsUrl;
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState, setConnState] = useState<ConnectionState>("connecting");

  const engagementIdRef = useRef(engagementId);
  engagementIdRef.current = engagementId;
  const engagementSlugRef = useRef(engagementSlug);
  engagementSlugRef.current = engagementSlug;
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const targetTypeRef = useRef(targetType);
  targetTypeRef.current = targetType;
  const targetValueRef = useRef(targetValue);
  targetValueRef.current = targetValue;
  const authorizationConfirmedRef = useRef(authorizationConfirmed);
  authorizationConfirmedRef.current = authorizationConfirmed;
  const onThreadIdRef = useRef(onThreadId);
  onThreadIdRef.current = onThreadId;

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const disposedRef = useRef(false);
  // Bumped by every effect start and teardown. `init()` suspends on the dynamic
  // `xterm` imports; a StrictMode remount runs teardown + effect again while the
  // first `init()` is still awaiting, and that resumed call used to see
  // `disposedRef` reset to `false` and allocate a second terminal + socket.
  const initGenerationRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<TimerHandle | null>(null);
  const coalescerRef = useRef<TerminalWriteCoalescer | null>(null);
  // Last PTY size we told the server about; the resize observer only sends a
  // resize when the fitted grid actually changed.
  const lastColsRef = useRef(0);
  const lastRowsRef = useRef(0);
  // Track whether we've shown the reconnecting message (to avoid spam)
  const reconnectMsgShownRef = useRef(false);
  // True between sending a ping and receiving the next inbound frame; the
  // pong-timeout only force-closes the socket while this is still set.
  const awaitingPongRef = useRef(false);
  // Track the onData listener for manual retry so we can dispose it
  const retryListenerRef = useRef<{ dispose: () => void } | null>(null);
  // Track the main onData listener so we can dispose it on reconnect
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const cleanup = useCallback(() => {
    disposedRef.current = true;
    // Invalidates an `init()` still suspended on the xterm imports.
    initGenerationRef.current += 1;
    coalescerRef.current?.drop();
    coalescerRef.current = null;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = null;
    retryListenerRef.current?.dispose();
    retryListenerRef.current = null;
    onDataDisposableRef.current?.dispose();
    onDataDisposableRef.current = null;
    resizeObserverRef.current?.disconnect();
    wsRef.current?.close();
    termRef.current?.dispose();
    wsRef.current = null;
    termRef.current = null;
    fitRef.current = null;
  }, []);

  const connectWs = useCallback(() => {
    if (disposedRef.current) return;
    const term = termRef.current;
    if (!term) return;

    // A connect is already live or hand-shaking. Replacing it here is what
    // started the reconnect loop: the superseded socket's `onclose` cannot tell
    // "I was replaced" from "the link dropped", so it scheduled another
    // reconnect, `onopen` reset the attempt counter, and the cycle repeated
    // once per second forever. One connection at a time; `scheduleReconnect`
    // clears its timer before the retry lands, so this never cancels a pending
    // retry that still owes us a socket.
    const currentReadyState = wsRef.current?.readyState;
    if (currentReadyState === WebSocket.CONNECTING || currentReadyState === WebSocket.OPEN) return;

    // Landing a connect cancels the timer that asked for it, so no second
    // socket is created for the same retry.
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Dispose any pending manual-retry listener
    retryListenerRef.current?.dispose();
    retryListenerRef.current = null;

    const eid = engagementIdRef.current;
    const slug = engagementSlugRef.current;
    const aid = agentIdRef.current;
    const tid = threadIdRef.current;
    const targetType = targetTypeRef.current;
    const targetValue = targetValueRef.current;
    const authorizationConfirmed = authorizationConfirmedRef.current;

    const wsUrl = terminalWebSocketUrl(window.location, terminalEndpointRef.current);
    wsUrl.searchParams.set("engagementId", eid);
    wsUrl.searchParams.set("engagementSlug", slug);
    wsUrl.searchParams.set("agentId", aid);
    wsUrl.searchParams.set("targetType", targetType);
    wsUrl.searchParams.set("targetValue", targetValue);
    wsUrl.searchParams.set("authorizationConfirmed", String(authorizationConfirmed));
    if (tid) wsUrl.searchParams.set("threadId", tid);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setConnState("connected");
      reconnectAttemptRef.current = 0;
      reconnectMsgShownRef.current = false;
      // Silent reconnect — no terminal output. If the server reattaches us
      // to an existing session, the scrollback replay handles visual continuity.
      if (term.cols > 0 && term.rows > 0) {
        lastColsRef.current = term.cols;
        lastRowsRef.current = term.rows;
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      awaitingPongRef.current = false;
      const data = typeof event.data === "string" ? event.data : "";
      if (data.startsWith("{")) {
        try {
          const msg = JSON.parse(data);
          // Filter ALL control messages — never write JSON frames to the terminal
          if (msg.type === "threadId" && msg.threadId) {
            onThreadIdRef.current?.(msg.threadId);
            return;
          }
          if (msg.type === "pong" || msg.type === "error" || msg.type === "ping") {
            return; // Control message — consume silently
          }
          if (msg.type === "reattached") {
            // Server reattached us to an existing PTY — full reset then
            // scrollback replay arrives as raw text right after this message.
            // Buffered pre-reset output is invalid now; drop it so the replay
            // is not drawn over by stale frames.
            coalescerRef.current?.drop();
            term.reset();
            return;
          }
        } catch {
          // Not valid JSON — pass through as terminal output
        }
      }
      coalescerRef.current?.push(sanitizeTermBytes(data));
    };

    ws.onclose = (ev) => {
      // A superseded socket keeps firing: `cleanup()` closing the transport on
      // unmount, or any replacement. Ignoring its events here is what keeps a
      // stale close from scheduling a reconnect for the live connection.
      if (disposedRef.current || wsRef.current !== ws) return;
      wsRef.current = null;

      if (ev.code === 4001) {
        // Server handed this session to another connection (e.g. a second tab).
        // Go quiet without the "session ended" banner and without reconnecting,
        // which would only ping-pong the session back and forth.
        setConnState("disconnected");
        return;
      }

      if (ev.code === 1000) {
        // Clean close — process exited normally
        setConnState("disconnected");
        coalescerRef.current?.flush();
        term.writeln("\r\n\x1b[90m[Session ended. Press Enter to start a new session.]\x1b[0m");
        const disposable = term.onData(() => {
          disposable.dispose();
          reconnectAttemptRef.current = 0;
          reconnectMsgShownRef.current = false;
          connectWs();
        });
        retryListenerRef.current = disposable;
        return;
      }

      // Abnormal close — reconnect silently
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (disposedRef.current || wsRef.current !== ws) return;
      // onerror always fires before onclose — just update the indicator
      setConnState("reconnecting");
    };

    // Forward input — dispose previous listener to prevent duplicates on reconnect
    onDataDisposableRef.current?.dispose();
    onDataDisposableRef.current = term.onData((data: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (disposedRef.current) return;

    const attempt = reconnectAttemptRef.current;

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setConnState("error");
      const term = termRef.current;
      if (term) {
        coalescerRef.current?.flush();
        term.writeln("\r\n\x1b[31m[Connection failed. Press Enter to retry.]\x1b[0m");
        reconnectMsgShownRef.current = false;
        const disposable = term.onData(() => {
          disposable.dispose();
          reconnectAttemptRef.current = 0;
          connectWs();
        });
        retryListenerRef.current = disposable;
      }
      return;
    }

    // Show ONE reconnecting message on the first attempt only
    // No terminal output during reconnect — status bar shows state.
    // The server's session persistence means the PTY is still alive;
    // on reattach the scrollback replays seamlessly.
    reconnectMsgShownRef.current = true;

    setConnState("reconnecting");
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
    reconnectAttemptRef.current = attempt + 1;

    reconnectTimerRef.current = setTimeout(() => {
      if (!disposedRef.current) connectWs();
    }, delay);
  }, [connectWs]);

  // Initialize terminal + first connection
  const init = useCallback(async (generation: number) => {
    const container = containerRef.current;
    if (!container || disposedRef.current) return;

    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("xterm/css/xterm.css");

      // The awaits above suspend: a remount that started after this call bumped
      // the generation. `disposedRef` alone cannot reject this stale call,
      // because the remount's effect resets it to `false` before the imports
      // resolve — which is how one mount used to allocate two terminals and two
      // sockets, the second one closing the first mid-handshake.
      if (generation !== initGenerationRef.current) return;
      if (disposedRef.current || containerRef.current !== container) return;

      if (termRef.current) {
        // Already initialized — just reconnect WS
        connectWs();
        return;
      }

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'IBM Plex Mono', 'Fira Code', monospace",
        theme: {
          background: "#0a0e14",
          foreground: "#d4d4d4",
          cursor: "#faa32c",
          selectionBackground: "#264f78",
          black: "#1e1e1e",
          red: "#f44747",
          green: "#6a9955",
          yellow: "#d7ba7d",
          blue: "#569cd6",
          magenta: "#c586c0",
          cyan: "#4ec9b0",
          white: "#d4d4d4",
          brightBlack: "#808080",
          brightRed: "#f44747",
          brightGreen: "#6a9955",
          brightYellow: "#d7ba7d",
          brightBlue: "#569cd6",
          brightMagenta: "#c586c0",
          brightCyan: "#4ec9b0",
          brightWhite: "#ffffff",
        },
        allowTransparency: true,
        scrollback: 10000,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fitPaneIfUsable(container, term, fit);

      termRef.current = term;
      fitRef.current = fit;

      // rAF comes from the terminal's own document, not the module global: the
      // component renders inside the host window while the module may have been
      // loaded in another realm. Absent rAF (jsdom without pretendToBeVisual)
      // means no frame scheduling at all — push() then writes straight through.
      const host = container.ownerDocument.defaultView;
      const scheduleFrame =
        typeof host?.requestAnimationFrame === "function" ? host.requestAnimationFrame.bind(host) : null;
      const cancelFrame =
        typeof host?.cancelAnimationFrame === "function" ? host.cancelAnimationFrame.bind(host) : null;
      coalescerRef.current = new TerminalWriteCoalescer(
        (data) => {
          if (termRef.current === term) term.write(data);
        },
        scheduleFrame,
        cancelFrame,
      );

      // Resize observer
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          resizeTimerRef.current = null;
          const t = termRef.current;
          if (!t || t !== term) return;
          try {
            // A collapsed/hidden pane is not worth a PTY resize: the CLI would
            // reflow to the 2-column minimum and repaint, then reflow back when
            // the pane returns. Leave the PTY size alone and re-fit on regrow.
            if (!fitPaneIfUsable(containerRef.current, t, fitRef.current)) return;
            // fit() is a no-op when the dimensions already match, so only a real
            // change is worth a round-trip that makes the CLI reflow.
            if (t.cols === lastColsRef.current && t.rows === lastRowsRef.current) return;
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN && t.cols > 0 && t.rows > 0) {
              lastColsRef.current = t.cols;
              lastRowsRef.current = t.rows;
              ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
            }
          } catch {
            // ignore
          }
        }, 150);
      });
      resizeObserver.observe(container);
      resizeObserverRef.current = resizeObserver;

      // Connect
      connectWs();
    } catch (err) {
      setConnState("error");
      console.error("[WebTerminal] Init failed:", err);
    }
  }, [connectWs]);

  useEffect(() => {
    disposedRef.current = false;
    void init(++initGenerationRef.current);
    return cleanup;
  }, [init, cleanup]);

  // ── Heartbeat: detect silently-dead sockets ──────────────────────
  // Ping every 15s. A live socket answers with a pong (or is already
  // streaming PTY output); both clear awaitingPongRef via onmessage. Only when
  // nothing came back within PONG_TIMEOUT is the socket half-open — close it
  // and let reconnect take over. Pongs are filtered in onmessage.
  useEffect(() => {
    const PING_INTERVAL = 15000;
    const PONG_TIMEOUT = 5000;
    let pongTimer: ReturnType<typeof setTimeout>;

    const pingTimer = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        awaitingPongRef.current = true;
        ws.send(JSON.stringify({ type: "ping" }));
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          if (awaitingPongRef.current && wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }, PONG_TIMEOUT);
      } catch {
        ws.close();
      }
    }, PING_INTERVAL);

    return () => {
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
    };
  }, [connState]);

  // ── Visibility: reconnect when tab becomes visible ───────────────
  // Browsers throttle/kill WS in background tabs. Reconnect on focus.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        const ws = wsRef.current;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          reconnectAttemptRef.current = 0;
          reconnectMsgShownRef.current = false;
          connectWs();
        }
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [connectWs]);

  // ── Network: reconnect when browser comes back online ────────────
  useEffect(() => {
    const handler = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectAttemptRef.current = 0;
        reconnectMsgShownRef.current = false;
        connectWs();
      }
    };
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [connectWs]);

  const statusColor: Record<ConnectionState, string> = {
    connecting: "bg-amber-400",
    connected: "bg-emerald-400",
    reconnecting: "bg-amber-400 animate-pulse",
    disconnected: "bg-zinc-500",
    error: "bg-red-400",
  };

  const statusLabel: Record<ConnectionState, TranslationKey> = {
    connecting: "terminal.connecting",
    connected: "terminal.connected",
    reconnecting: "terminal.reconnecting",
    disconnected: "terminal.disconnected",
    error: "terminal.error",
  };

  return (
    <div className={cn("relative flex flex-col", className)}>
      {/* Status bar */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] bg-[#0a0e14] px-3 py-1.5">
        <div className={cn("h-2 w-2 rounded-full", statusColor[connState])} />
        <span className="text-[11px] text-zinc-500">{t(statusLabel[connState])}</span>
        <span className="flex-1" />
        <span className="text-[10px] font-mono text-zinc-600">{engagementSlug}</span>
      </div>
      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{
          backgroundColor: "#0a0e14",
          padding: "8px",
          minHeight: 0,
        }}
      />
    </div>
  );
}
