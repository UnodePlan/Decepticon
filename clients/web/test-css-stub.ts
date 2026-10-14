/**
 * Stylesheet stand-in for component tests.
 *
 * A component that owns a stylesheet imports it for its side effect
 * (`import "@/styles/canvas-graph.css"`); `tsx` would otherwise hand the CSS to
 * esbuild as JavaScript and fail. Importing this module installs a resolve hook
 * that serves every `.css` specifier from `test-css-stub.mjs`, so a component
 * under test loads cleanly. The hook must be live before the component's module
 * graph is evaluated, so components under test are reached with `await import()`
 * inside a test (see `src/lib/graph/canvas-gating.test.tsx`).
 */
import { createRequire } from "node:module";

/** Stub module lives next to this helper, inside the web package. */
const STUB_URL = new URL("./test-css-stub.mjs", import.meta.url).href;

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
    if (!specifier.endsWith(".css")) return next(specifier, context);
    return { url: STUB_URL, shortCircuit: true };
  },
});
