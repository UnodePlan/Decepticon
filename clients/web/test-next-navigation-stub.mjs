/**
 * Stand-in for `next/navigation` and `next/link` in component tests.
 *
 * Both modules need Next.js runtime context that `node --test` does not provide
 * (importing them outside an app-router mount throws, and `next/navigation`
 * does not even resolve as an ESM specifier under `tsx`). `test-router-stub.ts`
 * makes Node resolve those two specifiers here, so a component under test gets:
 *
 *   - `usePathname()` → `globalThis.__NAV_PATHNAME__`, driven by
 *     `setStubPathname()` in the helper;
 *   - `useRouter()` → inert methods, with `push`/`replace` recorded in
 *     `globalThis.__NAV_PUSHES__` for assertions;
 *   - `Link` → a plain anchor, so link queries keep working.
 *
 * Kept as a real `.mjs` file (not generated into a temp dir) so that `react` is
 * resolved through this package's own `node_modules`.
 */
import { createElement } from "react";

export const usePathname = () => globalThis.__NAV_PATHNAME__ ?? "/";

export const useRouter = () => ({
  push: recordNavigation,
  replace: recordNavigation,
  prefetch() {},
  back() {},
  forward() {},
});

export const useParams = () => ({});

export const useSearchParams = () => new URLSearchParams();

export const useSelectedLayoutSegment = () => null;

export const useSelectedLayoutSegments = () => [];

function recordNavigation(href) {
  (globalThis.__NAV_PUSHES__ ??= []).push(String(href));
}

export function Link({ href, children, ...rest }) {
  return createElement("a", { href: String(href), ...rest }, children);
}

export default Link;
