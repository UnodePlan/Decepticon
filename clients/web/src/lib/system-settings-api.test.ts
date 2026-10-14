import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError } from "./auth-bridge";
import {
  environmentApiKey,
  loadSettings,
  saveSettings,
  settingsProxyUrl,
  snapshotFromRows,
  type SettingsStore,
} from "./system-settings-runtime";
import { getSettings, putSettings, testModel, type SettingsApiDeps } from "./system-settings-api";
import {
  SETTING_KEYS,
  SETTINGS_SECRET_FIELDS,
  storedApiKey,
  type SettingRow,
  type SettingsEnv,
} from "./system-settings";

const ENV: SettingsEnv = {
  WORKSPACE_PATH: "/workspace",
  WEB_PORT: "3000",
  DATABASE_URL: "postgres://user:pw@db:5432/decepticon_web",
  LITELLM_MASTER_KEY: "sk-master",
  DECEPTICON_MODEL_PROFILE: "eco",
};

/** In-memory stand-in for the Prisma store, including its upsert/delete semantics. */
function memoryStore(initial: SettingRow[] = []): SettingsStore & { rows: Map<string, string> } {
  const rows = new Map(initial.map((row) => [row.key, row.value]));
  return {
    rows,
    async read() {
      return [...rows].map(([key, value]) => ({ key, value }));
    },
    async write(changes) {
      for (const { key, value } of changes) {
        if (value === null) rows.delete(key);
        else rows.set(key, value);
      }
    },
  };
}

function deps(store: SettingsStore, overrides: Partial<SettingsApiDeps> = {}): SettingsApiDeps {
  return { store, authenticate: async () => ({}), env: ENV, ...overrides };
}

function jsonRequest(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("GET returns the defaults when the store is empty", async () => {
  const response = await getSettings(deps(memoryStore()));
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    modelProfile: "eco",
    globalModelOverride: "",
    modelOverrides: {},
    language: "en",
    llmTimeoutSeconds: 120,
    llmMaxRetries: 2,
    workspacePath: "/workspace",
    langGraphBrowserUrl: "http://localhost:2024",
    terminalBrowserUrl: "ws://localhost:3003",
    reasoningEffort: "none",
    llmMaxOutputTokens: 64000,
    llmDisableStreaming: false,
    llmExtraHeaderNames: [],
    budgetEngagementUsd: null,
    budgetPerAgentUsd: null,
    budgetSoftWarnAtPct: 70,
    hitlEnabled: false,
    llmProxyApiKeySet: false,
    authMode: "unconfigured",
    databaseConfigured: true,
    deploymentWebPort: "3000",
    telemetryMode: "off",
    authPriority: [],
    skillogyEmbedModel: "openai/text-embedding-3-small",
  });
});

