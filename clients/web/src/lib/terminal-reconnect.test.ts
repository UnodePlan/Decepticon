/**
 * Consumer-visible WebSocket lifecycle for the embedded terminal.
 *
 * The banner used to be repainted once a second. `connectWs` unconditionally
 * closed the previous socket and immediately stored its replacement in
 * `wsRef`; the superseded socket then reported `1006` (replaced while still
 * CONNECTING) or `1005` (bare `close()`), and its `onclose` — which had no way
 * to tell "I was replaced" from "the link dropped" — scheduled a reconnect for
 * the *live* connection, while the replacement's `onopen` reset the retry
 * counter, so `MAX_RECONNECT_ATTEMPTS` never tripped. Every cycle re-ran
 * `term.reset()` + scrollback replay: the flicker the user sees.
 *
 * These tests pin what a user can observe, not the internal bookkeeping:
 * one socket at a time, a stale socket's frames never reach the live terminal,
 * keystrokes are delivered exactly once, and a healthy socket survives the
 * heartbeat.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string, options?: { url?: string }) => { window: Window & typeof globalThis };
};

interface Disposable {
  dispose(): void;
}

/** xterm stand-in: the test drives keystrokes through exactly the listeners the component registers. */
class FakeTerminal {
  static readonly instances: FakeTerminal[] = [];
  readonly cols = 80;
  readonly rows = 24;
  readonly written: string[] = [];
  resets = 0;
  listeners: Array<(data: string) => void> = [];

  constructor() {
    FakeTerminal.instances.push(this);
  }
  loadAddon(): void {}
  open(): void {}
  dispose(): void {}
  write(data: string): void {
    this.written.push(data);
  }
  reset(): void {
    this.resets++;
  }
  writeln(data: string): void {
    this.written.push(`${data}\n`);
  }
  onData(callback: (data: string) => void): Disposable {
    this.listeners = [...this.listeners, callback];
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((entry) => entry !== callback);
      },
    };
  }
  /** Test-side keystroke. */
  type(data: string): void {
    for (const listener of [...this.listeners]) listener(data);
  }
  /** Everything the PTY would have shown, ignoring control frames. */
  text(): string {
    return this.written.join("");
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }

  readonly sent: string[] = [];
  readonly closeCalls: Array<number | undefined> = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: URL | string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    assert.equal(this.readyState, FakeWebSocket.OPEN, "the client must never send on a closed socket");
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closeCalls.push(code);
    this.readyState = FakeWebSocket.CLOSING;
  }
  /** Server side: the handshake completes. */
  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  /** Transport: the socket closes, with the code the browser reports. */
  drop(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
  /** Server side: an inbound frame. */
  deliver(data: string): void {
    this.onmessage?.({ data });
  }
  get payloads(): string[] {
    return this.sent.filter((entry) => !entry.startsWith('{"type"'));
  }
}

interface Scheduler {
  setTimeout(callback: () => void): number;
  clearTimeout(id: unknown): void;
  setInterval(callback: () => void): number;
  clearInterval(id: unknown): void;
  pendingReconnects(): number;
  /** Fires every pending timeout once (scheduleReconnect's retry, the pong deadline). */
  runTimeouts(): void;
  /** Fires one heartbeat tick. */
  tickHeartbeat(): void;
}

interface Harness {
  dom: { window: Window & typeof globalThis };
  scheduler: Scheduler;
  errors: unknown[][];
  render(): Promise<void>;
  flush(): Promise<void>;
  /**
   * Drive one server/transport callback (handshake, inbound frame, close, timer
   * tick) the way the browser would. React state updates are only legal inside
   * `act`, so the trigger runs there and the render it causes is flushed before
   * the caller asserts.
   */
  event(trigger: () => void): Promise<void>;
  unmount(): Promise<void>;
  terminate(): void;
}

/**
 * Deterministic time: `setTimeout`/`setInterval` are captured so a test fires a
 * reconnect or a heartbeat on demand instead of waiting on the wall clock.
 */
