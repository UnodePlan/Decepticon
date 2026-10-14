/**
 * Consumer-visible output path of the embedded terminal.
 *
 * A chatty agent emits its Ink repaint as many small WebSocket messages. Each
 * one used to be handed straight to `term.write()`, which made xterm repeat its
 * write/render bookkeeping per fragment (measured in Chromium: 1440 writes and
 * 8142 DOM mutations for 180 frames of 8 fragments). The component now batches
 * fragments that arrive within one animation frame into a single write.
 *
 * These tests pin what a user can observe about that batching: order and bytes
 * are preserved, the batch is always bounded (a frame callback and a deadline
 * timer), no output is lost on close, and stale bytes buffered before a
 * reattach reset are dropped rather than replayed over the reset.
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

/** xterm stand-in recording exactly what would have been written. */
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
    return { dispose: () => { this.listeners = this.listeners.filter((entry) => entry !== callback); } };
  }
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

  readonly sent: string[] = [];
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
  close(): void {
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
}

const PROPERTIES: Record<string, unknown> = {
  engagementId: "owned",
  engagementSlug: "owned",
  targetType: "web_url",
  targetValue: "https://example.invalid",
  authorizationConfirmed: true,
};

interface Harness {
  window: Window & typeof globalThis;
  /**
   * Waits past the coalescer's flush deadline. The extracted module runs in the
   * Node realm and uses real timers, so a throttled frame is simulated by simply
   * not painting and letting the deadline elapse.
   */
  waitForDeadline(): Promise<void>;
  /** Runs every callback the component scheduled through rAF, as a paint would. */
  paint(): void;
  /** Number of frame callbacks waiting to run. */
  pendingFrames(): number;
  terminal(): FakeTerminal;
  socket(): FakeWebSocket;
  /** Drives one server/transport callback the way the browser would, inside `act`. */
  event(trigger: () => void): Promise<void>;
  terminate(): Promise<void>;
}

async function mountHarness(): Promise<Harness> {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.test/engagements/owned/live",
  });
  const frameCallbacks: Array<() => void> = [];
  let handle = 0;
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    frameCallbacks.push(() => callback(0));
    return ++handle;
  };
  dom.window.cancelAnimationFrame = (): void => {
    frameCallbacks.length = 0;
  };

  const prior = new Map(
    ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

  FakeWebSocket.instances.length = 0;
  FakeTerminal.instances.length = 0;

  const fixtures: Record<string, unknown> = {
    "@/lib/browser-config": require("./browser-config.ts"),
    "@/lib/browser-config-context": {
      useBrowserConfig: () => ({ langGraphApiUrl: "http://localhost:2024", terminalWsUrl: "ws://localhost:3003" }),
    },
    "@/lib/utils": { cn: (...values: string[]) => values.join(" ") },
    "@/lib/i18n-context": { useI18n: () => ({ locale: "en", setLocale: () => {}, t: (key: string) => key }) },
    // The real coalescer, not a copy: this is the behaviour under test, and it
    // runs in the same injected-timer/jsdom world as the component.
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
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    WebSocket: FakeWebSocket,
    ResizeObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });

  const root = createRoot(dom.window.document.getElementById("root")!);

  const harness: Harness = {
    window: dom.window,
    waitForDeadline: async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await act(async () => {});
    },
    paint: (): void => {
      for (const callback of frameCallbacks.splice(0)) callback();
    },
    pendingFrames: (): number => frameCallbacks.length,
    terminal: (): FakeTerminal => {
      const [terminal] = FakeTerminal.instances;
      assert.ok(terminal, "the component allocated a terminal");
      return terminal;
    },
    socket: (): FakeWebSocket => {
      const [socket] = FakeWebSocket.instances;
      assert.ok(socket, "the component opened a socket");
      return socket;
    },
    event: async (trigger: () => void): Promise<void> => {
      await act(async () => {
        trigger();
      });
    },
    terminate: async (): Promise<void> => {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };

  await act(async () => {
    root.render(React.createElement(terminalModule.exports.WebTerminal, PROPERTIES));
  });
  await act(async () => {});
  await act(async () => {
    harness.socket().accept();
  });
  return harness;
}