test("the new writable fields persist, clear and reject like the existing ones", async () => {
  const store = memoryStore();
  const written = await putSettings(
    jsonRequest({
      reasoningEffort: "high",
      llmMaxOutputTokens: 32768,
      llmDisableStreaming: true,
      budgetEngagementUsd: 500,
      budgetPerAgentUsd: 12.5,
      budgetSoftWarnAtPct: 85,
      hitlEnabled: true,
    }),
    deps(store),
  );
  assert.equal(written.status, 200);
  const payload = await body(written);
  assert.equal(payload.reasoningEffort, "high");
  assert.equal(payload.llmMaxOutputTokens, 32768);
  assert.equal(payload.llmDisableStreaming, true);
  assert.equal(payload.budgetEngagementUsd, 500);
  assert.equal(payload.budgetPerAgentUsd, 12.5);
  assert.equal(payload.budgetSoftWarnAtPct, 85);
  assert.equal(payload.hitlEnabled, true);
  assert.deepEqual([...store.rows.keys()].sort(), [
    SETTING_KEYS.budgetEngagementUsd,
    SETTING_KEYS.budgetPerAgentUsd,
    SETTING_KEYS.budgetSoftWarnAtPct,
    SETTING_KEYS.hitlEnabled,
    SETTING_KEYS.llmDisableStreaming,
    SETTING_KEYS.llmMaxOutputTokens,
    SETTING_KEYS.reasoningEffort,
  ]);

  // `0` means "no per-run cap", so it normalises to the same thing as clearing:
  // the deployment value governs and no row claims a limit the agent ignores.
  const zeroed = await putSettings(jsonRequest({ budgetEngagementUsd: 0 }), deps(store));
  assert.equal((await body(zeroed)).budgetEngagementUsd, null);
  assert.equal(store.rows.has(SETTING_KEYS.budgetEngagementUsd), false);

  // Clearing deletes the rows, back to the deployment defaults.
  const cleared = await putSettings(
    jsonRequest({
      reasoningEffort: "",
      llmMaxOutputTokens: "",
      budgetPerAgentUsd: "",
      budgetSoftWarnAtPct: "",
    }),
    deps(store),
  );
  assert.equal(cleared.status, 200);
  const clearedPayload = await body(cleared);
  assert.equal(clearedPayload.reasoningEffort, "none");
  assert.equal(clearedPayload.llmMaxOutputTokens, 64000);
  assert.equal(clearedPayload.budgetPerAgentUsd, null);
  assert.equal(clearedPayload.budgetSoftWarnAtPct, 70);
  // Clear-by-field semantics, not row order: the four cleared fields lose their
  // rows, and the two boolean rows the patch never mentioned keep their values.
  assert.equal(store.rows.size, 2, "only the untouched rows survive");
  assert.equal(store.rows.get(SETTING_KEYS.llmDisableStreaming), "true");
  assert.equal(store.rows.get(SETTING_KEYS.hitlEnabled), "true");

  const invalid = await putSettings(
    jsonRequest({
      reasoningEffort: "maximal",
      llmMaxOutputTokens: 200000,
      budgetSoftWarnAtPct: 900,
      hitlEnabled: "true",
    }),
    deps(memoryStore()),
  );
  assert.equal(invalid.status, 400);
  const invalidPayload = await body(invalid);
  assert.deepEqual(invalidPayload.fields, {
    reasoningEffort: 'must be one of none, low, medium, high, xhigh, max or "" to reset',
    llmMaxOutputTokens: "must be an integer between 256 and 128000",
    budgetSoftWarnAtPct: "must be a number between 0 and 100",
    hitlEnabled: "must be a boolean",
  });

  const readonly = await putSettings(
    jsonRequest({
      telemetryMode: "research",
      authPriority: ["openai_api"],
      skillogyEmbedModel: "x",
      // The workspace root is deployment-owned: a PUT must say so rather than
      // "unknown field", so the UI can label it exactly like the startup facts.
      workspacePath: "/srv/engagements",
    }),
    deps(memoryStore()),
  );
  assert.equal(readonly.status, 400);
  assert.deepEqual((await body(readonly)).fields, {
    telemetryMode: "read-only field",
    authPriority: "read-only field",
    skillogyEmbedModel: "read-only field",
    workspacePath: "read-only field",
  });
});

test("unauthenticated requests are rejected with 401 on every verb", async () => {
  const reject = () => Promise.reject(new AuthError());
  const store = memoryStore();

  for (const response of [
    await getSettings(deps(store, { authenticate: reject })),
    await putSettings(jsonRequest({ language: "zh" }), deps(store, { authenticate: reject })),
    await testModel(jsonRequest({ model: "openai/gpt-5" }), deps(store, { authenticate: reject })),
  ]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await body(response), { error: "Unauthorized" });
  }
});

