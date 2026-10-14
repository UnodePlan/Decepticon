/**
 * Command-palette half of the settings split: the palette must expose one
 * destination per settings screen, and none of them may still point at the
 * legacy `/settings` overview.
 *
 * `../../../test-router-stub` replaces `next/navigation` and `next/link` (the
 * palette uses `useRouter().push` and `usePathname`), so the component is
 * loaded with `await import()` after the stub's resolve hook is installed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  resetStubNavigations,
  setStubPathname,
  stubNavigations,
} from "../../../test-router-stub";
import { I18nProvider } from "@/lib/i18n-context";
import { translate } from "@/lib/i18n";

const SETTINGS_ENTRIES = [
  { labelKey: "palette.goSettingsModels", href: "/settings/models" },
  { labelKey: "palette.goSettingsRuntime", href: "/settings/runtime" },
  { labelKey: "palette.goSettingsStatus", href: "/settings/status" },
] as const;

async function openPalette(pathname = "/") {
  setStubPathname(pathname);
  resetStubNavigations();
  const { CommandPalette } = await import("@/components/layout/command-palette");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <CommandPalette />
      </I18nProvider>,
    );
  });
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function entryButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(button, `palette entry "${label}" not found`);
  return button;
}

test("the palette lists every settings screen and pushes its own route", async () => {
  const palette = await openPalette();
  try {
    for (const entry of SETTINGS_ENTRIES) {
      const label = translate("en", entry.labelKey);
      await act(async () => {
        entryButton(palette.container, label).click();
      });
      // The palette closes on selection; reopen for the next entry.
      await act(async () => {
        document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      });
    }
    assert.deepEqual(stubNavigations(), SETTINGS_ENTRIES.map((entry) => entry.href));
    assert.ok(!stubNavigations().includes("/settings"));
  } finally {
    await palette.unmount();
  }
});

test("no palette entry still targets the legacy settings overview", async () => {
  const palette = await openPalette();
  try {
    const settingsButtons = [...palette.container.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("Settings") || button.textContent?.includes("Status"),
    );
    assert.equal(settingsButtons.length, 3, "exactly the three split destinations");
    assert.ok(
      !settingsButtons.some((button) => button.textContent?.trim() === translate("en", "nav.settings")),
    );
  } finally {
    await palette.unmount();
  }
});

test("the palette filters down to a single settings screen", async () => {
  const palette = await openPalette();
  try {
    const input = palette.container.querySelector<HTMLInputElement>("input[type=text]");
    assert.ok(input, "palette search input not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, "Runtime");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });

    const labels = [...palette.container.querySelectorAll("button")].map((button) => button.textContent?.trim());
    assert.deepEqual(labels, [translate("en", "palette.goSettingsRuntime")]);
  } finally {
    await palette.unmount();
  }
});
