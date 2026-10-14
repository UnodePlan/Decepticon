/**
 * Route split: each settings screen loads exactly its own slice, and the legacy
 * `/settings` entry stays a pure navigation index.
 *
 * The point of the split is that opening one settings screen must not drag the
 * others' requests (or cards) along, so these tests assert both halves: the
 * endpoints a screen fetches and the content it renders.
 *
 * Every screen here is a client component using `next/navigation` and
 * `next/link`, which do not work outside an app-router mount, so
 * `../../../test-router-stub` stands in for both. Its resolve hook has to be
 * installed before a page module is evaluated, which is why each screen is
 * loaded through `await import()` with a literal specifier.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { setStubPathname } from "../../../test-router-stub";
import { I18nProvider } from "@/lib/i18n-context";
import { translate } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import type { SettingsSnapshot } from "@/lib/system-settings";

const SNAPSHOT: SettingsSnapshot = {
  modelProfile: "eco",
  globalModelOverride: "",
  modelOverrides: {},
  language: "en",
  llmTimeoutSeconds: 120,
  llmMaxRetries: 2,
  workspacePath: "/workspace",
  langGraphBrowserUrl: "/runtime",
  terminalBrowserUrl: "ws://localhost:3000",
  llmProxyApiKeySet: false,
  authMode: "password",
  databaseConfigured: true,
  deploymentWebPort: "3000",
  reasoningEffort: "none",
  llmMaxOutputTokens: 64000,
  llmDisableStreaming: false,
  llmExtraHeaderNames: [],
  budgetEngagementUsd: null,
  budgetPerAgentUsd: null,
  budgetSoftWarnAtPct: 70,
  hitlEnabled: false,
  telemetryMode: "off",
  authPriority: [],
  skillogyEmbedModel: "openai/text-embedding-3-small",
};

const HEALTH = {
  status: "healthy",
  modelCount: 1,
  services: [
    { name: "langgraph", status: "ok", detail: "API ready" },
    { name: "litellm", status: "ok", detail: "1 models loaded" },
    { name: "neo4j", status: "ok", detail: "Database ready" },
    { name: "postgres", status: "ok", detail: "Connected" },
  ],
};

const AGENTS = [
  { id: "decepticon", name: "Decepticon", description: "Coordinator", role: "lead", color: "#f00" },
];

const ENGAGEMENTS = [{ id: "e1", name: "First", status: "running" }];

const RESPONSE_BY_PATH: Record<string, unknown> = {
  "/api/settings": SNAPSHOT,
  "/api/settings/llm-channel": { apiBase: "", apiKeySet: false, model: "" },
  "/api/health": HEALTH,
  "/api/agents": AGENTS,
  "/api/engagements": ENGAGEMENTS,
};

/** Answers every console endpoint and records what the screen asked for. */
function stubFetch(): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    // A non-GET here means a screen wrote something while merely rendering.
    assert.notEqual(init?.method, "PUT", `unexpected write from a settings screen: ${target}`);
    requested.push(target);
    if (!(target in RESPONSE_BY_PATH)) {
      throw new Error(`unexpected request from a settings screen: ${target}`);
    }
    return { ok: true, status: 200, json: async () => RESPONSE_BY_PATH[target] } as unknown as Response;
  }) as typeof fetch;
  return requested;
}

function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

type ScreenLoader = () => Promise<{ default: () => React.ReactNode }>;

const SCREENS: Record<string, ScreenLoader> = {
  "/settings": () => import("../../app/(dashboard)/settings/page"),
  "/settings/models": () => import("../../app/(dashboard)/settings/models/page"),
  "/settings/runtime": () => import("../../app/(dashboard)/settings/runtime/page"),
  "/settings/status": () => import("../../app/(dashboard)/settings/status/page"),
};

