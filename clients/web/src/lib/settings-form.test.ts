import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPatch,
  draftFromSnapshot,
  isDirty,
  parseSettingsSnapshot,
  saveSettingsPatch,
  testModelRegistration,
  validateDraft,
  type SettingsDraft,
  type TranslateFn,
} from "./settings-form";
import type { SettingsSnapshot } from "./system-settings";

const t: TranslateFn = (key) => key;

const SNAPSHOT: SettingsSnapshot = {
  modelProfile: "eco",
  globalModelOverride: "",
  modelOverrides: {},
  language: "en",
  llmTimeoutSeconds: 120,
  llmMaxRetries: 2,
  workspacePath: "/workspace",
  langGraphBrowserUrl: "http://localhost:2024",
  terminalBrowserUrl: "ws://localhost:3003",
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

const draft = (patch: Partial<SettingsDraft> = {}): SettingsDraft => ({
  ...draftFromSnapshot(SNAPSHOT),
  ...patch,
});

test("a freshly loaded snapshot produces a clean draft", () => {
  const fresh = draftFromSnapshot(SNAPSHOT);
  assert.deepEqual(buildPatch(SNAPSHOT, fresh), {});
  assert.equal(isDirty(SNAPSHOT, fresh), false);
  assert.equal(fresh.llmProxyApiKey, "");
  assert.deepEqual(validateDraft(SNAPSHOT, fresh, t), {});
});

test("snapshot values the PUT endpoint would reject never block saving another field", () => {
  // The deployment default LangGraph URL is root-relative; editing language must
  // still be saveable without forcing the operator to rewrite the endpoint.
  const relative: SettingsSnapshot = { ...SNAPSHOT, langGraphBrowserUrl: "/runtime", terminalBrowserUrl: "" };
  assert.deepEqual(validateDraft(relative, draftFromSnapshot(relative), t), {});
  assert.deepEqual(
    validateDraft(relative, { ...draftFromSnapshot(relative), language: "zh" }, t),
    {},
  );
});

test("validation rejects bad numbers, roles, URLs and relative paths", () => {
  assert.deepEqual(validateDraft(SNAPSHOT, draft(), t), {});

  assert.equal(
    validateDraft(SNAPSHOT, draft({ langGraphBrowserUrl: "ftp://x" }), t).langGraphBrowserUrl,
    "settings.runtime.error.langGraphUrl",
  );
  assert.equal(
    validateDraft(SNAPSHOT, draft({ terminalBrowserUrl: "http://x" }), t).terminalBrowserUrl,
    "settings.runtime.error.terminalUrl",
  );
  assert.equal(
    validateDraft(SNAPSHOT, draft({ modelOverrides: { "not-an-agent": "gpt-4o" } }), t).modelOverrides,
    "settings.model.error.role",
  );
  assert.equal(
    validateDraft(SNAPSHOT, draft({ globalModelOverride: "bad model" }), t).globalModelOverride,
    "settings.model.error.model",
  );
  assert.equal(
    validateDraft(SNAPSHOT, draft({ globalModelOverride: "x".repeat(201) }), t).globalModelOverride,
    "settings.model.error.model",
  );
  // Clearing a value is always allowed — it removes the DB override.
  assert.deepEqual(validateDraft({ ...SNAPSHOT, globalModelOverride: "openai/gpt-4o" }, draft(), t), {});
});

test("the patch carries only touched keys and clears the secret explicitly", () => {
  assert.deepEqual(buildPatch(SNAPSHOT, draft({ language: "zh" })), { language: "zh" });

  const full = buildPatch(
    SNAPSHOT,
    draft({
      globalModelOverride: " openai/gpt-4o ",
      modelOverrides: { decepticon: " openai/gpt-4o " },
      langGraphBrowserUrl: "https://lg.example.test",
      terminalBrowserUrl: "wss://term.example.test",
      llmProxyApiKey: " sk-secret ",
    }),
  );
  assert.deepEqual(full, {
    globalModelOverride: "openai/gpt-4o",
    modelOverrides: { decepticon: "openai/gpt-4o" },
    langGraphBrowserUrl: "https://lg.example.test",
    terminalBrowserUrl: "wss://term.example.test",
    llmProxyApiKey: "sk-secret",
  });

  const cleared = buildPatch({ ...SNAPSHOT, llmProxyApiKeySet: true }, draft({ clearProxyKey: true }));
  assert.deepEqual(cleared, { llmProxyApiKey: "" });
});

test("the new draft fields round-trip and report their own errors", () => {
  // Untouched new fields contribute nothing.
  assert.deepEqual(buildPatch(SNAPSHOT, draftFromSnapshot(SNAPSHOT)), {});

  const advanced = buildPatch(
    SNAPSHOT,
    draft({
      reasoningEffort: "medium",
      llmMaxOutputTokens: "32768",
      llmDisableStreaming: true,
      budgetEngagementUsd: "250",
      budgetPerAgentUsd: "25",
      budgetSoftWarnAtPct: "85",
      hitlEnabled: true,
    }),
  );
  assert.deepEqual(advanced, {
    reasoningEffort: "medium",
    llmMaxOutputTokens: 32768,
    llmDisableStreaming: true,
    budgetEngagementUsd: 250,
    budgetPerAgentUsd: 25,
    budgetSoftWarnAtPct: 85,
    hitlEnabled: true,
  });

  // The two new tiers round-trip through the form untouched: the draft keeps the
  // wire spelling, so the patch sends `xhigh`/`max` rather than a lower tier.
  for (const tier of ["xhigh", "max"] as const) {
    assert.deepEqual(buildPatch(SNAPSHOT, draft({ reasoningEffort: tier })), { reasoningEffort: tier });
    assert.equal(isDirty(SNAPSHOT, draft({ reasoningEffort: tier })), true);
  }

  // An empty text field means "clear the stored override", not "0".
  assert.deepEqual(buildPatch({ ...SNAPSHOT, budgetEngagementUsd: 100 }, draft({ budgetEngagementUsd: "" })), {
    budgetEngagementUsd: "",
  });
  assert.deepEqual(
    buildPatch(SNAPSHOT, draft({ llmMaxOutputTokens: "", budgetSoftWarnAtPct: "" })),
    { llmMaxOutputTokens: "", budgetSoftWarnAtPct: "" },
  );
  const bad = validateDraft(
    SNAPSHOT,
    draft({
      llmMaxOutputTokens: "12",
      budgetEngagementUsd: "-5",
      budgetSoftWarnAtPct: "900",
    }),
    t,
  );
  assert.equal(bad.llmMaxOutputTokens, "settings.models.error.maxOutput");
  assert.equal(bad.budgetEngagementUsd, "settings.guardrails.error.budget");
  assert.equal(bad.budgetSoftWarnAtPct, "settings.guardrails.error.softWarn");
  assert.deepEqual(
    validateDraft(
      SNAPSHOT,
      draft({
        llmMaxOutputTokens: "128000",
        budgetEngagementUsd: "0",
        budgetSoftWarnAtPct: "0",
      }),
      t,
    ),
    {},
    "bounds are inclusive, and 0/0 clear the per-run override instead of disabling a guardrail",
  );
  assert.deepEqual(
    validateDraft({ ...SNAPSHOT, llmDisableStreaming: true }, draft({ llmDisableStreaming: false }), t),
    {},
    "turning streaming back on is a real change, not an error",
  );
});

test("malformed snapshots are rejected instead of reaching the form", () => {
  assert.ok(parseSettingsSnapshot(SNAPSHOT));
  assert.equal(parseSettingsSnapshot(null), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, modelProfile: "turbo" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, language: "fr" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, modelOverrides: { a: 1 } }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, authMode: "oidc" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, reasoningEffort: "maximal" }), null);
  // The two new tiers are valid snapshot values, so a stored/effective `xhigh` or
  // `max` must reach the form instead of being reported as a malformed payload.
  assert.ok(parseSettingsSnapshot({ ...SNAPSHOT, reasoningEffort: "xhigh" }));
  assert.ok(parseSettingsSnapshot({ ...SNAPSHOT, reasoningEffort: "max" }));
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, llmMaxOutputTokens: "64000" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, llmDisableStreaming: "true" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, llmExtraHeaderNames: "x-trace" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, budgetEngagementUsd: "250" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, budgetSoftWarnAtPct: null }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, hitlEnabled: 1 }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, telemetryMode: "verbose" }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, authPriority: ["telepathy"] }), null);
  assert.equal(parseSettingsSnapshot({ ...SNAPSHOT, skillogyEmbedModel: 7 }), null);
  const { llmProxyApiKeySet, ...rest } = SNAPSHOT;
  assert.equal(typeof llmProxyApiKeySet, "boolean", "the guard reads the flag, not a cast");
  assert.equal(parseSettingsSnapshot(rest), null);
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

