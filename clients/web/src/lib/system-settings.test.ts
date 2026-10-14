import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthConfigured } from "./auth-crypto";
import {
  AUTH_METHODS,
  DEFAULT_SETTINGS,
  DEFAULT_SKILLOGY_EMBED_MODEL,
  FORBIDDEN_LLM_HEADER_NAMES,
  MODEL_PROFILES,
  MODEL_ROLE_IDS,
  REASONING_EFFORTS,
  SETTINGS_EFFECT,
  SETTINGS_ENV_SOURCE,
  SETTING_KEYS,
  SETTINGS_LIMITS,
  SETTINGS_READONLY_FIELDS,
  TELEMETRY_MODES,
  buildRunOverrides,
  encodeSettingValue,
  extraHeaderNames,
  maskSecretState,
  parseAuthPriority,
  parseExtraHeadersEnv,
  parseSettingsRows,
  sanitizeExtraHeaders,
  settingsEnvironment,
  storedApiKey,
  validateExtraHeaders,
  validateSettingsPatch,
  type SettingsEnv,
} from "./system-settings";

const ENV: SettingsEnv = {
  WORKSPACE_PATH: "/workspace",
  WEB_PORT: "3010",
  NEXT_PUBLIC_LANGGRAPH_API_URL: "/runtime-api",
  NEXT_PUBLIC_TERMINAL_WS_URL: "ws://localhost:3003",
  DECEPTICON_LANGUAGE: "zh",
  DECEPTICON_MODEL_PROFILE: "max",
};

test("no stored rows yields the documented defaults plus deployment display values", () => {
  const settings = parseSettingsRows([], ENV);

  assert.equal(settings.modelProfile, "max", "DECEPTICON_MODEL_PROFILE seeds the profile when nothing is stored");
  assert.equal(settings.language, "zh", "DECEPTICON_LANGUAGE is the dashboard default when nothing is stored");
  assert.equal(parseSettingsRows([], {}).modelProfile, DEFAULT_SETTINGS.modelProfile);
  assert.equal(settings.llmTimeoutSeconds, 120);
  assert.equal(settings.llmMaxRetries, 2);
  assert.equal(settings.globalModelOverride, "");
  assert.deepEqual(settings.modelOverrides, {});
  assert.equal(settings.workspacePath, "/workspace");
  assert.equal(settings.langGraphBrowserUrl, "/runtime-api");
  assert.equal(settings.terminalBrowserUrl, "ws://localhost:3003");
});

test("stored rows win over deployment values, except for the read-only ones", () => {
  const settings = parseSettingsRows(
    [
      { key: SETTING_KEYS.language, value: "en" },
      { key: SETTING_KEYS.globalModelOverride, value: "openai/gpt-5" },
      {
        key: SETTING_KEYS.modelOverrides,
        value: JSON.stringify({ soundwave: "anthropic/claude-opus-4-7" }),
      },
      // Kept in the table so a PUT of one still answers "read-only field", but never
      // read back: the agent process resolved these from its own environment before
      // this page ever loaded, so reporting the row would be a lie.
      { key: SETTING_KEYS.modelProfile, value: "test" },
      { key: SETTING_KEYS.llmTimeoutSeconds, value: "45" },
      { key: SETTING_KEYS.llmMaxRetries, value: "0" },
      { key: SETTING_KEYS.workspacePath, value: "/srv/engagements" },
    ],
    ENV,
  );

  assert.equal(settings.modelProfile, "max", "DECEPTICON_MODEL_PROFILE governs, not the legacy row");
  assert.equal(settings.llmTimeoutSeconds, 120, "the deployment timeout governs, not the legacy row");
  assert.equal(settings.llmMaxRetries, 2, "the deployment retry count governs, not the legacy row");
  assert.equal(settings.language, "en");
  assert.equal(settings.globalModelOverride, "openai/gpt-5");
  assert.deepEqual(settings.modelOverrides, { soundwave: "anthropic/claude-opus-4-7" });
  assert.equal(settings.workspacePath, "/workspace", "the deployment WORKSPACE_PATH governs, not the legacy row");
});

test("corrupt rows fall back to defaults instead of failing the read", () => {
  const settings = parseSettingsRows(
    [
      { key: SETTING_KEYS.modelProfile, value: "turbo" },
      { key: SETTING_KEYS.language, value: "klingon" },
      { key: SETTING_KEYS.llmTimeoutSeconds, value: "sixty" },
      { key: SETTING_KEYS.llmMaxRetries, value: "-3" },
      { key: SETTING_KEYS.modelOverrides, value: "{not json" },
      { key: SETTING_KEYS.workspacePath, value: "relative/path" },
      { key: SETTING_KEYS.langGraphBrowserUrl, value: "javascript:alert(1)" },
      { key: SETTING_KEYS.terminalBrowserUrl, value: "http://localhost:3003" },
    ],
    { ...ENV, DECEPTICON_LANGUAGE: "en", DECEPTICON_MODEL_PROFILE: "eco" },
  );

  assert.equal(settings.modelProfile, "eco", "DECEPTICON_MODEL_PROFILE=eco is the fallback here");
  assert.equal(settings.language, "en", "the invalid stored language falls back to the deployment value");
  assert.equal(settings.llmTimeoutSeconds, 120);
  assert.equal(settings.llmMaxRetries, 2);
  assert.deepEqual(settings.modelOverrides, {});
  assert.equal(settings.workspacePath, "/workspace");
  assert.equal(settings.langGraphBrowserUrl, "/runtime-api");
  assert.equal(settings.terminalBrowserUrl, "ws://localhost:3003");
});

