/**
 * Stand-in for CSS side-effect imports in component tests.
 *
 * Components that own a stylesheet import it for its side effect
 * (`import "@/styles/canvas-graph.css"`), which `tsx` otherwise tries to parse
 * as JavaScript. `test-css-stub.ts` makes Node resolve any `.css` specifier
 * here, so a component under test loads cleanly; the stylesheet's own content is
 * asserted from the file in the render-contract test, not from this module.
 *
 * Kept as a real `.mjs` file (not generated into a temp dir) so that resolution
 * happens through this package's own `node_modules`.
 */
export default {};