test("output arriving within one frame is written once, in order, without loss", async () => {
  const harness = await mountHarness();
  try {
    const terminal = harness.terminal();
    const socket = harness.socket();
    const fragments = ["\x1b[2Kalpha", "beta", "gamma", "delta"];

    const before = terminal.written.length;
    await harness.event(() => {
      for (const fragment of fragments) socket.deliver(fragment);
    });
    assert.equal(terminal.written.length, before, "nothing is written before the frame is painted");
    assert.equal(harness.pendingFrames(), 1, "one frame callback covers the whole batch");

    harness.paint();
    assert.equal(terminal.written.length, before + 1, "the batch collapses into a single write");
    assert.equal(terminal.written[before], fragments.join(""), "bytes and their order survive batching");

    // A second frame batches independently: the buffer never grows unbounded.
    await harness.event(() => {
      socket.deliver("e1");
      socket.deliver("e2");
    });
    harness.paint();
    assert.equal(terminal.written[before + 1], "e1e2", "each frame flushes its own fragment set");

    // Input still reaches the PTY untouched while a batch is pending.
    await harness.event(() => socket.deliver("pending"));
    for (const listener of terminal.listeners) listener("z");
    assert.deepEqual(socket.sent.filter((entry) => entry === "z"), ["z"], "a keystroke is sent once while output is buffered");
  } finally {
    await harness.terminate();
  }
});

test("a throttled frame cannot hold output past the flush deadline", async () => {
  const harness = await mountHarness();
  try {
    const terminal = harness.terminal();
    await harness.event(() => harness.socket().deliver("late-frame"));
    const before = terminal.written.length;
    assert.equal(terminal.written.length, before, "output waits for a flush opportunity");

    // A background tab may never paint; the deadline timer must still flush.
    await harness.waitForDeadline();
    assert.equal(terminal.written.length, before + 1, "the deadline flushes what the frame did not");
    assert.equal(terminal.written[before], "late-frame");
  } finally {
    await harness.terminate();
  }
});

test("a clean close flushes buffered output before the session banner", async () => {
  const harness = await mountHarness();
  try {
    const terminal = harness.terminal();
    const socket = harness.socket();
    await harness.event(() => socket.deliver("tail"));
    await harness.event(() => socket.drop(1000));

    const text = terminal.text();
    assert.ok(text.includes("tail\r\n\x1b[90m[Session ended."), "buffered output precedes the banner");
    assert.ok(text.endsWith("[Session ended. Press Enter to start a new session.]\x1b[0m\n"), "the banner stays last");
  } finally {
    await harness.terminate();
  }
});

test("a reattach drops bytes buffered before the reset instead of replaying them", async () => {
  const harness = await mountHarness();
  try {
    const terminal = harness.terminal();
    const socket = harness.socket();
    await harness.event(() => socket.deliver("stale-frame"));
    await harness.event(() => socket.deliver('{"type":"reattached"}'));
    assert.equal(terminal.resets, 1, "the server's reattach resets the terminal once");

    const afterReset = terminal.written.length;
    harness.paint();
    await harness.waitForDeadline();
    assert.equal(terminal.written.length, afterReset, "nothing buffered before the reset is written after it");
    assert.ok(!terminal.text().includes("stale-frame"), "stale output never reaches the terminal");
  } finally {
    await harness.terminate();
  }
});

test("unmount discards buffered output instead of writing after teardown", async () => {
  const harness = await mountHarness();
  try {
    const terminal = harness.terminal();
    await harness.event(() => harness.socket().deliver("orphan"));
    const before = terminal.written.length;
    await harness.terminate();

    harness.paint();
    await harness.waitForDeadline();
    assert.equal(terminal.written.length, before, "a torn-down terminal is never written to");
  } finally {
    FakeWebSocket.instances.length = 0;
    FakeTerminal.instances.length = 0;
  }
});