test("unsupported deployment language falls back to English", () => {
  const settings = parseSettingsRows([], { DECEPTICON_LANGUAGE: "ja" });
  assert.equal(settings.language, "en");
});

test("settingsEnvironment reports the read-only startup facts", () => {
  const deployment = settingsEnvironment(ENV);
  assert.deepEqual(
    {
      workspacePath: deployment.workspacePath,
      langGraphBrowserUrl: deployment.langGraphBrowserUrl,
      terminalBrowserUrl: deployment.terminalBrowserUrl,
      language: deployment.language,
      modelProfile: deployment.modelProfile,
      llmTimeoutSeconds: deployment.llmTimeoutSeconds,
      llmMaxRetries: deployment.llmMaxRetries,
      authMode: deployment.authMode,
      databaseConfigured: deployment.databaseConfigured,
      deploymentWebPort: deployment.deploymentWebPort,
    },
    {
      workspacePath: "/workspace",
      langGraphBrowserUrl: "/runtime-api",
      terminalBrowserUrl: "ws://localhost:3003",
      language: "zh",
      modelProfile: "max",
      llmTimeoutSeconds: 120,
      llmMaxRetries: 2,
      authMode: "unconfigured",
      databaseConfigured: false,
      deploymentWebPort: "3010",
    },
  );

  const tuned = settingsEnvironment({ DECEPTICON_LLM__TIMEOUT: "600", DECEPTICON_LLM__MAX_RETRIES: "5" });
  assert.equal(tuned.llmTimeoutSeconds, 600, "deployment LLM tuning is honoured until a stored override exists");
  assert.equal(tuned.llmMaxRetries, 5);
  assert.equal(
    settingsEnvironment({ DECEPTICON_LLM__TIMEOUT: "999999" }).llmTimeoutSeconds,
    DEFAULT_SETTINGS.llmTimeoutSeconds,
    "an out-of-range deployment value falls back instead of failing",
  );

  assert.equal(settingsEnvironment({ DECEPTICON_AUTH_DISABLED: "true" }).authMode, "disabled");
  assert.equal(
    settingsEnvironment({
      DECEPTICON_ADMIN_PASSWORD_HASH: "scrypt$aa$bb",
      DECEPTICON_SESSION_SECRET: "secret",
    }).authMode,
    "password",
  );
});

test("the deployment fallback for every new knob mirrors the Python consumer", () => {
  const defaults = settingsEnvironment({});
  assert.equal(defaults.reasoningEffort, "none", "no reasoning_effort is sent unless the deployment opts in");
  assert.equal(defaults.llmMaxOutputTokens, 64000, "matches factory.DEFAULT_LLM_MAX_TOKENS");
  assert.equal(defaults.llmDisableStreaming, false);
  assert.deepEqual(defaults.llmExtraHeaderNames, [], "no header name is reported until the deployment sets one");
  assert.equal(defaults.budgetEngagementUsd, null, "factory default `_env_float(..., 0.0)` means unlimited");
  assert.equal(defaults.budgetPerAgentUsd, null);
  assert.equal(defaults.budgetSoftWarnAtPct, 70, "0.7 fraction rendered as percent");
  assert.equal(defaults.hitlEnabled, false);
  assert.equal(defaults.telemetryMode, "off");
  assert.deepEqual(defaults.authPriority, [], "empty = the built-in default chain");
  assert.equal(defaults.skillogyEmbedModel, DEFAULT_SKILLOGY_EMBED_MODEL);

  const tuned = settingsEnvironment({
    DECEPTICON_LLM_REASONING_EFFORT: "medium",
    DECEPTICON_LLM_MAX_TOKENS: "32000",
    DECEPTICON_LLM_DISABLE_STREAMING: "true",
    DECEPTICON_LLM_EXTRA_HEADERS: JSON.stringify({ "X-Tenant": "acme" }),
    DECEPTICON_BUDGET__ENGAGEMENT_USD: "250.5",
    DECEPTICON_BUDGET__PER_AGENT_USD: "10",
    DECEPTICON_BUDGET__SOFT_WARN_AT_PCT: "0.8",
    DECEPTICON_HITL__ENABLED: "yes",
    DECEPTICON_TELEMETRY: "research",
    DECEPTICON_AUTH_PRIORITY: "anthropic_oauth, anthropic_api",
    DECEPTICON_SKILLOGY_EMBED_MODEL: "voyage/voyage-3",
  });
  assert.equal(tuned.reasoningEffort, "medium");
  assert.equal(tuned.llmMaxOutputTokens, 32000);
  assert.equal(tuned.llmDisableStreaming, true);
  assert.deepEqual(tuned.llmExtraHeaderNames, ["x-tenant"], "names only, never a value");
  assert.equal(tuned.budgetEngagementUsd, 250.5);
  assert.equal(tuned.budgetPerAgentUsd, 10);
  assert.equal(tuned.budgetSoftWarnAtPct, 80);
  assert.equal(tuned.hitlEnabled, true);
  assert.equal(tuned.telemetryMode, "research");
  assert.deepEqual(tuned.authPriority, ["anthropic_oauth", "anthropic_api"]);
  assert.equal(tuned.skillogyEmbedModel, "voyage/voyage-3");
  // The deployment knob understands the two new tiers, so a container can opt the
  // whole fleet into them without a stored row.
  assert.equal(settingsEnvironment({ DECEPTICON_LLM_REASONING_EFFORT: "xhigh" }).reasoningEffort, "xhigh");
  assert.equal(settingsEnvironment({ DECEPTICON_LLM_REASONING_EFFORT: "max" }).reasoningEffort, "max");
});

