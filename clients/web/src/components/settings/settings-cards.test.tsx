import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { I18nProvider } from "@/lib/i18n-context";
import { hasTranslation, translate } from "@/lib/i18n";
import ModelSettingsPage from "../../app/(dashboard)/settings/models/page";
import RuntimeSettingsPage from "../../app/(dashboard)/settings/runtime/page";
import StatusSettingsPage from "../../app/(dashboard)/settings/status/page";
import type { SettingsSnapshot } from "@/lib/system-settings";

/**
 * The settings screens are three routes, so every case mounts the screen that
 * owns the card under test and none of them sees the others' content.
 *
 * The jsdom window is installed as a process global by `test-setup.ts` (a
 * `--import` preload), so `react-dom/client` sees a DOM when this module is
 * evaluated and its synthetic event system reaches controlled inputs.
 */

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

const HEALTH_PAYLOAD = {
  status: "healthy",
  modelCount: 1,
  services: [
    { name: "langgraph", status: "ok", detail: "API ready" },
    { name: "litellm", status: "ok", detail: "1 models loaded" },
    { name: "neo4j", status: "ok", detail: "Database ready" },
    { name: "postgres", status: "ok", detail: "Connected" },
  ],
};

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface StubFailure {
  status: number;
  body: unknown;
}

interface StubOptions {
  putResponse?: unknown;
  putFailure?: StubFailure;
  getFailure?: StubFailure;
  /** The stored snapshot, for cases that re-mount after a save. */
  getResponse?: Partial<SettingsSnapshot>;
}

/** Route the console's data fetches so the page renders against a fixed stack. */
function stubFetch(options: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: target, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (target === "/api/settings") {
      const failure = method === "PUT" ? options.putFailure : options.getFailure;
      if (failure) {
        return { ok: false, status: failure.status, json: async () => failure.body } as unknown as Response;
      }
      const payload =
        method === "PUT" ? (options.putResponse ?? SNAPSHOT) : { ...SNAPSHOT, ...options.getResponse };
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }
    if (target === "/api/settings/llm-channel") {
      // The models screen also loads the custom LLM channel; answer it with "not
      // configured" so this fixture describes a stack whose channel is unused.
      return {
        ok: true,
        status: 200,
        json: async () => ({ apiBase: "", apiKeySet: false, model: "" }),
      } as unknown as Response;
    }
    const payload = target === "/api/health" ? HEALTH_PAYLOAD : [];
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

/** Resolve once queued microtasks and zero-delay timers have run. */
function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

function mountPage(Page: ComponentType, locale = "en") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  return {
    container,
    async ready() {
      await act(async () => {
        root.render(
          <I18nProvider initialLocale={locale}>
            <Page />
          </I18nProvider>,
        );
      });
      // Settle the settings/health/agents/engagements effects.
      await act(flush);
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function inputById(container: HTMLElement, id: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  assert.ok(input, `input #${id} not found`);
  return input;
}

/** Flip a checkbox the way a browser does (activation behavior + delegated click handler). */
async function toggleCheckbox(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.click();
    await flush();
  });
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  assert.ok(button, `button "${label}" not found`);
  return button as HTMLButtonElement;
}

async function clickSave(container: HTMLElement): Promise<void> {
  await act(async () => {
    buttonByText(container, "Save changes").click();
    await flush();
  });
}

/**
 * Open a base-ui select and commit an option. jsdom has no real pointers, so the
 * option is highlighted with a pointer event (the list tracks highlight) and then
 * clicked — a bare click on an unhighlighted option is swallowed by design.
 */
async function chooseOption(container: HTMLElement, triggerId: string, option: string): Promise<void> {
  await act(async () => {
    const trigger = container.querySelector<HTMLElement>(`#${triggerId}`);
    assert.ok(trigger, `select #${triggerId} not found`);
    trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flush();
  });

  const target = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === option,
  );
  assert.ok(target, `option "${option}" not found`);

  await act(async () => {
    target.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    target.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
    await flush();
  });
  await act(async () => {
    target.click();
    await flush();
  });
}