test("a partial PUT keeps untouched fields and returns the merged snapshot", async () => {
  const store = memoryStore([
    { key: SETTING_KEYS.reasoningEffort, value: "high" },
    { key: SETTING_KEYS.llmMaxOutputTokens, value: "32000" },
  ]);

  const response = await putSettings(jsonRequest({ language: "zh", globalModelOverride: "openai/gpt-5" }), deps(store));
  assert.equal(response.status, 200);

  const snapshot = await body(response);
  assert.equal(snapshot.reasoningEffort, "high", "an absent field keeps its stored value");
  assert.equal(snapshot.llmMaxOutputTokens, 32000);
  assert.equal(snapshot.language, "zh");
  assert.equal(snapshot.globalModelOverride, "openai/gpt-5");
  assert.deepEqual([...store.rows.keys()].sort(), [
    SETTING_KEYS.globalModelOverride,
    SETTING_KEYS.language,
    SETTING_KEYS.llmMaxOutputTokens,
    SETTING_KEYS.reasoningEffort,
  ]);
});

test("clearing a field deletes its row so the deployment default applies again", async () => {
  const store = memoryStore([
    { key: SETTING_KEYS.language, value: "zh" },
    { key: SETTING_KEYS.modelOverrides, value: JSON.stringify({ decepticon: "openai/gpt-5" }) },
  ]);

  const response = await putSettings(jsonRequest({ language: "", modelOverrides: {} }), deps(store));
  assert.equal(response.status, 200);
  const snapshot = await body(response);
  assert.equal(snapshot.language, "en");
  assert.deepEqual(snapshot.modelOverrides, {});
  assert.equal(store.rows.size, 0, "both rows are deleted, not blanked");
});

test("malformed JSON, unknown fields and unknown roles are 400 with field detail", async () => {
  const store = memoryStore();
  const badJson = await putSettings(
    { json: async () => Promise.reject(new SyntaxError("unexpected token")) } as unknown as Request,
    deps(store),
  );
  assert.equal(badJson.status, 400);
  assert.deepEqual(await body(badJson), { error: "Request body must be valid JSON" });

  const unknownField = await putSettings(jsonRequest({ nope: true }), deps(store));
  assert.equal(unknownField.status, 400);
  assert.deepEqual(await body(unknownField), { error: "Invalid settings", fields: { nope: "unknown field" } });

  const readonly = await putSettings(jsonRequest({ authMode: "disabled" }), deps(store));
  assert.equal(readonly.status, 400);
  assert.deepEqual(await body(readonly), {
    error: "Invalid settings",
    fields: { authMode: "read-only field" },
  });

  const unknownRole = await putSettings(jsonRequest({ modelOverrides: { ghost: "openai/gpt-5" } }), deps(store));
  assert.equal(unknownRole.status, 400);
  const payload = await body(unknownRole);
  assert.deepEqual(payload.fields, { modelOverrides: 'unknown agent role "ghost"' });
  assert.equal(store.rows.size, 0, "an invalid patch writes nothing");
});

test("a storage failure is a 500 that never echoes the driver message", async () => {
  const failing: SettingsStore = {
    read: async () => {
      throw new Error("connect ECONNREFUSED postgres://user:pw@db:5432/decepticon_web");
    },
    write: async () => {
      throw new Error("relation \"SystemSetting\" does not exist");
    },
  };

  const read = await getSettings(deps(failing));
  assert.equal(read.status, 500);
  const readBody = await read.json();
  assert.deepEqual(readBody, { error: "Failed to read settings" });
  assert.equal(JSON.stringify(readBody).includes("pw@db"), false);

  const write = await putSettings(jsonRequest({ language: "zh" }), deps(failing));
  assert.equal(write.status, 500);
  assert.deepEqual(await body(write), { error: "Failed to save settings" });
});

