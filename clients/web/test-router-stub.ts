/**
 * Router stand-in for component tests that render Next.js client components
 * under `node --test`.
 *
 * `next/navigation` throws outside an app-router mount and does not resolve as
 * a plain specifier under `tsx`, so importing this module installs a
 * `module.registerHooks` resolve hook that serves `next/navigation` and
 * `next/link` from `test-next-navigation-stub.mjs`. The hook must be live
 * before the component's module graph is evaluated, so components under test
 * are reached with `await import()`.
 *
 * Helpers:
 *   - `setStubPathname(path)`   → what the stubbed `usePathname()` returns;
 *   - `stubNavigations()`       → destinations pushed/replaced since the last
 *                                 reset, for assertions;
 *   - `resetStubNavigations()`.
 */
import { createRequire } from "node:module";

/** The stub module lives next to this helper, inside the web package. */
const STUB_URL = new URL("./test-next-navigation-stub.mjs", import.meta.url).href;

/** App imports that reach for routing and that the stub replaces. */
const STUBBED_SPECIFIERS: Record<string, true> = {
  "next/navigation": true,
  "next/link": true,
};

interface ResolveContext {
  parentURL?: string;
}

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
}

const { registerHooks } = createRequire(import.meta.url)("node:module") as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: ResolveContext,
      next: (specifier: string, context: ResolveContext) => ResolveResult,
    ) => ResolveResult;
  }) => unknown;
};

registerHooks({
  resolve(specifier, context, next) {
    if (!STUBBED_SPECIFIERS[specifier]) return next(specifier, context);
    return { url: STUB_URL, shortCircuit: true };
  },
});

/** State the stub module and these helpers share across the module boundary. */
const navigationGlobal = globalThis as typeof globalThis & {
  __NAV_PATHNAME__?: string;
  __NAV_PUSHES__?: string[];
};

/** Pathname the stubbed `usePathname()` returns; read on every render. */
export function setStubPathname(pathname: string): void {
  navigationGlobal.__NAV_PATHNAME__ = pathname;
}

/** Destinations the component pushed or replaced, oldest first. */
export function stubNavigations(): string[] {
  return navigationGlobal.__NAV_PUSHES__ ?? [];
}

export function resetStubNavigations(): void {
  navigationGlobal.__NAV_PUSHES__ = [];
}