test("the models screen loads the snapshot into its own form", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    assert.ok(calls.some((call) => call.url === "/api/settings" && call.method === "GET"));
    assert.equal(inputById(page.container, "settings-global-model").value, "");
    // Nothing typed yet → the save button is disabled.
    assert.equal(buttonByText(page.container, "Save changes").disabled, true);
    // The model screen owns the model cards only.
    assert.equal(page.container.querySelector("#settings-timeout"), null);
    assert.ok(!page.container.textContent?.includes("System Health"));
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the runtime screen loads the defaults and the read-only deployment facts", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(RuntimeSettingsPage);
  await page.ready();
  try {
    assert.ok(calls.some((call) => call.url === "/api/settings" && call.method === "GET"));
    // The startup-scoped runtime knobs are REPORTED, not editable: an input for one
    // would be a control whose save the API rejects.
    assert.equal(page.container.querySelector("#settings-timeout"), null);
    assert.equal(page.container.querySelector("#settings-retries"), null);
    // Read-only deployment facts come from the snapshot, not from editable state.
    assert.ok(page.container.textContent?.includes("3000"));
    assert.ok(page.container.textContent?.includes("Password (configured)"));
    assert.ok(page.container.textContent?.includes("Workspace path"));
    assert.ok(page.container.textContent?.includes("120"), "the deployment LLM timeout is reported");
    assert.ok(page.container.textContent?.includes("Eco (per-agent tier)"), "the deployment profile is reported");
    assert.equal(buttonByText(page.container, "Save changes").disabled, true);
    // …and it does not mount the model cards.
    assert.equal(page.container.querySelector("#settings-global-model"), null);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the status screen reports health, statistics and the registry", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(StatusSettingsPage);
  await page.ready();
  try {
    assert.ok(page.container.textContent?.includes("System Health"));
    assert.ok(page.container.textContent?.includes("Engagement Statistics"));
    assert.ok(page.container.textContent?.includes("Agent Registry"));
    assert.ok(page.container.textContent?.includes("API ready"));
    // Status is read-only: it never loads or writes the settings snapshot.
    assert.equal(calls.filter((call) => call.url === "/api/settings").length, 0);
    assert.equal(page.container.querySelector("button"), null);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("each settings screen is translated with the active locale", async () => {
  stubFetch();
  const priorFetch = globalThis.fetch;
  const models = mountPage(ModelSettingsPage, "zh");
  await models.ready();
  try {
    for (const expected of ["模型设置", "模型运行", "保存更改", "模型高级参数", "思考等级", "额外请求 Headers"]) {
      assert.ok(models.container.textContent?.includes(expected), expected);
    }
    // The global header row is a read-only report, so it must not collide with the
    // channel card's own editable rows.
    assert.equal(models.container.querySelector('input[aria-label="全局 Header 名"]'), null);
  } finally {
    await models.unmount();
  }

  const runtime = mountPage(RuntimeSettingsPage, "zh");
  await runtime.ready();
  try {
    for (const expected of [
      "运行时与端点",
      "运行默认值",
      "Web 端点",
      "部署与启动",
      "重启后生效",
      "智能体护栏",
      "任务预算（USD）",
      "隐私与遥测",
      "遥测模式",
    ]) {
      assert.ok(runtime.container.textContent?.includes(expected), expected);
    }
  } finally {
    await runtime.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("saving a valid model override PUTs a partial patch and adopts the response", async () => {
  const calls = stubFetch({ putResponse: { ...SNAPSHOT, globalModelOverride: "openai/gpt-4o" } });
  const priorFetch = globalThis.fetch;
  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    const globalModel = inputById(page.container, "settings-global-model");
    await act(async () => {
      setInputValue(globalModel, " openai/gpt-4o ");
    });

    assert.equal(buttonByText(page.container, "Save changes").disabled, false);
    await clickSave(page.container);

    const put = calls.filter((call) => call.method === "PUT");
    assert.equal(put.length, 1);
    assert.deepEqual(put[0].body, { globalModelOverride: "openai/gpt-4o" });

    // The response body replaces local state: the trimmed value is displayed and
    // the button is disabled again until the next edit.
    assert.equal(inputById(page.container, "settings-global-model").value, "openai/gpt-4o");
    assert.ok(page.container.textContent?.includes("Saved"));
    assert.equal(buttonByText(page.container, "Save changes").disabled, true);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("an invalid model id is blocked in the browser and never sent", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    const globalModel = inputById(page.container, "settings-global-model");
    await act(async () => {
      setInputValue(globalModel, "bad model");
    });
    await clickSave(page.container);

    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    assert.ok(page.container.textContent?.includes("Enter a model ID without spaces."));
    assert.equal(globalModel.getAttribute("aria-invalid"), "true");
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("a rejected save keeps the operator's input and shows the returned reason", async () => {
  const calls = stubFetch({
    putFailure: {
      status: 400,
      body: { error: "Invalid settings", fields: { language: "must be one of en, zh" } },
    },
  });
  const priorFetch = globalThis.fetch;
  const page = mountPage(RuntimeSettingsPage);
  await page.ready();
  try {
    const budget = inputById(page.container, "settings-budget-engagement");
    await act(async () => {
      setInputValue(budget, "900");
    });
    await clickSave(page.container);

    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    // The 400 body's machine reason is not shown raw; a localized sentence is.
    assert.ok(page.container.textContent?.includes("The settings service rejected these values."));
    // The edit is not thrown away on failure.
    assert.equal(inputById(page.container, "settings-budget-engagement").value, "900");
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("an out-of-range number is reported on the field and never sent", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(RuntimeSettingsPage);
  await page.ready();
  try {
    await act(async () => {
      setInputValue(inputById(page.container, "settings-budget-soft-warn"), "900");
    });
    await clickSave(page.container);

    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    assert.ok(page.container.textContent?.includes("between 0 and 100"));
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("clearing the proxy key asks the server to delete it and never echoes a value", async () => {
  const calls = stubFetch({ putResponse: { ...SNAPSHOT, llmProxyApiKeySet: false } });
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === "/api/settings" && (init?.method ?? "GET") === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...SNAPSHOT, llmProxyApiKeySet: true }),
      } as unknown as Response;
    }
    return (globalThis.fetch as typeof fetch)(url, init);
  }) as typeof fetch;
  // The wrapper above would recurse; re-stub the PUT path against the recorder.
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/settings" && (init?.method ?? "GET") === "PUT") {
      calls.push({ method: "PUT", url: target, body: JSON.parse(String(init?.body)) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...SNAPSHOT, llmProxyApiKeySet: false }),
      } as unknown as Response;
    }
    return inner(url, init);
  }) as typeof fetch;

  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    assert.ok(page.container.textContent?.includes("A key is saved"));
    // The write-only input is always rendered empty — no key material is echoed.
    assert.equal(inputById(page.container, "settings-proxy-key").value, "");

    await act(async () => {
      buttonByText(page.container, "Clear saved key").click();
    });
    await clickSave(page.container);

    const put = calls.filter((call) => call.method === "PUT");
    assert.equal(put.length, 1);
    assert.deepEqual(put[0].body, { llmProxyApiKey: "" });
    assert.ok(page.container.textContent?.includes("No key saved"));
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("a failed settings load reports the error on that screen and recovers on retry", async () => {
  const calls = stubFetch();
  // Fail only the first load so the retry button exercises the recovery path.
  const routed = globalThis.fetch;
  let settingsLoads = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === "/api/settings" && (init?.method ?? "GET") === "GET") {
      settingsLoads += 1;
      if (settingsLoads === 1) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as unknown as Response;
      }
    }
    return routed(url, init);
  }) as typeof fetch;
  const priorFetch = globalThis.fetch;
  const page = mountPage(RuntimeSettingsPage);
  await page.ready();
  try {
    assert.equal(settingsLoads, 1);
    assert.ok(page.container.textContent?.includes("Failed to load settings"));
    // A failed load leaves no half-filled form behind.
    assert.equal(page.container.querySelector("#settings-language"), null);

    await act(async () => {
      buttonByText(page.container, "Retry").click();
      await flush();
    });
    assert.equal(settingsLoads, 2);
    assert.ok(calls.filter((call) => call.url === "/api/settings").length >= 1);
    // The deployment timeout is reported from the reloaded snapshot.
    assert.ok(page.container.textContent?.includes("120"));
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("per-agent overrides only offer registered agents", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    await act(async () => {
      [...page.container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Add override")
        ?.click();
    });
    // No agent picked yet → nothing added, nothing sent.
    assert.ok(page.container.textContent?.includes("No per-agent overrides."));
    await clickSave(page.container);
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the models screen edits the advanced parameters and saves them in one patch", async () => {
  const calls = stubFetch({
    putResponse: {
      ...SNAPSHOT,
      reasoningEffort: "medium",
      llmMaxOutputTokens: 32768,
      llmDisableStreaming: true,
    },
  });
  const priorFetch = globalThis.fetch;
  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    assert.ok(page.container.textContent?.includes(translate("en", "settings.models.advanced.title")));
    // The card names its real boundary instead of claiming the change is live.
    assert.ok(page.container.textContent?.includes(translate("en", "settings.effect.nextSession")));

    assert.equal(inputById(page.container, "settings-advanced-max-output").value, "64000");
    assert.equal(inputById(page.container, "settings-advanced-streaming").checked, true);

    await act(async () => {
      setInputValue(inputById(page.container, "settings-advanced-max-output"), "32768");
    });
    await toggleCheckbox(inputById(page.container, "settings-advanced-streaming"));
    await chooseOption(page.container, "settings-advanced-reasoning", "Medium");

    assert.equal(buttonByText(page.container, "Save changes").disabled, false);
    await clickSave(page.container);

    const put = calls.filter((call) => call.method === "PUT");
    assert.equal(put.length, 1);
    assert.deepEqual(put[0].body, {
      reasoningEffort: "medium",
      llmMaxOutputTokens: 32768,
      llmDisableStreaming: true,
    });

    // The stored response becomes the baseline: the fields show the saved values
    // with nothing left to save.
    assert.equal(inputById(page.container, "settings-advanced-max-output").value, "32768");
    assert.equal(inputById(page.container, "settings-advanced-streaming").checked, false);
    assert.equal(buttonByText(page.container, "Save changes").disabled, true);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the global extra-header row is reported read-only, with names only", async () => {
  const calls = stubFetch({ getResponse: { llmExtraHeaderNames: ["x-tenant"] } });
  const priorFetch = globalThis.fetch;
  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    // No editable header control exists any more: the value is deployment-owned and
    // the run input never carries it, so a save button for it could only fail.
    assert.equal(page.container.querySelectorAll('input[aria-label="Global header name"]').length, 0);
    assert.equal(page.container.querySelectorAll('input[aria-label="Global header value"]').length, 0);
    assert.ok(page.container.textContent?.includes("x-tenant"));
    assert.ok(page.container.textContent?.includes(translate("en", "settings.effect.readOnly")));
    await clickSave(page.container);
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the reasoning select offers every tier and saves the new top tiers verbatim", async () => {
  const calls = stubFetch({ putResponse: { ...SNAPSHOT, reasoningEffort: "xhigh" } });
  const priorFetch = globalThis.fetch;
  // The select renders `REASONING_EFFORTS`, so every tier needs copy in both locales.
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.ok(hasTranslation("en", `settings.models.reasoning.${effort}`), effort);
    assert.ok(hasTranslation("zh", `settings.models.reasoning.${effort}`), effort);
  }
  for (const effort of ["xhigh", "max"] as const) {
    assert.notEqual(
      translate("zh", `settings.models.reasoning.${effort}`),
      translate("en", `settings.models.reasoning.${effort}`),
      `${effort} must not echo the English label in Chinese`,
    );
  }

  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    // One open: assert the whole option list, then commit the top tier from the
    // same list (a bare click on an unhighlighted option is swallowed, so the
    // option is highlighted with a pointer event first, exactly like `chooseOption`).
    await act(async () => {
      const trigger = page.container.querySelector<HTMLElement>("#settings-advanced-reasoning");
      assert.ok(trigger, "reasoning select not found");
      trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await flush();
    });
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const labels = options.map((candidate) => candidate.textContent?.trim() ?? "");
    // The option list IS the enum: a missing tier would make it unreachable, and an
    // extra one would offer a level the API rejects. Compared as a set, since the
    // popup's DOM order is the component library's, not the contract's.
    assert.deepEqual(
      [...labels].sort(),
      ["Extra high", "High", "Low", "Maximum", "Medium", "Provider default (send nothing)"].sort(),
    );

    // Highlight then commit, re-querying the option each time: React may replace
    // the popup nodes between the two acts, and a detached node swallows the click.
    const pick = (label: string): HTMLElement => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      assert.ok(option, `the ${label} option must be selectable`);
      return option;
    };
    await act(async () => {
      const target = pick("Extra high");
      target.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      target.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
      await flush();
    });
    await act(async () => {
      pick("Extra high").click();
      await flush();
    });

    assert.equal(buttonByText(page.container, "Save changes").disabled, false);
    await clickSave(page.container);

    // `xhigh` reaches the API unchanged: no downgrade to `high` on the way out.
    const firstPut = calls.filter((call) => call.method === "PUT");
    assert.equal(firstPut.length, 1);
    assert.deepEqual(firstPut[0].body, { reasoningEffort: "xhigh" });

    // The stored response is the new baseline, so the same field saves the other
    // new tier exactly once more — with a response that echoes what was stored.
    assert.equal(buttonByText(page.container, "Save changes").disabled, true);
    const maxCalls = stubFetch({ putResponse: { ...SNAPSHOT, reasoningEffort: "max" } });
    await chooseOption(page.container, "settings-advanced-reasoning", "Maximum");
    assert.equal(buttonByText(page.container, "Save changes").disabled, false);
    await clickSave(page.container);

    const maxPut = maxCalls.filter((call) => call.method === "PUT");
    assert.equal(maxPut.length, 1);
    assert.deepEqual(maxPut[0].body, { reasoningEffort: "max" });
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("an out-of-range max output is reported on the field and never sent", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(ModelSettingsPage);
  await page.ready();
  try {
    await act(async () => {
      setInputValue(inputById(page.container, "settings-advanced-max-output"), "999999");
    });
    await clickSave(page.container);

    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    assert.ok(page.container.textContent?.includes("Enter a whole number of tokens between 256 and 128000"));
    const output = inputById(page.container, "settings-advanced-max-output");
    assert.equal(output.value, "999999");
    assert.equal(output.getAttribute("aria-invalid"), "true");
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the runtime screen saves the guardrails and a reload reads the stored values", async () => {
  const stored: Partial<SettingsSnapshot> = {
    budgetEngagementUsd: 500,
    budgetPerAgentUsd: 12.5,
    budgetSoftWarnAtPct: 85,
    hitlEnabled: true,
  };
  const priorFetch = globalThis.fetch;
  try {
    const calls = stubFetch({ putResponse: { ...SNAPSHOT, ...stored } });
    const page = mountPage(RuntimeSettingsPage);
    await page.ready();
    try {
      assert.ok(page.container.textContent?.includes(translate("en", "settings.guardrails.title")));

      await act(async () => {
        setInputValue(inputById(page.container, "settings-budget-engagement"), "500");
      });
      await act(async () => {
        setInputValue(inputById(page.container, "settings-budget-per-agent"), "12.5");
      });
      await act(async () => {
        setInputValue(inputById(page.container, "settings-budget-soft-warn"), "85");
      });
      await toggleCheckbox(inputById(page.container, "settings-hitl-enabled"));

      assert.equal(buttonByText(page.container, "Save changes").disabled, false);
      await clickSave(page.container);

      const put = calls.filter((call) => call.method === "PUT");
      assert.equal(put.length, 1);
      assert.deepEqual(put[0].body, {
        budgetEngagementUsd: 500,
        budgetPerAgentUsd: 12.5,
        budgetSoftWarnAtPct: 85,
        hitlEnabled: true,
      });

      // The response is the new baseline: the fields hold what the server stored.
      assert.equal(inputById(page.container, "settings-budget-engagement").value, "500");
      assert.equal(inputById(page.container, "settings-budget-per-agent").value, "12.5");
      assert.equal(inputById(page.container, "settings-budget-soft-warn").value, "85");
      assert.equal(inputById(page.container, "settings-hitl-enabled").checked, true);
      assert.equal(buttonByText(page.container, "Save changes").disabled, true);
    } finally {
      await page.unmount();
    }

    // A fresh mount against the stored snapshot proves the save was durable.
    stubFetch({ getResponse: stored });
    const reloaded = mountPage(RuntimeSettingsPage);
    await reloaded.ready();
    try {
      assert.equal(inputById(reloaded.container, "settings-budget-engagement").value, "500");
      assert.equal(inputById(reloaded.container, "settings-budget-per-agent").value, "12.5");
      assert.equal(inputById(reloaded.container, "settings-budget-soft-warn").value, "85");
      assert.equal(inputById(reloaded.container, "settings-hitl-enabled").checked, true);
      assert.equal(buttonByText(reloaded.container, "Save changes").disabled, true);
    } finally {
      await reloaded.unmount();
    }
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("an out-of-range budget is reported on the guardrail field and never sent", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const page = mountPage(RuntimeSettingsPage);
  await page.ready();
  try {
    await act(async () => {
      setInputValue(inputById(page.container, "settings-budget-engagement"), "2000000");
    });
    await clickSave(page.container);

    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    // The static range hint is always on screen, so assert the error sentence itself.
    assert.ok(page.container.textContent?.includes("Enter an amount in USD between 0 and 1000000"));
    // The rejected value survives so the operator can fix it.
    const engagement = inputById(page.container, "settings-budget-engagement");
    assert.equal(engagement.value, "2000000");
    assert.equal(engagement.getAttribute("aria-invalid"), "true");
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("a guardrail save in flight disables the actions and a failure keeps the edits", async () => {
  const calls = stubFetch();
  const priorFetch = globalThis.fetch;
  const routed = globalThis.fetch;
  let releasePut = () => {};
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/settings" && (init?.method ?? "GET") === "PUT") {
      calls.push({ method: "PUT", url: target, body: JSON.parse(String(init?.body)) });
      await new Promise<void>((resolve) => {
        releasePut = resolve;
      });
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as unknown as Response;
    }
    return routed(url, init);
  }) as typeof fetch;

  const page = mountPage(RuntimeSettingsPage);
  await page.ready();
  try {
    await act(async () => {
      setInputValue(inputById(page.container, "settings-budget-engagement"), "750");
    });
    await clickSave(page.container);

    // The request is still open: both actions are locked and the label says so.
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    assert.equal(buttonByText(page.container, "Saving…").disabled, true);
    assert.equal(buttonByText(page.container, "Discard changes").disabled, true);

    await act(async () => {
      releasePut();
      await flush();
    });

    assert.ok(page.container.textContent?.includes("The settings service is unavailable."));
    // The failed save leaves the operator's edit in place to retry.
    assert.equal(inputById(page.container, "settings-budget-engagement").value, "750");
    assert.equal(buttonByText(page.container, "Save changes").disabled, false);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the runtime screen reports the privacy and workspace facts as read-only", async () => {
  stubFetch({
    getResponse: {
      telemetryMode: "research",
      authPriority: ["anthropic_oauth", "openai_api"],
      skillogyEmbedModel: "voyage/voyage-3",
    },
  });
  const priorFetch = globalThis.fetch;
  const page = mountPage(RuntimeSettingsPage);
  await page.ready();
  try {
    assert.ok(page.container.textContent?.includes(translate("en", "settings.privacy.title")));
    assert.ok(page.container.textContent?.includes(translate("en", "settings.effect.readOnly")));

    // Each privacy row is a report, not a control: the id exists, no input does.
    for (const id of [
      "settings-privacy-telemetry",
      "settings-privacy-auth-priority",
      "settings-privacy-embed-model",
    ]) {
      assert.ok(page.container.querySelector(`#${id}`), `${id} row missing`);
      assert.equal(page.container.querySelector(`input#${id}, select#${id}`), null, `${id} became editable`);
    }
    assert.ok(page.container.textContent?.includes("Research (adds masked trajectories)"));
    assert.ok(page.container.textContent?.includes("anthropic_oauth → openai_api"));
    assert.ok(page.container.textContent?.includes("voyage/voyage-3"));

    // The workspace root is reported by the deployment card; no editable row remains.
    assert.ok(page.container.querySelector("#settings-deployment-workspace"));
    assert.equal(page.container.querySelector("#settings-workspace"), null);
    // Read-only values cannot make the form dirty.
    assert.equal(buttonByText(page.container, "Save changes").disabled, true);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});
