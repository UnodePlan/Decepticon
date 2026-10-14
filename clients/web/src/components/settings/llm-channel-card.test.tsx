import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n-context";
import ModelSettingsPage from "../../app/(dashboard)/settings/models/page";
import type { SettingsSnapshot } from "@/lib/system-settings";
import {
  CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS,
} from "@/lib/llm-channel";
import type { LlmChannelSnapshot } from "@/lib/llm-channel-form";

/**
 * The channel card is exercised through its real screen (`/settings/models`):
 * the interesting behaviour is how a channel save rewrites the global model
 * override (and the screen's baseline), how the credential rules survive an
 * edited base URL, and what the protocol/token/header fields put on the wire.
 *
 * `test-setup.ts` installs the jsdom window as a process global, so the base-ui
 * select can be driven by dispatching pointer events on its options.
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

const CHANNEL_BASE = "https://gateway.internal/v1";
const ALIAS = "openai/decepticon-custom-3f9ac1";
const MODELS = ["gpt-4o-mini", "qwen2.5-72b-instruct"];
/** A channel as an older deployment stores it: protocol/token/header fields absent. */
const STORED_CHANNEL = { apiBase: "", apiKeySet: false, model: "" };

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface StubOptions {
  /** Only the fields a case cares about; the rest come from the documented defaults. */
  channel?: Partial<LlmChannelSnapshot>;
  models?: string[] | { status: number; body: unknown };
  channelPut?: Partial<LlmChannelSnapshot> & { globalModelOverride?: string };
  channelPutFailure?: { status: number; body: unknown };
  channelTest?: { status: number; body: unknown };
  channelGetFailure?: { status: number; body: unknown };
  settingsPut?: Partial<SettingsSnapshot>;
}

/** Route every fetch the settings page makes; the channel routes record bodies. */
function stubFetch(options: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const channel = { ...STORED_CHANNEL, ...options.channel };

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: target, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (target === "/api/settings/llm-channel/models") {
      const response =
        options.models && !Array.isArray(options.models)
          ? options.models
          : { status: 200, body: { models: options.models ?? MODELS } };
      return {
        ok: response.status < 400,
        status: response.status,
        json: async () => response.body,
      } as unknown as Response;
    }

    if (target === "/api/settings/llm-channel/test") {
      const response = options.channelTest ?? { status: 200, body: { ok: true, detail: "The endpoint answered the test request" } };
      return {
        ok: response.status < 400,
        status: response.status,
        json: async () => response.body,
      } as unknown as Response;
    }

    if (target === "/api/settings/llm-channel") {
      if (method === "GET") {
        const failure = options.channelGetFailure;
        return {
          ok: !failure,
          status: failure?.status ?? 200,
          json: async () => failure?.body ?? channel,
        } as unknown as Response;
      }
      const failure = options.channelPutFailure;
      if (failure) {
        return { ok: false, status: failure.status, json: async () => failure.body } as unknown as Response;
      }
      // A real PUT registers the model and rewrites the global override; the stub
      // mirrors that so the page has to resync from the response.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          apiBase: CHANNEL_BASE,
          apiKeySet: true,
          model: MODELS[1],
          globalModelOverride: ALIAS,
          ...options.channelPut,
        }),
      } as unknown as Response;
    }

    if (target === "/api/settings") {
      const payload =
        method === "PUT" ? (options.settingsPut ?? SNAPSHOT) : SNAPSHOT;
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    }

    const payload = target === "/api/health" ? { services: [] } : [];
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

interface MountedPage {
  container: HTMLElement;
  ready: () => Promise<void>;
  unmount: () => Promise<void>;
}