test("bad deployment values fall back rather than taking the page down", () => {
  const deployment = settingsEnvironment({
    DECEPTICON_LLM_REASONING_EFFORT: "maximal",
    DECEPTICON_LLM_MAX_TOKENS: "lots",
    DECEPTICON_LLM_DISABLE_STREAMING: "maybe",
    DECEPTICON_LLM_EXTRA_HEADERS: "{not json",
    DECEPTICON_BUDGET__ENGAGEMENT_USD: "free",
    DECEPTICON_BUDGET__SOFT_WARN_AT_PCT: "70",
    DECEPTICON_TELEMETRY: "verbose",
  });
  assert.equal(deployment.reasoningEffort, "none");
  assert.equal(deployment.llmMaxOutputTokens, 64000);
  assert.equal(deployment.llmDisableStreaming, false);
  assert.deepEqual(deployment.llmExtraHeaderNames, []);
  assert.equal(deployment.budgetEngagementUsd, null);
  assert.equal(
    deployment.budgetSoftWarnAtPct,
    70,
    "70 is a percent, not a fraction, so the Python-side value is out of range",
  );
  assert.equal(deployment.telemetryMode, "off", "fail-closed: an unknown tier never guesses up");

  assert.equal(
    settingsEnvironment({ DECEPTICON_LLM_MAX_TOKENS: "1" }).llmMaxOutputTokens,
    DEFAULT_SETTINGS.llmMaxOutputTokens,
    "out-of-range deployment values fall back",
  );
  assert.equal(
    settingsEnvironment({ DECEPTICON_LLM_MAX_TOKENS: "999999" }).llmMaxOutputTokens,
    DEFAULT_SETTINGS.llmMaxOutputTokens,
  );
  // `DO_NOT_TRACK` is the standard kill switch and overrides a tier that says otherwise.
  assert.equal(settingsEnvironment({ DECEPTICON_TELEMETRY: "research", DO_NOT_TRACK: "1" }).telemetryMode, "off");

  // HITL is truthy-only, exactly like `middleware/hitl.py::_env_enabled_default`:
  // an unrecognised spelling must mean OFF, never "enabled by accident".
  for (const raw of ["true", "1", "yes", "on", "TRUE", " on "]) {
    assert.equal(settingsEnvironment({ DECEPTICON_HITL__ENABLED: raw }).hitlEnabled, true, raw);
  }
  for (const raw of ["", "0", "false", "no", "off", "OFF", "anything"]) {
    assert.equal(settingsEnvironment({ DECEPTICON_HITL__ENABLED: raw }).hitlEnabled, false, raw);
  }
  assert.equal(settingsEnvironment({ DECEPTICON_HITL__ENABLED: "maybe" }).hitlEnabled, false);
});

test("extra headers reject credential-bearing names, oversized values and junk", () => {
  assert.deepEqual(sanitizeExtraHeaders({ "X-Tenant": "acme" }), { "x-tenant": "acme" });
  assert.deepEqual(extraHeaderNames({ "x-tenant": "acme", "X-Trace": "1" }), ["x-tenant", "x-trace"]);
  assert.deepEqual(sanitizeExtraHeaders({}), {});
  assert.equal(sanitizeExtraHeaders(null), null, "not an object");
  assert.equal(sanitizeExtraHeaders(["X-Tenant"]), null, "arrays are not header maps");
  assert.equal(sanitizeExtraHeaders({ "X-Tenant": 7 }), null, "values must be strings");
  assert.equal(sanitizeExtraHeaders({ "X Tenant": "acme" }), null, "names must be RFC 7230 field-names");
  assert.equal(sanitizeExtraHeaders({ "": "acme" }), null);

  for (const name of FORBIDDEN_LLM_HEADER_NAMES) {
    assert.equal(sanitizeExtraHeaders({ [name]: "secret" }), null, name);
    assert.equal(sanitizeExtraHeaders({ [name.toUpperCase()]: "secret" }), null, `${name} is matched case-insensitively`);
  }

  assert.equal(
    sanitizeExtraHeaders({ "X-Big": "v".repeat(SETTINGS_LIMITS.extraHeaderValueLength + 1) }),
    null,
    "a header value cannot exceed the documented cap",
  );
  assert.equal(sanitizeExtraHeaders({ "X-Multi": "a\r\nB: c" }), null, "no response splitting");

  const tooMany: Record<string, string> = {};
  for (let i = 0; i <= SETTINGS_LIMITS.extraHeadersMaxEntries; i += 1) tooMany[`x-h${i}`] = "v";
  assert.equal(sanitizeExtraHeaders(tooMany), null, "at most 32 headers");

  // The env parser applies the same rule and never throws on a bad deployment value.
  assert.deepEqual(parseExtraHeadersEnv(JSON.stringify({ "X-Tenant": "acme" })), { "x-tenant": "acme" });
  assert.deepEqual(parseExtraHeadersEnv(JSON.stringify({ Authorization: "Bearer sk-live" })), {});
  assert.deepEqual(parseExtraHeadersEnv("{not json"), {});
  assert.deepEqual(parseExtraHeadersEnv(undefined), {});
});

