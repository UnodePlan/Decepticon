/**
 * Route-split navigation behaviour: the rail must offer one entry per settings
 * screen and highlight only the screen the operator is actually on.
 *
 * `Sidebar` is a client component that reads `usePathname()` and renders
 * `next/link` anchors, neither of which works outside an app-router mount, so
 * `../../../test-router-stub` replaces both. The stub installs its resolve hook
 * on import, which is why the sidebar module itself is loaded with
 * `await import()` — a literal specifier, deferred only because the hook has to
 * be in place first.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setStubPathname } from "../../../test-router-stub";
import { I18nProvider } from "@/lib/i18n-context";
import { LOCALES, translate } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

async function mountSidebar(pathname: string, locale: Locale = "en") {
  setStubPathname(pathname);
  const { Sidebar } = await import("@/components/layout/sidebar");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async () => {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale={locale}>
          <Sidebar />
        </I18nProvider>,
      );
    });
    await act(flush);
  };
  await render();
  return {
    container,
    render,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Settings destinations the rail renders, keyed by `href`. */
function settingsLinks(container: HTMLElement): Map<string, HTMLAnchorElement> {
  const links = new Map<string, HTMLAnchorElement>();
  for (const anchor of container.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (href?.startsWith("/settings")) links.set(href, anchor);
  }
  return links;
}

/** The rail marks the current destination the way a nav landmark should. */
const ARIA_CURRENT_PAGE = "page";

function highlightedSettingsHrefs(container: HTMLElement): string[] {
  return [...settingsLinks(container)]
    .filter(([, anchor]) => anchor.getAttribute("aria-current") === ARIA_CURRENT_PAGE)
    .map(([href]) => href);
}

test("the rail offers a separate, distinctly labelled entry per settings screen", async () => {
  const { bottomNav } = await import("@/components/layout/sidebar");
  const page = await mountSidebar("/settings/models");
  try {
    assert.deepEqual([...settingsLinks(page.container).keys()].sort(), [
      "/settings/models",
      "/settings/runtime",
      "/settings/status",
    ]);
    assert.equal(bottomNav.length, 3);
    // One label key per entry: reusing `nav.settings` would make the three
    // destinations indistinguishable in the rail.
    assert.equal(new Set(bottomNav.map((item) => item.labelKey)).size, 3);
    for (const item of bottomNav) {
      const label = translate("en", item.labelKey);
      assert.notEqual(label, item.labelKey, `missing English copy for ${item.labelKey}`);
      assert.equal(settingsLinks(page.container).get(item.href)?.textContent?.includes(label), true, label);
    }
  } finally {
    await page.unmount();
  }
});

test("every settings entry highlights on its own route and nowhere else", async () => {
  const { isNavItemActive, bottomNav } = await import("@/components/layout/sidebar");
  for (const item of bottomNav) {
    assert.equal(isNavItemActive(item.href, item.href), true, item.href);
    assert.equal(isNavItemActive(`${item.href}/nested`, item.href), true, `${item.href}/nested`);
    for (const other of bottomNav) {
      if (other.href === item.href) continue;
      assert.equal(isNavItemActive(other.href, item.href), false, `${other.href} vs ${item.href}`);
    }
  }
  // The legacy overview is a destination of its own, so it must not light up
  // the first sub-entry (which a prefix match would do).
  assert.equal(isNavItemActive("/settings", "/settings/models"), false);
  assert.equal(isNavItemActive("/settings", "/settings"), true);
  assert.equal(isNavItemActive("/settings/models/extra", "/settings"), false);

  const page = await mountSidebar("/settings/runtime");
  try {
    assert.deepEqual(highlightedSettingsHrefs(page.container), ["/settings/runtime"]);
    for (const pathname of ["/settings/models", "/settings/status"]) {
      setStubPathname(pathname);
      await page.render();
      assert.deepEqual(highlightedSettingsHrefs(page.container), [pathname]);
    }
  } finally {
    await page.unmount();
  }
});

test("the legacy /settings route highlights no settings sub-entry", async () => {
  const page = await mountSidebar("/settings");
  try {
    assert.deepEqual(highlightedSettingsHrefs(page.container), []);
  } finally {
    await page.unmount();
  }
});

test("rail labels follow the active locale", async () => {
  const { bottomNav } = await import("@/components/layout/sidebar");
  for (const locale of LOCALES) {
    const page = await mountSidebar("/settings/status", locale);
    try {
      const text = page.container.textContent ?? "";
      for (const item of bottomNav) {
        const label = translate(locale, item.labelKey);
        assert.ok(text.includes(label), `${locale}:${item.labelKey} (${label})`);
      }
    } finally {
      await page.unmount();
    }
  }
});