function mountModelsPage(locale = "en"): MountedPage {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  return {
    container,
    async ready() {
      await act(async () => {
        root.render(
          <I18nProvider initialLocale={locale}>
            <ModelSettingsPage />
          </I18nProvider>,
        );
      });
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

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(button, `button "${label}" not found`);
  return button as HTMLButtonElement;
}

function hasButton(container: HTMLElement, label: string): boolean {
  return [...container.querySelectorAll("button")].some(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = buttonByText(container, label);
  assert.equal(button.disabled, false, `button "${label}" is disabled`);
  await act(async () => {
    button.click();
    await flush();
  });
}

async function type(container: HTMLElement, id: string, value: string): Promise<void> {
  await act(async () => {
    setInputValue(inputById(container, id), value);
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

/** Type into a header row by position: the card renders name/value input pairs. */
async function typeHeader(container: HTMLElement, row: number, name: string, value: string): Promise<void> {
  const names = [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Header name"]')];
  const values = [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Value"]')];
  assert.ok(names[row] && values[row], `header row ${row} not found`);
  await act(async () => {
    setInputValue(names[row], name);
    setInputValue(values[row], value);
  });
}

/** Run a case against a fresh page with the console's fetches stubbed. */
async function withPage(
  options: StubOptions,
  run: (page: MountedPage, calls: RecordedCall[]) => Promise<void>,
  locale = "en",
): Promise<void> {
  const calls = stubFetch(options);
  const priorFetch = globalThis.fetch;
  const page = mountModelsPage(locale);
  await page.ready();
  try {
    await run(page, calls);
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
}

test("the channel card loads the saved base and model and never echoes the key", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[0] } },
    async (page) => {
      assert.equal(inputById(page.container, "settings-channel-base").value, CHANNEL_BASE);
      // The write-only key field is always rendered empty, even when a key exists.
      assert.equal(inputById(page.container, "settings-channel-key").value, "");
      assert.ok(page.container.textContent?.includes("A key is saved"));
      // The stored model is what the dropdown shows before any fetch.
      assert.ok(inputById(page.container, "settings-channel-model").textContent?.includes(MODELS[0]));
      // Nothing typed yet → the channel save button is disabled.
      assert.equal(buttonByText(page.container, "Save channel").disabled, true);
      // A channel loaded from a pre-protocol row shows the defaults it is used with.
      assert.equal(inputById(page.container, "settings-channel-context").value, String(CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS));
      assert.equal(inputById(page.container, "settings-channel-output").value, String(CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS));
    },
  );
});

test("fetching models for an unchanged base reuses the stored key and names the protocol", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "" } },
    async (page, calls) => {
      await click(page.container, "Fetch models");

      const post = calls.filter((call) => call.method === "POST");
      assert.equal(post.length, 1);
      assert.equal(post[0].url, "/api/settings/llm-channel/models");
      // The key is neither re-sent nor retyped: the base is unchanged, so the
      // server may reuse the key it already holds. The protocol always travels —
      // discovery has no stored value to fall back to.
      assert.deepEqual(post[0].body, { apiBase: CHANNEL_BASE, protocol: "chat_completions" });
      assert.ok(page.container.textContent?.includes("2 models available"));

      await chooseOption(page.container, "settings-channel-model", MODELS[1]);
      assert.ok(inputById(page.container, "settings-channel-model").textContent?.includes(MODELS[1]));
    },
  );
});

test("an edited base URL sends a new credential and warns that the saved key is not reused", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "" } },
    async (page, calls) => {
      await type(page.container, "settings-channel-base", "https://other.example.com/v1");
      assert.ok(
        page.container.textContent?.includes(
          "The base URL changed, so the saved key is not reused — this endpoint is contacted without a key unless you enter one."
        )
      );

      await click(page.container, "Fetch models");
      const post = calls.filter((call) => call.method === "POST");
      assert.equal(post.length, 1);
      // An explicit "" means "no credential": the stored key belongs to another host.
      assert.deepEqual(post[0].body, {
        apiBase: "https://other.example.com/v1",
        protocol: "chat_completions",
        apiKey: "",
      });

      await type(page.container, "settings-channel-key", "sk-typed-once");
      await click(page.container, "Fetch models");
      const latest = calls.filter((call) => call.method === "POST").at(-1);
      assert.deepEqual(latest?.body, {
        apiBase: "https://other.example.com/v1",
        protocol: "chat_completions",
        apiKey: "sk-typed-once",
      });
    },
  );
});

test("switching protocol clears the models fetched with the previous one", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "" } },
    async (page, calls) => {
      await click(page.container, "Fetch models");
      assert.ok(page.container.textContent?.includes("2 models available"));

      await chooseOption(page.container, "settings-channel-protocol", "Responses");
      // The listing came from the chat-completions discovery path: offering it
      // under another protocol would present models the endpoint never listed for it.
      assert.equal(page.container.textContent?.includes("2 models available"), false);

      await click(page.container, "Fetch models");
      const latest = calls.filter((call) => call.method === "POST").at(-1);
      assert.deepEqual(latest?.body, { apiBase: CHANNEL_BASE, protocol: "responses" });
    },
  );
});

test("every protocol the contract registers is offered, including Anthropic Messages", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "" } },
    async (page) => {
      assert.ok(page.container.textContent?.includes("Request protocol"));

      await act(async () => {
        page.container
          .querySelector<HTMLElement>("#settings-channel-protocol")
          ?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await flush();
      });
      const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
        option.textContent?.trim(),
      );
      assert.deepEqual(options, ["Chat completions", "Responses", "Anthropic messages"]);
      await act(async () => {
        document.body.click();
        await flush();
      });
    },
  );
});