test("validateExtraHeaders returns a per-field message instead of a silent drop", () => {
  assert.deepEqual(validateExtraHeaders({ "X-Tenant": "acme" }), { "x-tenant": "acme" });
  const message = validateExtraHeaders({ Authorization: "Bearer sk-live" });
  assert.equal(typeof message, "string", "a rejected header is reported, never stored under a different name");
  assert.deepEqual(validateExtraHeaders({ "X-Multi": "a\nb" }), 'header "x-multi" must not contain line breaks');
});

test("auth priority accepts only known AuthMethod slugs", () => {
  assert.deepEqual(parseAuthPriority("anthropic_oauth,anthropic_api"), ["anthropic_oauth", "anthropic_api"]);
  assert.deepEqual(parseAuthPriority(" anthropic_api , , ANTHROPIC_API "), ["anthropic_api"], "case-folded and de-duplicated");
  assert.deepEqual(parseAuthPriority("telepathy,openai_api"), ["openai_api"], "the Python parser logs and skips junk");
  assert.deepEqual(parseAuthPriority(""), []);
  assert.deepEqual(parseAuthPriority(undefined), []);
  assert.ok(AUTH_METHODS.includes("custom_openai_api"), "the channel registration path relies on this method");
});

test("authMode agrees with the auth-crypto credential check", () => {
  const cases: SettingsEnv[] = [
    {},
    { DECEPTICON_AUTH_DISABLED: "true" },
    { DECEPTICON_ADMIN_PASSWORD_HASH: "h", DECEPTICON_SESSION_SECRET: "s" },
    { DECEPTICON_ADMIN_PASSWORD: "p", DECEPTICON_SESSION_SECRET: "s" },
    { DECEPTICON_ADMIN_PASSWORD_HASH: "h" },
    { DECEPTICON_SESSION_SECRET: "s" },
  ];
  for (const env of cases) {
    const expected = env.DECEPTICON_AUTH_DISABLED === "true" ? "disabled" : isAuthConfigured(env) ? "password" : "unconfigured";
    assert.equal(settingsEnvironment(env).authMode, expected, JSON.stringify(env));
  }
});

test("secrets expose existence only", () => {
  assert.equal(storedApiKey({ key: SETTING_KEYS.llmProxyApiKey, value: " sk-secret " }), "sk-secret");
  assert.equal(storedApiKey(undefined), "");
  assert.equal(maskSecretState("sk-secret"), true);
  assert.equal(maskSecretState("   "), false);
  assert.equal(maskSecretState(undefined), false);
  assert.equal(maskSecretState(null), false);
});

test("an empty payload is rejected rather than silently no-op'd", () => {
  assert.deepEqual(validateSettingsPatch({}), { ok: false, error: "No settings provided" });
});

test("unknown and read-only fields are rejected with per-field errors", () => {
  const unknown = validateSettingsPatch({ nope: 1, modelProfile: "max" });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.ok ? {} : unknown.fields, {
    nope: "unknown field",
    modelProfile: "read-only field",
  });

  const readonly = validateSettingsPatch({ authMode: "password", deploymentWebPort: "3000" });
  assert.equal(readonly.ok, false);
  assert.deepEqual(readonly.ok ? {} : readonly.fields, {
    authMode: "read-only field",
    deploymentWebPort: "read-only field",
  });

  for (const value of [null, "settings", 42, ["modelProfile"]]) {
    assert.deepEqual(validateSettingsPatch(value), { ok: false, error: "Settings payload must be a JSON object" });
  }
});

test("enums, URLs and paths are validated", () => {
  assert.deepEqual(validateSettingsPatch({ modelProfile: "turbo" }).ok, false);
  assert.deepEqual(validateSettingsPatch({ modelProfile: "max" }), {
    ok: false,
    error: "Invalid settings",
    fields: { modelProfile: "read-only field" },
  });
  assert.deepEqual(validateSettingsPatch({ language: "ja" }).ok, false);
  assert.deepEqual(validateSettingsPatch({ language: "zh" }), { ok: true, patch: { language: "zh" } });

  assert.equal(validateSettingsPatch({ langGraphBrowserUrl: "javascript:alert(1)" }).ok, false);
  assert.equal(validateSettingsPatch({ langGraphBrowserUrl: "http://langgraph:2024" }).ok, true);
  assert.equal(validateSettingsPatch({ terminalBrowserUrl: "http://localhost:3003" }).ok, false);
  assert.equal(validateSettingsPatch({ terminalBrowserUrl: "wss://dash.example/ws" }).ok, true);

  // `workspacePath` is reported, never written: the PTY and the file APIs read
  // `WORKSPACE_PATH`, so a stored row could not move the on-disk workspace.
  assert.deepEqual(validateSettingsPatch({ workspacePath: "/srv/engagements" }), {
    ok: false,
    error: "Invalid settings",
    fields: { workspacePath: "read-only field" },
  });
});

test("enum fields accept an empty string to reset to the deployment default", () => {
  assert.deepEqual(validateSettingsPatch({ language: "" }), { ok: true, patch: { language: "" } });
  assert.equal(encodeSettingValue("language", ""), null);

  // A reset leaves the stored row deleted and falls back to the deployment env.
  const env: SettingsEnv = { ...ENV, DECEPTICON_MODEL_PROFILE: "max", DECEPTICON_LLM__TIMEOUT: "600" };
  const settings = parseSettingsRows([], env);
  assert.equal(settings.modelProfile, "max");
  assert.equal(settings.llmTimeoutSeconds, 600);
});