async function mountScreen(pathname: keyof typeof SCREENS | string, locale: Locale = "en") {
  setStubPathname(pathname);
  const requested = stubFetch();
  const loader = SCREENS[pathname];
  assert.ok(loader, `no screen registered for ${pathname}`);
  const { default: Screen } = await loader();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        {createElement(Screen)}
      </I18nProvider>,
    );
  });
  await act(flush);
  return {
    container,
    requested: () => [...requested],
    text: () => container.textContent ?? "",
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("the models screen loads the snapshot and the channel, and nothing else", async () => {
  const page = await mountScreen("/settings/models");
  try {
    assert.deepEqual(page.requested().sort(), ["/api/settings", "/api/settings/llm-channel"]);
    assert.ok(page.text().includes(translate("en", "settings.page.models.title")));
    assert.ok(page.text().includes(translate("en", "settings.channel.title")));
    assert.ok(page.text().includes(translate("en", "settings.model.title")));
    // The advanced request knobs belong to this screen…
    assert.ok(page.text().includes(translate("en", "settings.models.advanced.title")));
    assert.ok(page.container.querySelector("#settings-advanced-max-output"));
    // …and the runtime-only guardrails do not leak into it.
    assert.equal(page.text().includes(translate("en", "settings.guardrails.title")), false);
    assert.equal(page.container.querySelector("#settings-budget-engagement"), null);
    // Runtime/status slices must not leak into the model screen.
    for (const key of ["settings.page.runtime.title", "settings.page.status.title", "settings.health.title", "settings.stats.title"]) {
      assert.equal(page.text().includes(translate("en", key)), false, key);
    }
  } finally {
    await page.unmount();
  }
});

test("the runtime screen loads only the snapshot it edits", async () => {
  const page = await mountScreen("/settings/runtime");
  try {
    assert.deepEqual(page.requested(), ["/api/settings"]);
    assert.ok(page.text().includes(translate("en", "settings.page.runtime.title")));
    assert.ok(page.text().includes(translate("en", "settings.endpoints.title")));
    // Guardrails and the startup-scoped privacy facts live here…
    assert.ok(page.text().includes(translate("en", "settings.guardrails.title")));
    assert.ok(page.text().includes(translate("en", "settings.privacy.title")));
    assert.ok(page.text().includes(translate("en", "settings.effect.readOnly")));
    assert.ok(page.container.querySelector("#settings-budget-engagement"));
    // …while the model request knobs stay on the models screen.
    assert.equal(page.text().includes(translate("en", "settings.models.advanced.title")), false);
    assert.equal(page.container.querySelector("#settings-advanced-max-output"), null);
    assert.ok(page.text().includes(translate("en", "settings.model.title")) === false);
    assert.ok(page.text().includes(translate("en", "settings.agents.title")) === false);
  } finally {
    await page.unmount();
  }
});

test("the status screen reads health, agents and engagements without touching settings", async () => {
  const page = await mountScreen("/settings/status");
  try {
    assert.deepEqual(page.requested().sort(), ["/api/agents", "/api/engagements", "/api/health"]);
    for (const key of ["settings.page.status.title", "settings.health.title", "settings.stats.title", "settings.agents.title"]) {
      assert.ok(page.text().includes(translate("en", key)), key);
    }
    // A status visit must not disturb an unsaved draft on an editable screen.
    assert.equal(page.text().includes(translate("en", "settings.action.save")), false);
  } finally {
    await page.unmount();
  }
});

test("the legacy /settings entry links to every split screen and loads nothing", async () => {
  const page = await mountScreen("/settings");
  try {
    assert.deepEqual(page.requested(), []);
    const hrefs = [...page.container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"));
    assert.deepEqual(hrefs.sort(), ["/settings/models", "/settings/runtime", "/settings/status"]);
    assert.ok(page.text().includes(translate("en", "settings.title")));
  } finally {
    await page.unmount();
  }
});

test("both editable screens keep their own save bar", async () => {
  const save = translate("en", "settings.action.save");
  for (const pathname of ["/settings/models", "/settings/runtime"]) {
    const page = await mountScreen(pathname);
    try {
      const buttons = [...page.container.querySelectorAll("button")].map((button) => button.textContent?.trim());
      assert.ok(buttons.includes(save), `${pathname} lost its save action`);
    } finally {
      await page.unmount();
    }
  }
});

test("editable screens share one snapshot request per mount", async () => {
  for (const pathname of ["/settings/models", "/settings/runtime"]) {
    const page = await mountScreen(pathname);
    try {
      assert.equal(
        page.requested().filter((url) => url === "/api/settings").length,
        1,
        `${pathname} fetched the snapshot more than once`,
      );
    } finally {
      await page.unmount();
    }
  }
});

test("every screen renders its own localized heading", async () => {
  const expected: Record<string, string> = {
    "/settings": "settings.title",
    "/settings/models": "settings.page.models.title",
    "/settings/runtime": "settings.page.runtime.title",
    "/settings/status": "settings.page.status.title",
  };
  for (const [pathname, key] of Object.entries(expected)) {
    const page = await mountScreen(pathname, "zh");
    try {
      const heading = page.container.querySelector("h1")?.textContent ?? "";
      assert.equal(heading, translate("zh", key), pathname);
      assert.notEqual(heading, translate("en", key), pathname);
    } finally {
      await page.unmount();
    }
  }
});

test("the rail, the overview tiles and the route table agree on the same screens", async () => {
  // The split introduced three places that name the settings destinations: the
  // rail (`bottomNav`), the legacy overview page's tiles, and this test's route
  // table. Drift between them would strand a destination, so pin them together.
  const { bottomNav } = await import("@/components/layout/sidebar");
  const railHrefs = bottomNav.map((item) => item.href);
  assert.deepEqual(railHrefs, ["/settings/models", "/settings/runtime", "/settings/status"]);
  for (const href of railHrefs) assert.ok(href in SCREENS, `${href} has no page in the test table`);

  const page = await mountScreen("/settings");
  try {
    const tileHrefs = [...page.container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"));
    assert.deepEqual(tileHrefs, railHrefs);
  } finally {
    await page.unmount();
  }
});