test("save classifies unauthorized, field and success responses", async () => {
  const original = globalThis.fetch;
  try {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), init });
      return jsonResponse(401, { error: "Unauthorized" });
    }) as typeof fetch;
    const unauthorized = await saveSettingsPatch({ language: "zh" }, t);
    assert.equal(unauthorized.snapshot, null);
    assert.equal(captured[0]?.url, "/api/settings");
    assert.equal(captured[0]?.init?.method, "PUT");
    assert.ok(JSON.parse(String(captured[0]?.init?.body)).language === "zh");

    globalThis.fetch = (async () => jsonResponse(400, { error: "invalid", fields: { language: "nope", extra: 3 } })) as typeof fetch;
    const invalid = await saveSettingsPatch({ language: "zh" }, t);
    assert.deepEqual(invalid.fields, { language: "nope" });
    assert.equal(invalid.message, "settings.error.invalid");

    globalThis.fetch = (async () => jsonResponse(400, {})) as typeof fetch;
    assert.equal((await saveSettingsPatch({ language: "zh" }, t)).message, "settings.error.invalid");

    globalThis.fetch = (async () => jsonResponse(401, { error: "Unauthorized" })) as typeof fetch;
    assert.equal((await saveSettingsPatch({ language: "zh" }, t)).message, "settings.error.unauthorized");

    globalThis.fetch = (async () => jsonResponse(500, null)) as typeof fetch;
    assert.equal((await saveSettingsPatch({ language: "zh" }, t)).message, "settings.error.server");

    globalThis.fetch = (async () => jsonResponse(200, { ...SNAPSHOT, language: "zh" })) as typeof fetch;
    const saved = await saveSettingsPatch({ language: "zh" }, t);
    assert.equal(saved.snapshot?.language, "zh");
    assert.deepEqual(saved.fields, {});

    globalThis.fetch = (async () => jsonResponse(200, { nope: true })) as typeof fetch;
    assert.equal((await saveSettingsPatch({ language: "zh" }, t)).message, "settings.error.server");

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    assert.equal((await saveSettingsPatch({ language: "zh" }, t)).message, "settings.error.network");
  } finally {
    globalThis.fetch = original;
  }
});

test("model test surfaces registration state and upstream failures", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      jsonResponse(200, { ok: true, model: "openai/gpt-4o", detail: "found" })) as typeof fetch;
    assert.deepEqual(await testModelRegistration("openai/gpt-4o"), {
      ok: true,
      model: "openai/gpt-4o",
      detail: "found",
    });

    globalThis.fetch = (async () =>
      jsonResponse(200, { ok: false, model: "openai/nope", detail: "not registered" })) as typeof fetch;
    assert.equal((await testModelRegistration("openai/nope")).ok, false);

    globalThis.fetch = (async () => jsonResponse(502, { error: "upstream unreachable" })) as typeof fetch;
    await assert.rejects(() => testModelRegistration("openai/nope"), /upstream unreachable/);

    globalThis.fetch = (async () => jsonResponse(200, { ok: "yes" })) as typeof fetch;
    await assert.rejects(() => testModelRegistration("openai/nope"), /Invalid test-model response/);
  } finally {
    globalThis.fetch = original;
  }
});