test("prototype keys are not mistaken for settings fields", () => {
  const rejected = validateSettingsPatch(JSON.parse('{"constructor": "x", "toString": 1}'));
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.ok ? {} : rejected.fields, {
    constructor: "unknown field",
    toString: "unknown field",
  });
});

test("the read-only runtime knobs answer read-only, whatever the payload", () => {
  for (const field of ["modelProfile", "llmTimeoutSeconds", "llmMaxRetries", "llmExtraHeaders"] as const) {
    for (const value of ["", 0, "max", { "x-tenant": "acme" }]) {
      const rejected = validateSettingsPatch({ [field]: value });
      assert.equal(rejected.ok, false, `${field}=${JSON.stringify(value)}`);
      assert.deepEqual(rejected.ok ? {} : rejected.fields, { [field]: "read-only field" });
    }
  }
});

test("model ids and per-role overrides are validated against the agent registry", () => {
  assert.ok(MODEL_ROLE_IDS.length > 0);
  assert.ok(MODEL_ROLE_IDS.includes("decepticon"), "registry ids are the middleware role keys");

  assert.deepEqual(validateSettingsPatch({ globalModelOverride: "openai/gpt-5" }), {
    ok: true,
    patch: { globalModelOverride: "openai/gpt-5" },
  });
  assert.equal(validateSettingsPatch({ globalModelOverride: "two models" }).ok, false);

  const ok = validateSettingsPatch({ modelOverrides: { decepticon: "openai/gpt-5", soundwave: "   " } });
  assert.deepEqual(
    ok,
    { ok: true, patch: { modelOverrides: { decepticon: "openai/gpt-5" } } },
    "a blank per-role value removes that role's override",
  );

  const unknownRole = validateSettingsPatch({ modelOverrides: { not_an_agent: "openai/gpt-5" } });
  assert.equal(unknownRole.ok, false);
  assert.deepEqual(unknownRole.ok ? {} : unknownRole.fields, {
    modelOverrides: 'unknown agent role "not_an_agent"',
  });

  assert.equal(validateSettingsPatch({ modelOverrides: ["decepticon"] }).ok, false);
  assert.equal(validateSettingsPatch({ modelOverrides: { decepticon: 7 } }).ok, false);
});

test("the proxy key is validated but only its existence is ever encoded", () => {
  assert.deepEqual(validateSettingsPatch({ llmProxyApiKey: "sk-abc" }), {
    ok: true,
    patch: { llmProxyApiKey: "sk-abc" },
  });
  assert.deepEqual(validateSettingsPatch({ llmProxyApiKey: "" }), { ok: true, patch: { llmProxyApiKey: "" } });
  assert.equal(validateSettingsPatch({ llmProxyApiKey: "sk-a b" }).ok, false);
  assert.equal(validateSettingsPatch({ llmProxyApiKey: 42 }).ok, false);
  assert.equal(validateSettingsPatch({ llmProxyApiKey: "x".repeat(SETTINGS_LIMITS.apiKeyLength + 1) }).ok, false);

  assert.equal(encodeSettingValue("llmProxyApiKey", "sk-abc"), "sk-abc");
  assert.equal(encodeSettingValue("llmProxyApiKey", ""), null, "an empty key clears the stored override");
});

test("encodeSettingValue maps cleared values to row deletion", () => {
  assert.equal(encodeSettingValue("globalModelOverride", ""), null);
  assert.equal(
    encodeSettingValue("modelOverrides", { decepticon: "openai/gpt-5", soundwave: "  " }),
    JSON.stringify({ decepticon: "openai/gpt-5" }),
  );
  assert.equal(encodeSettingValue("modelOverrides", {}), null);
});

test("run overrides stay empty until something is configured", () => {
  assert.deepEqual(buildRunOverrides(DEFAULT_SETTINGS), {});

  assert.deepEqual(buildRunOverrides({ ...DEFAULT_SETTINGS, globalModelOverride: "openai/gpt-5" }), {
    model_override: "openai/gpt-5",
  });

  assert.deepEqual(
    buildRunOverrides({ ...DEFAULT_SETTINGS, modelOverrides: { exploit: "anthropic/claude-opus-4-7" } }),
    { model_overrides: { exploit: "anthropic/claude-opus-4-7" } },
  );

  assert.deepEqual(
    buildRunOverrides({
      ...DEFAULT_SETTINGS,
      globalModelOverride: "openai/gpt-5",
      modelOverrides: { soundwave: "anthropic/claude-opus-4-7" },
    }),
    {
      model_override: "openai/gpt-5",
      model_overrides: { soundwave: "anthropic/claude-opus-4-7" },
    },
    "the per-role map accompanies, and takes precedence over, the global override",
  );
});