test("picking Anthropic Messages asks for the model id instead of a listing", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "claude-x", protocol: "messages" } },
    async (page) => {
      // The Messages API has no standard `/models`: the card must not offer Fetch
      // models for it, and the stored id is typed in rather than picked.
      assert.equal(hasButton(page.container, "Fetch models"), false);
      assert.equal(inputById(page.container, "settings-channel-model").value, "claude-x");
    },
  );
});

test("saving a channel sends the protocol, token budget and headers with the alias registration", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "" }, models: MODELS },
    async (page, calls) => {
      // A global override typed by hand and not yet saved: it must not survive the
      // channel save, or the page would PUT the stale id over the channel's alias.
      await type(page.container, "settings-global-model", "openai/stale-by-hand");
      assert.equal(buttonByText(page.container, "Save changes").disabled, false);

      await click(page.container, "Fetch models");
      await chooseOption(page.container, "settings-channel-model", MODELS[1]);
      await chooseOption(page.container, "settings-channel-protocol", "Responses");
      await click(page.container, "Fetch models");
      await chooseOption(page.container, "settings-channel-model", MODELS[1]);
      await type(page.container, "settings-channel-context", "32768");
      await type(page.container, "settings-channel-output", "4096");
      await typeHeader(page.container, 0, "x-team", "red");
      // A typed key travels with the save and is never stored in the page's state.
      await type(page.container, "settings-channel-key", "sk-replacement");
      await click(page.container, "Save channel");

      const put = calls.filter((call) => call.method === "PUT");
      assert.equal(put.length, 1);
      assert.deepEqual(put[0].body, {
        apiBase: CHANNEL_BASE,
        apiKey: "sk-replacement",
        model: MODELS[1],
        protocol: "responses",
        contextWindowTokens: 32768,
        maxOutputTokens: 4096,
        extraHeaders: { "x-team": "red" },
      });

      // The page adopts the alias into both the baseline and the draft…
      assert.equal(inputById(page.container, "settings-global-model").value, ALIAS);
      // …so the unsaved global draft disappears and the main save button is inert.
      assert.equal(buttonByText(page.container, "Save changes").disabled, true);
      // The write-only field empties itself again; only existence is reported.
      assert.equal(inputById(page.container, "settings-channel-key").value, "");
      assert.ok(page.container.textContent?.includes("A key is saved"));
      assert.ok(
        page.container.textContent?.includes(`Channel saved — the global model override is now ${ALIAS}.`),
      );
    },
  );
});

test("an output budget above the context window is refused in the browser and never sent", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[0] } },
    async (page, calls) => {
      await type(page.container, "settings-channel-context", "2048");
      await type(page.container, "settings-channel-output", "4096");
      await click(page.container, "Save channel");

      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
      assert.ok(page.container.textContent?.includes("Max output tokens must not exceed the context window."));
      // The rejected pair stays on screen for correction.
      assert.equal(inputById(page.container, "settings-channel-context").value, "2048");
      assert.equal(inputById(page.container, "settings-channel-output").value, "4096");
    },
  );
});

test("the test button probes the unsaved draft and a rejection keeps the input", async () => {
  await withPage(
    {
      channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "" },
      channelTest: { status: 404, body: { ok: false, detail: "The endpoint has no /responses route for this protocol" } },
    },
    async (page, calls) => {
      await click(page.container, "Fetch models");
      await chooseOption(page.container, "settings-channel-model", MODELS[0]);
      await type(page.container, "settings-channel-output", "1024");
      await click(page.container, "Test endpoint");

      const probe = calls.filter((call) => call.url === "/api/settings/llm-channel/test");
      assert.equal(probe.length, 1);
      assert.deepEqual(probe[0].body, {
        apiBase: CHANNEL_BASE,
        model: MODELS[0],
        protocol: "chat_completions",
        contextWindowTokens: CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: 1024,
      });
      // The server's fixed sentence is shown; the draft survives for another try.
      assert.ok(page.container.textContent?.includes("The endpoint has no /responses route for this protocol"));
      assert.ok(inputById(page.container, "settings-channel-model").textContent?.includes(MODELS[0]));
      assert.equal(inputById(page.container, "settings-channel-output").value, "1024");
      // Nothing was registered: a failed probe never becomes a save.
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    },
  );
});