function createScheduler(): Scheduler {
  let handle = 0;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  return {
    setTimeout: (callback: () => void): number => {
      timeouts.set(++handle, callback);
      return handle;
    },
    clearTimeout: (id: unknown): void => {
      timeouts.delete(id as number);
    },
    setInterval: (callback: () => void): number => {
      intervals.set(++handle, callback);
      return handle;
    },
    clearInterval: (id: unknown): void => {
      intervals.delete(id as number);
    },
    pendingReconnects: (): number => timeouts.size,
    /** Fires every pending timeout once (scheduleReconnect's retry, the pong deadline). */
    runTimeouts: (): void => {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const callback of pending) callback();
    },
    /** Fires one heartbeat tick. */
    tickHeartbeat: (): void => {
      for (const callback of [...intervals.values()]) callback();
    },
  };
}

const PROPERTIES: Record<string, unknown> = {
  engagementId: "owned",
  engagementSlug: "owned",
  targetType: "web_url",
  targetValue: "https://example.invalid",
  authorizationConfirmed: true,
};

function createHarness({ strict = false }: { strict?: boolean } = {}): Harness {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.test/engagements/owned/live",
  });
  const prior = new Map(
    ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

  FakeWebSocket.reset();
  FakeTerminal.instances.length = 0;
  const scheduler = createScheduler();
  const errors: unknown[][] = [];

  const fixtures: Record<string, unknown> = {
    "@/lib/browser-config": require("./browser-config.ts"),
    "@/lib/browser-config-context": {
      useBrowserConfig: () => ({ langGraphApiUrl: "http://localhost:2024", terminalWsUrl: "ws://localhost:3003" }),
    },
    "@/lib/utils": { cn: (...values: string[]) => values.join(" ") },
    "@/lib/i18n-context": { useI18n: () => ({ locale: "en", setLocale: () => {}, t: (key: string) => key }) },
    "@/lib/terminal-output-coalescer": require("./terminal-output-coalescer.ts"),
    "@xterm/addon-fit": { FitAddon: class {} },
    "xterm/css/xterm.css": {},
  };

  const source = readFileSync(new URL("../components/terminal/web-terminal.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const terminalModule = { exports: {} as { WebTerminal: React.ComponentType<Record<string, unknown>> } };
  vm.runInNewContext(compiled, {
    module: terminalModule,
    exports: terminalModule.exports,
    require: (name: string) => {
      if (name === "xterm") return { Terminal: FakeTerminal };
      return Object.hasOwn(fixtures, name) ? fixtures[name] : require(name);
    },
    window: dom.window,
    document: dom.window.document,
    URL,
    Promise,
    Error,
    JSON,
    console: {
      ...console,
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
    WebSocket: FakeWebSocket,
    ResizeObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });

  const element = React.createElement(
    terminalModule.exports.WebTerminal,
    PROPERTIES,
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  return {
    dom,
    scheduler,
    errors,
    async render(): Promise<void> {
      await act(async () => {
        root.render(strict ? React.createElement(React.StrictMode, null, element) : element);
      });
    },
    async flush(): Promise<void> {
      await act(async () => {});
    },
    async event(trigger: () => void): Promise<void> {
      await act(async () => {
        trigger();
      });
    },
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount();
      });
    },
    terminate(): void {
      dom.window.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("a React remount while xterm is still loading opens exactly one socket", async () => {
  const harness = createHarness({ strict: true });
  try {
    await harness.render();
    await harness.flush();
    assert.equal(FakeTerminal.instances.length, 1, "the suspended first init must not allocate a second terminal");
    assert.equal(FakeWebSocket.instances.length, 1, "the suspended first init must not open a second socket");
    assert.equal(harness.scheduler.pendingReconnects(), 0, "replacing a socket is not a disconnect");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.terminate();
  }
});

test("a stale socket's frames and close events never reach the live connection", async () => {
  const harness = createHarness();
  try {
    await harness.render();
    const [stale] = FakeWebSocket.instances;
    const terminal = FakeTerminal.instances[0];

    await harness.event(() => stale.accept());
    await harness.event(() => stale.drop(1006));
    assert.equal(harness.scheduler.pendingReconnects(), 1, "a silently dropped link schedules exactly one retry");
    await harness.event(() => harness.scheduler.runTimeouts());

    const live = FakeWebSocket.instances[1];
    assert.ok(live, "the retry opens a replacement socket");
    await harness.event(() => live.accept());
    assert.equal(FakeWebSocket.instances.length, 2, "one retry must not cascade into more sockets");

    const writtenBefore = terminal.written.length;
    await harness.event(() => {
      stale.deliver("STALE-SCROLLBACK-REPLAY");
      stale.drop(1005);
    });
    assert.equal(terminal.written.length, writtenBefore, "a replaced socket must not write to the live terminal");
    assert.equal(terminal.resets, 0, "a replaced socket must not reset the live terminal");
    assert.equal(
      harness.scheduler.pendingReconnects(),
      0,
      "the stale close that follows a reconnect must not schedule another one",
    );

    await harness.event(() => {
      live.deliver('{"type":"reattached"}');
      live.deliver("LIVE-REPLAY");
    });
    assert.ok(terminal.text().includes("LIVE-REPLAY"), "the live socket still drives the terminal");
    assert.equal(terminal.resets, 1, "the current socket's reattach resets once, not once per stale event");

    terminal.type("z");
    assert.deepEqual(live.payloads, ["z"], "a keystroke reaches the live PTY exactly once");
    assert.deepEqual(stale.payloads, [], "a keystroke never reaches the superseded socket");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.terminate();
  }
});

test("a reconnect keeps the single input listener", async () => {
  const harness = createHarness();
  try {
    await harness.render();
    const terminal = FakeTerminal.instances[0];
    await harness.event(() => FakeWebSocket.instances[0].accept());
    await harness.event(() => FakeWebSocket.instances[0].drop(1006));
    await harness.event(() => harness.scheduler.runTimeouts());
    await harness.event(() => FakeWebSocket.instances[1].accept());

    assert.equal(terminal.listeners.length, 1, "every reconnect must dispose the previous onData listener");
    terminal.type("a");
    terminal.type("b");
    assert.deepEqual(FakeWebSocket.instances[1].payloads, ["a", "b"], "each keystroke is sent once, in order");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.terminate();
  }
});

test("the heartbeat leaves a responsive socket alone and drops a silent one", async () => {
  const harness = createHarness();
  try {
    await harness.render();
    const healthy = FakeWebSocket.instances[0];
    await harness.event(() => healthy.accept());

    await harness.event(() => harness.scheduler.tickHeartbeat());
    assert.ok(healthy.sent.includes('{"type":"ping"}'), "the heartbeat pings an open socket");
    await harness.event(() => healthy.deliver('{"type":"pong"}'));
    await harness.event(() => harness.scheduler.runTimeouts());
    assert.deepEqual(healthy.closeCalls, [], "a socket that answered the ping must not be closed");
    assert.equal(FakeWebSocket.instances.length, 1, "a healthy socket is never reconnected");

    await harness.event(() => harness.scheduler.tickHeartbeat());
    await harness.event(() => harness.scheduler.runTimeouts());
    assert.equal(healthy.closeCalls.length, 1, "a socket that never answers is closed so reconnect can take over");
    assert.equal(healthy.readyState, FakeWebSocket.CLOSING);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.terminate();
  }
});

test("unmount closes the socket without scheduling a retry", async () => {
  const harness = createHarness();
  try {
    await harness.render();
    const socket = FakeWebSocket.instances[0];
    await harness.event(() => socket.accept());

    await harness.unmount();
    await harness.event(() => socket.drop(1006));
    assert.equal(harness.scheduler.pendingReconnects(), 0, "a teardown must not resurrect the connection");
    assert.equal(FakeWebSocket.instances.length, 1, "no socket may be opened after unmount");
    assert.deepEqual(socket.closeCalls, [undefined], "teardown closes the transport once");
  } finally {
    harness.terminate();
    FakeWebSocket.reset();
  }
});