test("stored rows drive every new knob, corrupt rows fall back", () => {
  const stored = parseSettingsRows(
    [
      { key: SETTING_KEYS.reasoningEffort, value: "high" },
      { key: SETTING_KEYS.llmMaxOutputTokens, value: "32000" },
      { key: SETTING_KEYS.llmDisableStreaming, value: "true" },
      { key: SETTING_KEYS.budgetEngagementUsd, value: "120.5" },
      { key: SETTING_KEYS.budgetPerAgentUsd, value: "0" },
      { key: SETTING_KEYS.budgetSoftWarnAtPct, value: "90" },
      { key: SETTING_KEYS.hitlEnabled, value: "false" },
    ],
    {},
  );
  assert.equal(stored.reasoningEffort, "high");
  // The two new tiers are stored and reported like the original three.
  assert.equal(
    parseSettingsRows([{ key: SETTING_KEYS.reasoningEffort, value: "xhigh" }], {}).reasoningEffort,
    "xhigh",
  );
  assert.equal(parseSettingsRows([{ key: SETTING_KEYS.reasoningEffort, value: "max" }], {}).reasoningEffort, "max");
  assert.equal(stored.llmMaxOutputTokens, 32000);
  assert.equal(stored.llmDisableStreaming, true);
  assert.deepEqual(stored.llmExtraHeaderNames, [], "no env → no reported header name");
  assert.equal(stored.budgetEngagementUsd, 120.5);
  assert.equal(stored.budgetPerAgentUsd, null, "a stored 0 is not a per-run override; the deployment value governs");
  assert.equal(stored.budgetSoftWarnAtPct, 90);
  assert.equal(stored.hitlEnabled, false);
  assert.equal(
    parseSettingsRows([{ key: SETTING_KEYS.budgetSoftWarnAtPct, value: "0" }], {}).budgetSoftWarnAtPct,
    70,
    "a stored 0% would never fire, so it is not an override",
  );

  const corrupt = parseSettingsRows(
    [
      { key: SETTING_KEYS.reasoningEffort, value: "maximal" },
      { key: SETTING_KEYS.llmMaxOutputTokens, value: "lots" },
      { key: SETTING_KEYS.llmDisableStreaming, value: "maybe" },
      { key: SETTING_KEYS.budgetEngagementUsd, value: "free" },
      { key: SETTING_KEYS.budgetPerAgentUsd, value: "-1" },
      { key: SETTING_KEYS.budgetSoftWarnAtPct, value: "900" },
      { key: SETTING_KEYS.hitlEnabled, value: "sometimes" },
    ],
    {},
  );
  assert.equal(corrupt.reasoningEffort, DEFAULT_SETTINGS.reasoningEffort);
  assert.equal(corrupt.llmMaxOutputTokens, DEFAULT_SETTINGS.llmMaxOutputTokens);
  assert.equal(corrupt.llmDisableStreaming, DEFAULT_SETTINGS.llmDisableStreaming);
  assert.equal(corrupt.budgetEngagementUsd, null);
  assert.equal(corrupt.budgetPerAgentUsd, null);
  assert.equal(corrupt.budgetSoftWarnAtPct, DEFAULT_SETTINGS.budgetSoftWarnAtPct);
  assert.equal(corrupt.hitlEnabled, DEFAULT_SETTINGS.hitlEnabled);
});

test("a stored row overrides a deployment value and a cleared row restores it", () => {
  const env: SettingsEnv = {
    DECEPTICON_LLM_REASONING_EFFORT: "low",
    DECEPTICON_LLM_MAX_TOKENS: "8000",
    DECEPTICON_BUDGET__ENGAGEMENT_USD: "50",
    DECEPTICON_HITL__ENABLED: "true",
  };
  const overridden = parseSettingsRows(
    [
      { key: SETTING_KEYS.reasoningEffort, value: "high" },
      { key: SETTING_KEYS.budgetEngagementUsd, value: "0" },
      { key: SETTING_KEYS.hitlEnabled, value: "false" },
    ],
    env,
  );
  assert.equal(overridden.reasoningEffort, "high");
  assert.equal(overridden.llmMaxOutputTokens, 8000, "no row → the deployment value applies");
  assert.equal(
    overridden.budgetEngagementUsd,
    50,
    "a stored 0 is not a per-run override, so the deployment cap still governs",
  );
  assert.equal(overridden.hitlEnabled, false, "the run flag can only enable HITL, never disable it");

  const cleared = parseSettingsRows([], env);
  assert.equal(cleared.reasoningEffort, "low");
  // The deployment knob accepts the new tiers too, with the same casing rule.
  assert.equal(
    parseSettingsRows([], { DECEPTICON_LLM_REASONING_EFFORT: "xhigh" }).reasoningEffort,
    "xhigh",
  );
  assert.equal(parseSettingsRows([], { DECEPTICON_LLM_REASONING_EFFORT: "max" }).reasoningEffort, "max");
  assert.equal(
    parseSettingsRows([], { DECEPTICON_LLM_REASONING_EFFORT: "Maximum" }).reasoningEffort,
    "none",
    "an unknown deployment spelling falls back rather than being coerced",
  );
  assert.equal(cleared.budgetEngagementUsd, 50);
  assert.equal(cleared.hitlEnabled, true);
});