test("an invalid base URL is rejected in the browser and never sent", async () => {
  await withPage({ channel: STORED_CHANNEL }, async (page, calls) => {
    await type(page.container, "settings-channel-base", "not-a-url");
    await type(page.container, "settings-channel-key", "sk-abc");
    await click(page.container, "Save channel");

    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    assert.ok(
      page.container.textContent?.includes(
        "Enter an http(s) URL without credentials, query or fragment.",
      ),
    );
    assert.equal(inputById(page.container, "settings-channel-base").getAttribute("aria-invalid"), "true");
    // The rejected input stays on screen for correction.
    assert.equal(inputById(page.container, "settings-channel-base").value, "not-a-url");
  });
});

test("removing the channel reports the effective global override", async () => {
  await withPage(
    {
      channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[1] },
      channelPut: { apiBase: "", apiKeySet: false, model: "", globalModelOverride: "" },
    },
    async (page, calls) => {
      assert.ok(hasButton(page.container, "Remove channel"));
      await click(page.container, "Remove channel");

      const put = calls.filter((call) => call.method === "PUT");
      assert.equal(put.length, 1);
      // Clearing drops the base, the key and the model in one request.
      assert.deepEqual(put[0].body, { apiBase: "", apiKey: "", model: "" });

      assert.equal(inputById(page.container, "settings-channel-base").value, "");
      assert.ok(page.container.textContent?.includes("No key saved"));
      assert.ok(page.container.textContent?.includes("Channel removed."));
      // The alias is gone from the global override, so new sessions stop using it.
      assert.equal(inputById(page.container, "settings-global-model").value, "");
      // With nothing configured the removal affordance disappears again.
      assert.equal(hasButton(page.container, "Remove channel"), false);
    },
  );
});

test("removing the channel keeps an unrelated global override the server reports", async () => {
  // The server only unsets the override while it still points at this channel's
  // alias; the card must adopt whatever effective value comes back.
  await withPage(
    {
      channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[1] },
      channelPut: { apiBase: "", apiKeySet: false, model: "", globalModelOverride: "openai/typed-by-hand" },
    },
    async (page) => {
      await click(page.container, "Remove channel");

      assert.equal(inputById(page.container, "settings-global-model").value, "openai/typed-by-hand");
      // The adopted value matches the new baseline, so there is nothing to save.
      assert.equal(buttonByText(page.container, "Save changes").disabled, true);
      assert.ok(page.container.textContent?.includes("Channel removed."));
    },
  );
});

test("a rejected channel save shows a localized reason and keeps the input", async () => {
  await withPage(
    {
      channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: "" },
      models: MODELS,
      channelPutFailure: { status: 502, body: { error: "upstream refused connection" } },
    },
    async (page) => {
      await click(page.container, "Fetch models");
      await chooseOption(page.container, "settings-channel-model", MODELS[0]);
      await click(page.container, "Save channel");

      // The upstream wording never reaches the operator; a localized sentence does.
      assert.ok(
        page.container.textContent?.includes("The endpoint could not be reached or refused the credential."),
      );
      assert.ok(!page.container.textContent?.includes("upstream refused connection"));
      assert.equal(inputById(page.container, "settings-channel-model").textContent?.includes(MODELS[0]), true);
      assert.equal(inputById(page.container, "settings-channel-base").value, CHANNEL_BASE);
    },
  );
});

test("a saved header renders as a kept value that does not mark the form dirty", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[0], extraHeadersSet: ["x-team"] } },
    async (page) => {
      const names = [...page.container.querySelectorAll<HTMLInputElement>('input[aria-label="Header name"]')];
      // The name comes back, the value never does: the row is a placeholder for
      // "the stored value is kept unless you retype it".
      assert.equal(names[0].value, "x-team");
      const values = [...page.container.querySelectorAll<HTMLInputElement>('input[aria-label="Value"]')];
      assert.equal(values[0].value, "");
      assert.ok(page.container.textContent?.includes("Saved headers: x-team."));
      // And that untouched row alone is not an edit.
      assert.equal(buttonByText(page.container, "Save channel").disabled, true);

      await typeHeader(page.container, 0, "x-team", "blue");
      assert.equal(buttonByText(page.container, "Save channel").disabled, false);
    },
  );
});

test("a credential-bearing header name is refused in the browser before any request", async () => {
  await withPage(
    {
      channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[0] },
    },
    async (page, calls) => {
      await typeHeader(page.container, 0, "Authorization", "Bearer x");
      await click(page.container, "Save channel");

      // Same predicate as the server's validator: the request never leaves.
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
      assert.ok(
        page.container.textContent?.includes(
          "Check the header rows: names without spaces, values without line breaks, and no authorization or cookie headers.",
        ),
      );
      // The typed row is still there — the field is flagged, not discarded.
      const names = [...page.container.querySelectorAll<HTMLInputElement>('input[aria-label="Header name"]')];
      assert.equal(names[0].value, "Authorization");
      assert.equal(names[0].getAttribute("aria-invalid"), "true");
    },
  );
});