test("the stored proxy key is never returned, only its existence", async () => {
  const secret = "sk-super-secret-virtual-key";
  const store = memoryStore([{ key: SETTING_KEYS.llmProxyApiKey, value: secret }]);

  for (const response of [
    await getSettings(deps(store)),
    await putSettings(jsonRequest({ language: "zh" }), deps(store)),
  ]) {
    const payload = await body(response);
    assert.equal(payload.llmProxyApiKeySet, true);
    for (const secretField of SETTINGS_SECRET_FIELDS) {
      assert.equal(Object.hasOwn(payload, secretField), false);
    }
    assert.equal(JSON.stringify(payload).includes(secret), false);
  }

  const cleared = await putSettings(jsonRequest({ llmProxyApiKey: "" }), deps(store));
  assert.equal((await body(cleared)).llmProxyApiKeySet, false);
  assert.equal(store.rows.size, 1, "only the key row is cleared; the language row remains");

  const set = await putSettings(jsonRequest({ llmProxyApiKey: secret }), deps(store));
  const setPayload = await body(set);
  assert.equal(setPayload.llmProxyApiKeySet, true);
  assert.equal(JSON.stringify(setPayload).includes(secret), false);
  assert.equal(store.rows.get(SETTING_KEYS.llmProxyApiKey), secret, "server-side storage keeps the real value");
});

test("the stored key overrides the deployment credential for proxy calls", async () => {
  const store = memoryStore();
  assert.equal((await loadSettings(store, ENV)).apiKey, "sk-master", "falls back to the env credential");

  await saveSettings({ llmProxyApiKey: "sk-virtual" }, store, ENV);
  assert.equal((await loadSettings(store, ENV)).apiKey, "sk-virtual");
  assert.equal(storedApiKey([...store.rows].map(([key, value]) => ({ key, value }))[0]), "sk-virtual");
  assert.equal(environmentApiKey({ DECEPTICON_LLM__PROXY_API_KEY: "sk-core" }), "sk-core");
  assert.equal(environmentApiKey({}), "");
  assert.equal(settingsProxyUrl({ LITELLM_URL: "http://proxy:4000/" }), "http://proxy:4000");
  assert.equal(settingsProxyUrl({ DECEPTICON_LLM__PROXY_URL: "http://core:4000/" }), "http://core:4000");
  assert.equal(
    settingsProxyUrl({ DECEPTICON_LLM__PROXY_URL: "http://core:4000", LITELLM_URL: "http://proxy:4000" }),
    "http://core:4000",
    "the agent core's proxy URL wins over the compose alias",
  );
  assert.equal(settingsProxyUrl({}), "http://litellm:4000");
});

test("snapshotFromRows merges stored rows over deployment defaults", () => {
  const snapshot = snapshotFromRows(
    [
      { key: SETTING_KEYS.language, value: "zh" },
      { key: SETTING_KEYS.llmProxyApiKey, value: "sk-x" },
    ],
    ENV,
  );
  assert.equal(snapshot.language, "zh");
  assert.equal(snapshot.modelProfile, "eco");
  assert.equal(snapshot.workspacePath, "/workspace");
  assert.equal(snapshot.llmProxyApiKeySet, true);
  assert.equal(snapshot.databaseConfigured, true);
  assert.equal(snapshot.telemetryMode, "off");
  assert.deepEqual(snapshot.authPriority, []);
  assert.equal(snapshot.skillogyEmbedModel, "openai/text-embedding-3-small");
});

test("the read-only deployment values are reported from the environment, never from rows", () => {
  const env: SettingsEnv = {
    ...ENV,
    DECEPTICON_TELEMETRY: "research",
    DECEPTICON_AUTH_PRIORITY: "anthropic_oauth,telepathy,openai_api",
    DECEPTICON_SKILLOGY_EMBED_MODEL: "voyage/voyage-3",
  };
  // A hand-written row with a matching key must not be mistaken for a stored value.
  const snapshot = snapshotFromRows(
    [
      { key: "telemetry_mode", value: "basic" },
      { key: "auth_priority", value: "openai_api" },
      { key: "skillogy_embed_model", value: "other/model" },
    ],
    env,
  );
  assert.equal(snapshot.telemetryMode, "research");
  assert.deepEqual(snapshot.authPriority, ["anthropic_oauth", "openai_api"], "unknown slugs are dropped");
  assert.equal(snapshot.skillogyEmbedModel, "voyage/voyage-3");
});