test("the new fields are validated, cleared and encoded like the existing ones", () => {
  assert.deepEqual(validateSettingsPatch({ reasoningEffort: "high" }), {
    ok: true,
    patch: { reasoningEffort: "high" },
  });
  assert.deepEqual(validateSettingsPatch({ reasoningEffort: "xhigh" }), {
    ok: true,
    patch: { reasoningEffort: "xhigh" },
  });
  assert.deepEqual(validateSettingsPatch({ reasoningEffort: "max" }), {
    ok: true,
    patch: { reasoningEffort: "max" },
  });
  assert.equal(validateSettingsPatch({ reasoningEffort: "maximal" }).ok, false);
  assert.equal(
    validateSettingsPatch({ reasoningEffort: "MAX" }).ok,
    false,
    "the stored value keeps the lowercase wire spelling the run input uses",
  );
  assert.deepEqual(validateSettingsPatch({ reasoningEffort: "" }), { ok: true, patch: { reasoningEffort: "" } });

  assert.deepEqual(validateSettingsPatch({ llmMaxOutputTokens: SETTINGS_LIMITS.llmMaxOutputTokens.min }), {
    ok: true,
    patch: { llmMaxOutputTokens: SETTINGS_LIMITS.llmMaxOutputTokens.min },
  });
  assert.equal(validateSettingsPatch({ llmMaxOutputTokens: SETTINGS_LIMITS.llmMaxOutputTokens.max + 1 }).ok, false);
  assert.equal(validateSettingsPatch({ llmMaxOutputTokens: 100.5 }).ok, false);
  assert.deepEqual(validateSettingsPatch({ llmMaxOutputTokens: "" }), { ok: true, patch: { llmMaxOutputTokens: "" } });

  assert.deepEqual(validateSettingsPatch({ llmDisableStreaming: true, hitlEnabled: true }), {
    ok: true,
    patch: { llmDisableStreaming: true, hitlEnabled: true },
  });
  assert.equal(validateSettingsPatch({ llmDisableStreaming: "true" }).ok, false, "booleans are not coerced");
  assert.equal(validateSettingsPatch({ hitlEnabled: 1 }).ok, false);

  assert.deepEqual(validateSettingsPatch({ budgetEngagementUsd: 0, budgetPerAgentUsd: 1000000 }), {
    ok: true,
    patch: { budgetEngagementUsd: "", budgetPerAgentUsd: 1000000 },
  });
  assert.equal(validateSettingsPatch({ budgetEngagementUsd: -1 }).ok, false);
  assert.equal(validateSettingsPatch({ budgetPerAgentUsd: 1000001 }).ok, false);
  assert.equal(validateSettingsPatch({ budgetEngagementUsd: "free" }).ok, false);
  assert.deepEqual(validateSettingsPatch({ budgetEngagementUsd: "" }), {
    ok: true,
    patch: { budgetEngagementUsd: "" },
  });

  assert.deepEqual(validateSettingsPatch({ budgetSoftWarnAtPct: 12.5 }), {
    ok: true,
    patch: { budgetSoftWarnAtPct: 12.5 },
  });
  assert.deepEqual(
    validateSettingsPatch({ budgetSoftWarnAtPct: 0 }),
    { ok: true, patch: { budgetSoftWarnAtPct: "" } },
    "0% would disable the warning, so it means 'keep the deployment threshold'",
  );
  assert.equal(validateSettingsPatch({ budgetSoftWarnAtPct: 101 }).ok, false);
  assert.equal(
    validateSettingsPatch({ llmMaxOutputTokens: 0 }).ok,
    false,
    "0 output tokens is below the floor and is not a reset",
  );
  assert.deepEqual(validateSettingsPatch({ budgetSoftWarnAtPct: "" }), {
    ok: true,
    patch: { budgetSoftWarnAtPct: "" },
  });

  assert.equal(encodeSettingValue("reasoningEffort", "high"), "high");
  assert.equal(encodeSettingValue("reasoningEffort", ""), null);
  assert.equal(encodeSettingValue("llmMaxOutputTokens", 32000), "32000");
  assert.equal(encodeSettingValue("llmDisableStreaming", false), "false", "false is a real stored value");
  assert.equal(encodeSettingValue("hitlEnabled", true), "true");
  assert.equal(encodeSettingValue("budgetEngagementUsd", 0), null, "a 0 cap stores no row at all");
  assert.equal(encodeSettingValue("budgetEngagementUsd", 250), "250");
  assert.equal(encodeSettingValue("budgetSoftWarnAtPct", 90), "90");
});

test("startup-scoped values are reported but never writable", () => {
  for (const field of [
    "telemetryMode",
    "authPriority",
    "skillogyEmbedModel",
    "workspacePath",
    "modelProfile",
    "llmTimeoutSeconds",
    "llmMaxRetries",
    "llmExtraHeaders",
  ] as const) {
    assert.ok(SETTINGS_READONLY_FIELDS.includes(field), field);
    const rejected = validateSettingsPatch({ [field]: field === "authPriority" ? ["openai_api"] : "x" });
    assert.equal(rejected.ok, false, field);
    assert.deepEqual(rejected.ok ? {} : rejected.fields, { [field]: "read-only field" });
  }
});

test("run overrides forward only the values that differ from the defaults", () => {
  assert.deepEqual(buildRunOverrides(DEFAULT_SETTINGS), {});

  const overridden = buildRunOverrides({
    ...DEFAULT_SETTINGS,
    reasoningEffort: "medium",
    llmMaxOutputTokens: 32768,
    llmDisableStreaming: true,
    budgetEngagementUsd: 250,
    budgetPerAgentUsd: 25,
    budgetSoftWarnAtPct: 85,
    hitlEnabled: true,
  });
  assert.deepEqual(overridden, {
    reasoning_effort: "medium",
    llm_max_output_tokens: 32768,
    llm_disable_streaming: true,
    budget_engagement_usd: 250,
    budget_per_agent_usd: 25,
    // The run input carries the fraction the middleware compares against.
    budget_soft_warn_at_pct: 0.85,
    hitl_enabled: true,
  });

  assert.equal(
    buildRunOverrides({ ...DEFAULT_SETTINGS, reasoningEffort: "none" }).reasoning_effort,
    undefined,
    "`none` means no parameter at all, not `reasoning_effort: none`",
  );
  // The two new tiers go straight into the run input: this direct-caller twin of
  // the PTY channel must agree with the CLI on which levels travel.
  assert.equal(buildRunOverrides({ ...DEFAULT_SETTINGS, reasoningEffort: "xhigh" }).reasoning_effort, "xhigh");
  assert.equal(buildRunOverrides({ ...DEFAULT_SETTINGS, reasoningEffort: "max" }).reasoning_effort, "max");
  assert.equal(
    buildRunOverrides({ ...DEFAULT_SETTINGS, llmMaxOutputTokens: DEFAULT_SETTINGS.llmMaxOutputTokens })
      .llm_max_output_tokens,
    undefined,
    "the default must not pin a model to 64k",
  );
  assert.equal(
    buildRunOverrides({ ...DEFAULT_SETTINGS, budgetEngagementUsd: 0 }).budget_engagement_usd,
    undefined,
    "0 is not forwarded: a run input may not erase the deployment's financial guardrail",
  );
  assert.equal(
    "llm_extra_headers" in buildRunOverrides({ ...DEFAULT_SETTINGS, hitlEnabled: true }),
    false,
    "provider headers have no run channel at all: a value would land in the checkpoint",
  );
  assert.equal(
    buildRunOverrides({ ...DEFAULT_SETTINGS, hitlEnabled: false }).hitl_enabled,
    undefined,
  );
});