test("a server-side header rejection is reported on the field and keeps the typed row", async () => {
  await withPage(
    {
      channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[0] },
      channelPutFailure: {
        status: 400,
        body: { error: "Invalid channel", fields: { extraHeaders: "header \"x-long\" must be at most 2048 characters" } },
      },
    },
    async (page) => {
      // A name/value the shared browser rule accepts but the server still refuses
      // must land on the field, never on the status line as raw upstream text.
      await typeHeader(page.container, 0, "x-long", "short");
      await click(page.container, "Save channel");

      assert.ok(
        page.container.textContent?.includes(
          "Check the header rows: names without spaces, values without line breaks, and no authorization or cookie headers.",
        ),
      );
      assert.ok(!page.container.textContent?.includes("must be at most 2048 characters"));
      const names = [...page.container.querySelectorAll<HTMLInputElement>('input[aria-label="Header name"]')];
      assert.equal(names[0].value, "x-long");
      assert.equal(names[0].getAttribute("aria-invalid"), "true");
    },
  );
});

test("a failed channel load is reported and recoverable without hiding the rest of the page", async () => {
  const calls = stubFetch({
    channelGetFailure: { status: 500, body: { error: "storage unavailable" } },
  });
  const priorFetch = globalThis.fetch;
  const page = mountModelsPage();
  await page.ready();
  try {
    assert.ok(page.container.textContent?.includes("Failed to load the custom LLM channel"));
    assert.ok(page.container.textContent?.includes("The settings service is unavailable."));
    // The other settings still render, so the failure is scoped to the channel.
    assert.ok(page.container.textContent?.includes("Model Runtime"));

    // Recovery: the retry re-reads the channel only.
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({ method: init?.method ?? "GET", url: target, body: null });
      if (target === "/api/settings/llm-channel") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ apiBase: CHANNEL_BASE, apiKeySet: false, model: "" }),
        } as unknown as Response;
      }
      if (target === "/api/settings") {
        return { ok: true, status: 200, json: async () => SNAPSHOT } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }) as typeof fetch;

    await click(page.container, "Reload channel");
    assert.equal(inputById(page.container, "settings-channel-base").value, CHANNEL_BASE);
    assert.ok(!page.container.textContent?.includes("Failed to load the custom LLM channel"));
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the channel card survives a failed settings load", async () => {
  const calls: RecordedCall[] = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: target, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (target === "/api/settings") {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as unknown as Response;
    }
    if (target === "/api/settings/llm-channel" && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[0] }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => [] } as unknown as Response;
  }) as typeof fetch;

  const page = mountModelsPage();
  await page.ready();
  try {
    // The snapshot failed, so the editable cards are gone…
    assert.ok(page.container.textContent?.includes("Failed to load settings"));
    assert.equal(page.container.querySelector("#settings-global-model"), null);
    // …but the channel owns separate endpoints and stays usable.
    assert.equal(inputById(page.container, "settings-channel-base").value, CHANNEL_BASE);
    assert.ok(page.container.textContent?.includes("A key is saved"));
  } finally {
    await page.unmount();
    globalThis.fetch = priorFetch;
  }
});

test("the channel card is fully translated in Chinese", async () => {
  await withPage(
    { channel: { apiBase: CHANNEL_BASE, apiKeySet: true, model: MODELS[0] } },
    async (page, calls) => {
      for (const expected of [
        "自定义 LLM 渠道",
        "API Base 地址",
        "API Key",
        "请求协议",
        "上下文窗口（Token）",
        "最大输出 Token",
        "额外请求头",
        "测试端点",
        "拉取模型",
        "保存渠道",
        "移除渠道",
        "已保存密钥",
      ]) {
        assert.ok(page.container.textContent?.includes(expected), expected);
      }

      await type(page.container, "settings-channel-base", "ftp://nope");
      await click(page.container, "保存渠道");
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
      assert.ok(
        page.container.textContent?.includes("请输入不含凭据、查询参数或片段的 http(s) 地址。"),
      );

      await type(page.container, "settings-channel-base", CHANNEL_BASE);
      await type(page.container, "settings-channel-output", "abc");
      await click(page.container, "保存渠道");
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
      assert.ok(page.container.textContent?.includes("请填写允许范围内的整数最大输出 Token 数。"));
    },
    "zh",
  );
});
