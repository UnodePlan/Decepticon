/**
 * Preload for the jsdom component tests: `node --import tsx --import ./test-setup.ts`.
 *
 * Two problems this solves, both of which only show up when a React component is
 * mounted under `tsx`:
 *
 *  1. `react-dom/client` decides at import time whether a DOM exists. Imported
 *     before any test installs one, its synthetic event system never dispatches
 *     `input`/`change`, so controlled fields look frozen. Installing the DOM as a
 *     preload makes static imports in the test file safe.
 *  2. `npm install` hoists most packages to the repository root, but `clients/web`
 *     pins its own `react`/`react-dom`. Under `tsx` the two copies split: a
 *     component import may resolve the web copy while a third-party package
 *     (lucide-react, base-ui) resolves hooks from the hoisted copy, and every
 *     render throws "Invalid hook call". PINNED_MODULES forces one React instance.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

interface ResolveContext {
  parentURL?: string;
}

type ResolveResult = { url: string; shortCircuit?: boolean };

/**
 * `module.registerHooks` ships in Node 22+, but this workspace pins
 * `@types/node` 20 — type the only call site instead of widening the dependency.
 */
const { registerHooks } = require("node:module") as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: ResolveContext,
      nextResolve: (specifier: string, context: ResolveContext) => ResolveResult,
    ) => ResolveResult;
  }) => unknown;
};

const PINNED_MODULES = ["react", "react-dom", "react-dom/client", "react-dom/server", "react/jsx-runtime"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!PINNED_MODULES.includes(specifier)) return nextResolve(specifier, context);
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  },
});

const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string, options?: { url?: string }) => { window: Window & typeof globalThis };
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://console.test/" });

/** jsdom's twins of these would break timers, fetch and Node builtins. */
const KEEP_NODE_GLOBALS = [
  "process", "global", "globalThis", "Buffer", "console", "require", "module",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "setImmediate", "clearImmediate", "queueMicrotask",
  "fetch", "AbortController", "AbortSignal", "structuredClone",
  "TextEncoder", "TextDecoder", "performance", "crypto",
];

function installDomGlobal(key: string, value: unknown): void {
  const existing = Object.getOwnPropertyDescriptor(globalThis, key);
  if (existing && !existing.configurable) return;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const FORCE_DOM_GLOBALS = ["window", "document", "navigator", "self", "HTMLElement", "Element", "Node", "DocumentFragment", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "location", "history", "localStorage"];
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (KEEP_NODE_GLOBALS.includes(key)) continue;
  const win = dom.window as unknown as Record<string, unknown>;
  if (win[key] === undefined) continue;
  if (!FORCE_DOM_GLOBALS.includes(key) && (globalThis as Record<string, unknown>)[key] !== undefined) continue;
  installDomGlobal(key, win[key]);
}

/**
 * jsdom without `pretendToBeVisual` has no animation frames and no observers, but
 * `@base-ui`'s popups (the settings select) schedule both on mount. Provide inert
 * equivalents: the components only need the callbacks to be callable, and the
 * tests drive the popup through events rather than layout.
 */
const DOM_SHIMS: Record<string, unknown> = {
  requestAnimationFrame: (callback: (time: number) => void) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
  IntersectionObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  },
};

for (const [key, value] of Object.entries(DOM_SHIMS)) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) installDomGlobal(key, value);
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