test("stored keys are the snake_case mapping of the patch fields", () => {
  assert.equal(SETTING_KEYS.modelProfile, "model_profile");
  assert.equal(SETTING_KEYS.llmProxyApiKey, "llm_proxy_api_key");
  assert.equal(SETTING_KEYS.reasoningEffort, "reasoning_effort");
  assert.equal(SETTING_KEYS.llmMaxOutputTokens, "llm_max_output_tokens");
  assert.equal(SETTING_KEYS.llmDisableStreaming, "llm_disable_streaming");
  assert.equal(SETTING_KEYS.llmExtraHeaders, "llm_extra_headers");
  assert.equal(SETTING_KEYS.budgetEngagementUsd, "budget_engagement_usd");
  assert.equal(SETTING_KEYS.budgetPerAgentUsd, "budget_per_agent_usd");
  assert.equal(SETTING_KEYS.budgetSoftWarnAtPct, "budget_soft_warn_at_pct");
  assert.equal(SETTING_KEYS.hitlEnabled, "hitl_enabled");
  assert.equal(Object.keys(SETTING_KEYS).length, 18);
  assert.deepEqual([...MODEL_PROFILES], ["eco", "max", "test"]);
  assert.deepEqual([...REASONING_EFFORTS], ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual([...TELEMETRY_MODES], ["off", "basic", "research"]);
});

test("every field carries a documented effective boundary", () => {
  // A field the API reports must have a stated boundary: the UI renders it, so a
  // missing entry would render as "unknown" instead of a wrong-but-plausible claim.
  const fields = [
    ...Object.keys(SETTING_KEYS),
    ...SETTINGS_READONLY_FIELDS,
  ];
  assert.ok(SETTINGS_READONLY_FIELDS.includes("telemetryMode"));
  assert.ok(SETTINGS_READONLY_FIELDS.includes("authPriority"));
  assert.ok(SETTINGS_READONLY_FIELDS.includes("skillogyEmbedModel"));
  const effects = SETTINGS_EFFECT as Record<string, string | undefined>;
  for (const field of fields) {
    assert.ok(effects[field], `${field} has no declared effect`);
  }
  assert.equal(SETTINGS_EFFECT.telemetryMode, "read-only");
  assert.equal(SETTINGS_EFFECT.authPriority, "read-only");
  assert.equal(SETTINGS_EFFECT.skillogyEmbedModel, "read-only");
  assert.equal(SETTINGS_EFFECT.modelProfile, "read-only");
  assert.equal(SETTINGS_EFFECT.llmTimeoutSeconds, "read-only");
  assert.equal(SETTINGS_EFFECT.llmMaxRetries, "read-only");
  assert.equal(SETTINGS_EFFECT.llmExtraHeaderNames, "read-only");
  assert.equal(SETTINGS_EFFECT.workspacePath, "read-only");
  assert.equal(SETTINGS_EFFECT.reasoningEffort, "next-session");
  assert.equal(SETTINGS_EFFECT.hitlEnabled, "next-session");
});

test("every startup-scoped field names the env var that actually governs it", () => {
  // A read-only row must never be shown without the env var an operator can act on:
  // the deployment environment is the only way to change one.
  for (const field of ["modelProfile", "llmTimeoutSeconds", "llmMaxRetries", "llmExtraHeaderNames", "workspacePath"] as const) {
    assert.equal(SETTINGS_EFFECT[field], "read-only", field);
    assert.ok(
      SETTINGS_ENV_SOURCE[field],
      `${field} has no documented environment source`,
    );
  }
  assert.equal(SETTINGS_ENV_SOURCE.modelProfile, "DECEPTICON_MODEL_PROFILE");
  assert.equal(SETTINGS_ENV_SOURCE.workspacePath, "WORKSPACE_PATH");
  assert.equal(SETTINGS_ENV_SOURCE.llmTimeoutSeconds, "DECEPTICON_LLM__TIMEOUT");
  assert.equal(SETTINGS_ENV_SOURCE.telemetryMode, "DECEPTICON_TELEMETRY");
  assert.equal(SETTINGS_ENV_SOURCE.authPriority, "DECEPTICON_AUTH_PRIORITY");
  assert.equal(SETTINGS_ENV_SOURCE.skillogyEmbedModel, "DECEPTICON_SKILLOGY_EMBED_MODEL");
});