test("the global extra-header VALUE never reaches the response, names only", () => {
  // Values are credentials-adjacent and the run input round-trips through the
  // LangGraph checkpoint, so they are a startup-scoped deployment value: the agent
  // process reads `DECEPTICON_LLM_EXTRA_HEADERS` itself and the API answers with the
  // configured NAMES.
  const snapshot = snapshotFromRows([], { ...ENV, DECEPTICON_LLM_EXTRA_HEADERS: '{"X-Tenant": "acme"}' });
  assert.deepEqual(snapshot.llmExtraHeaderNames, ["x-tenant"]);
  assert.equal(
    JSON.stringify(snapshot).includes("acme"),
    false,
    "the header value must not appear anywhere in the payload",
  );

  const stored = snapshotFromRows(
    [{ key: SETTING_KEYS.llmExtraHeaders, value: JSON.stringify({ Authorization: "Bearer sk-live" }) }],
    ENV,
  );
  assert.deepEqual(stored.llmExtraHeaderNames, [], "a legacy row is not read back either");
  assert.equal(JSON.stringify(stored).includes("sk-live"), false);
});

test("the model probe reports registration without leaking the credential", async () => {
  const store = memoryStore([{ key: SETTING_KEYS.llmProxyApiKey, value: "sk-virtual" }]);
  let seenAuth: string | null = null;

  const registered = await testModel(
    jsonRequest({ model: "openai/gpt-5", role: "decepticon" }),
    deps(store, {
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenAuth = (init.headers as Record<string, string>).Authorization;
        assert.equal(url, "http://litellm:4000/v1/models");
        return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }, { id: "eco" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal(registered.status, 200);
  const payload = await body(registered);
  assert.equal(payload.ok, true);
  assert.equal(payload.model, "openai/gpt-5");
  assert.equal(JSON.stringify(payload).includes("sk-virtual"), false);
  assert.equal(seenAuth, "Bearer sk-virtual", "the key is attached server-side only");

  const missing = await testModel(
    jsonRequest({ model: "openai/gpt-6" }),
    deps(store, {
      fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    }),
  );
  assert.equal(missing.status, 200, "an unregistered model is a successful probe");
  assert.equal((await body(missing)).ok, false);
});

test("the model probe maps invalid input and upstream failures onto 400/502", async () => {
  const store = memoryStore([{ key: SETTING_KEYS.llmProxyApiKey, value: "sk-virtual" }]);

  for (const invalid of [{}, { model: "" }, { model: "two words" }, { model: "openai/gpt-5", role: "ghost" }]) {
    const response = await testModel(jsonRequest(invalid), deps(store));
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }

  const upstreamError = await testModel(
    jsonRequest({ model: "openai/gpt-5" }),
    deps(store, {
      fetchImpl: (async () =>
        new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } })) as unknown as typeof fetch,
    }),
  );
  assert.equal(upstreamError.status, 502);
  const payload = await body(upstreamError);
  assert.deepEqual(payload, { error: "LiteLLM returned HTTP 401" }, "no upstream headers or body are forwarded");

  const unreachable = await testModel(
    jsonRequest({ model: "openai/gpt-5" }),
    deps(store, {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED http://litellm:4000");
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal(unreachable.status, 502);
  assert.deepEqual(await body(unreachable), { error: "LiteLLM proxy unreachable" });

  const noCredential = await testModel(
    jsonRequest({ model: "openai/gpt-5" }),
    deps(memoryStore(), { env: { ...ENV, LITELLM_MASTER_KEY: undefined } }),
  );
  assert.equal(noCredential.status, 502);
  assert.match(String((await body(noCredential)).error), /No LiteLLM credential configured/);

  const storageDown = await testModel(
    jsonRequest({ model: "openai/gpt-5" }),
    deps({
      read: async () => {
        throw new Error("relation \"SystemSetting\" does not exist");
      },
      write: async () => {},
    }),
  );
  assert.equal(storageDown.status, 500, "a store failure is not reported as an upstream failure");
  assert.deepEqual(await body(storageDown), { error: "Failed to read settings" });
});
