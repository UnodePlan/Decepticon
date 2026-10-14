import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS,
  CHANNEL_PROTOCOLS,
  LLM_CHANNEL_KEYS,
  LLM_CHANNEL_LIMITS,
  normalizeChannelBase,
  parseChannelSnapshot,
  readDiscoverBody,
  readSaveBody,
  readTestBody,
  channelModelsUrl,
} from "./llm-channel";
import {
  channelSnapshot,
  channelWriteChanges,
  parseChannelRows,
  resolveChannelConfig,
  resolveChannelHeaders,
  resolveChannelKey,
  savedChannelSnapshot,
  storedChannelHeaders,
  type StoredChannel,
} from "./llm-channel-state";
import {
  discoverChannelModels,
  listedModels,
  testChannelModel,
  type TestModelInput,
} from "./llm-channel-fetch";
import { SETTING_KEYS, extraHeaderNames } from "./system-settings";

const KEY = "sk-channel-secret";
const BASE = "https://llm.internal.example/v1";
const HEADERS = { "x-team": "red", "x-api-version": "2024-01" };

const CHANNEL_ROWS = [
  { key: LLM_CHANNEL_KEYS.apiBase, value: BASE },
  { key: LLM_CHANNEL_KEYS.apiKey, value: KEY },
  { key: LLM_CHANNEL_KEYS.model, value: "mistral-large" },
  { key: LLM_CHANNEL_KEYS.alias, value: "openai/decepticon-custom-abc123" },
  { key: LLM_CHANNEL_KEYS.protocol, value: "responses" },
  { key: LLM_CHANNEL_KEYS.contextWindowTokens, value: "32768" },
  { key: LLM_CHANNEL_KEYS.maxOutputTokens, value: "4096" },
  { key: LLM_CHANNEL_KEYS.extraHeaders, value: JSON.stringify(HEADERS) },
  { key: SETTING_KEYS.globalModelOverride, value: "openai/decepticon-custom-abc123" },
];

// ── Base URL ─────────────────────────────────────────────────────────

test("normalizeChannelBase keeps custom paths, drops the /models suffix and rejects unsafe URLs", () => {
  assert.deepEqual(normalizeChannelBase(" https://llm.internal.example/v1/ "), {
    ok: true,
    apiBase: "https://llm.internal.example/v1",
  });
  assert.deepEqual(normalizeChannelBase("http://192.168.1.10:8000"), { ok: true, apiBase: "http://192.168.1.10:8000" });
  assert.deepEqual(normalizeChannelBase("https://host/openai/v1/models"), {
    ok: true,
    apiBase: "https://host/openai/v1",
  });

  for (const bad of [
    "",
    "not a url",
    "ftp://host/v1",
    "https://user:pass@host/v1",
    "https://host/v1?key=x",
    "https://host/v1#frag",
    "http://",
    42,
    `https://host/${"a".repeat(LLM_CHANNEL_LIMITS.apiBaseLength)}`,
  ]) {
    const result = normalizeChannelBase(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (!result.ok) assert.ok(result.fields?.apiBase, "the rejection names the apiBase field");
  }
});

// ── Protocols ────────────────────────────────────────────────────────

test("every protocol in the contract is offered, with no proxy-flag gating", () => {
  // v1.88.1 routes an `anthropic/<model>` deployment to the endpoint's native
  // `/v1/messages` whether or not LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES
  // is set, so the option is never hidden — the full list is the option list.
  assert.deepEqual([...CHANNEL_PROTOCOLS], ["chat_completions", "responses", "messages"]);
});

test("model discovery is only offered where the protocol has a listing path", () => {
  assert.equal(channelModelsUrl(BASE, "chat_completions"), `${BASE}/models`);
  assert.equal(channelModelsUrl(BASE, "responses"), `${BASE}/models`);
  assert.equal(channelModelsUrl(BASE, "messages"), null, "Anthropic Messages has no standard listing");
});

// ── Request bodies ───────────────────────────────────────────────────

test("request bodies are validated before any network or storage work", () => {
  const discover = readDiscoverBody({ apiBase: BASE, protocol: "chat_completions" });
  assert.deepEqual(discover, {
    ok: true,
    body: { apiBase: BASE, keyless: false, protocol: "chat_completions" },
  });
  assert.deepEqual(readDiscoverBody({ apiBase: BASE, protocol: "responses", apiKey: "" }), {
    ok: true,
    body: { apiBase: BASE, apiKey: "", keyless: true, protocol: "responses" },
  });
  for (const bad of [
    {},
    { apiBase: "" },
    { apiBase: BASE, apiKey: "two words" },
    { apiBase: BASE, apiKey: 7 },
    { apiBase: BASE }, // missing protocol: discovery cannot guess it
    { apiBase: BASE, protocol: "grpc" },
  ]) {
    assert.equal(readDiscoverBody(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(readDiscoverBody([1]).ok, false);

  // Messages is a supported protocol but has no listing: the 400 names the field
  // ("enter the model id"), never a silent fallback to chat_completions.
  const noListing = readDiscoverBody({ apiBase: BASE, protocol: "messages" });
  assert.equal(noListing.ok, false);
  if (!noListing.ok) {
    assert.equal(noListing.fields?.protocol, "this protocol has no model list — enter the model id");
  }
  // An unknown protocol is refused by name too, never downgraded.
  const unknown = readDiscoverBody({ apiBase: BASE, protocol: "grpc" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.fields?.protocol ?? "", /must be one of chat_completions, responses, messages/);

  assert.deepEqual(readSaveBody({ apiBase: BASE, apiKey: KEY, model: "mistral-large" }), {
    ok: true,
    body: { apiBase: BASE, apiKey: KEY, model: "mistral-large", keyless: false },
  });
  assert.deepEqual(readSaveBody({ model: "" }), { ok: true, body: { model: "", keyless: false } });
  assert.deepEqual(
    readSaveBody({ apiBase: "", model: "" }),
    { ok: true, body: { model: "", keyless: false } },
    "an empty base is what a clear sends; it is not an invalid URL",
  );
  assert.equal(readSaveBody({ apiBase: "", model: "mistral-large" }).ok, false, "a blank base cannot save");
  // A typo'd model must not be read as a destructive clear.
  assert.equal(readSaveBody({ apiBase: BASE, model: "   " }).ok, false);
  assert.equal(readSaveBody({ model: "" }).ok, true, "an exactly empty model is the documented clear");
  assert.equal(readSaveBody({ model: "mistral-large" }).ok, false, "saving needs a base");
  assert.equal(readSaveBody({ apiBase: BASE, model: "x".repeat(LLM_CHANNEL_LIMITS.modelLength + 1) }).ok, false);
});

test("protocol, token and header fields are validated on save and optional for older clients", () => {
  // Absent fields are kept by the handler, not reset here.
  const minimal = readSaveBody({ apiBase: BASE, model: "m" });
  assert.equal(minimal.ok, true);
  if (minimal.ok) {
    assert.equal(minimal.body.protocol, undefined);
    assert.equal(minimal.body.contextWindowTokens, undefined);
    assert.equal(minimal.body.maxOutputTokens, undefined);
    assert.equal(minimal.body.extraHeaders, undefined);
  }

  const full = readSaveBody({
    apiBase: BASE,
    model: "m",
    protocol: "responses",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    extraHeaders: HEADERS,
  });
  assert.equal(full.ok, true);
  if (full.ok) {
    assert.equal(full.body.protocol, "responses");
    assert.equal(full.body.contextWindowTokens, 32768);
    assert.equal(full.body.maxOutputTokens, 4096);
    assert.deepEqual(full.body.extraHeaders, HEADERS);
  }

  const { min, max } = LLM_CHANNEL_LIMITS.contextWindowTokens;
  for (const bad of [min - 1, max + 1, 1.5, "32000", null]) {
    assert.equal(rejectionField({ contextWindowTokens: bad }), "contextWindowTokens", JSON.stringify(bad));
  }
  const output = LLM_CHANNEL_LIMITS.maxOutputTokens;
  for (const bad of [output.min - 1, output.max + 1, 12.5, "4000"]) {
    assert.equal(rejectionField({ maxOutputTokens: bad }), "maxOutputTokens", JSON.stringify(bad));
  }
  // Output above the context window can never be produced.
  assert.equal(
    rejectionField({ contextWindowTokens: 2048, maxOutputTokens: 4096 }),
    "maxOutputTokens",
    "the pair is refused",
  );
  assert.equal(readSaveBody({ apiBase: BASE, model: "", contextWindowTokens: "nope" }).ok, true, "a clear ignores the fields");
});

/** The field a save rejection named, or "" when it was accepted. */
function rejectionField(patch: Record<string, unknown>): string {
  const result = readSaveBody({ apiBase: BASE, model: "m", ...patch });
  if (result.ok) return "";
  return Object.keys(result.fields ?? {})[0] ?? "";
}

test("channel headers obey the shared rules and forbid credential-bearing names", () => {
  const accepted = readSaveBody({
    apiBase: BASE,
    model: "m",
    extraHeaders: { " X-Team ": " red ", "x-blank": "" },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    // The SHARED validator lower-cases the name (HTTP field names are
    // case-insensitive and one casing is stored); the value is kept verbatim.
    assert.deepEqual(accepted.body.extraHeaders, { "x-team": " red ", "x-blank": "" });
  }

  assert.equal(readSaveBody({ apiBase: BASE, model: "m", extraHeaders: {} }).ok, true, "{} clears the headers");
  for (const bad of [
    { authorization: "Bearer x" },
    { Cookie: "a=b" },
    { "x-evil": "a\r\nX-Injected: 1" },
    { "two words": "v" },
    { "x-long": "v".repeat(LLM_CHANNEL_LIMITS.apiKeyLength * 8) },
    ["authorization"],
    "x-team: red",
  ]) {
    assert.equal(rejectionField({ extraHeaders: bad }), "extraHeaders", JSON.stringify(bad));
  }
  const many = Object.fromEntries(
    Array.from({ length: 33 }, (_, i) => [`x-h${i}`, "v"]),
  );
  assert.equal(rejectionField({ extraHeaders: many }), "extraHeaders", "the key count is bounded");
});

test("the test body reuses the save rules and demands a real target", () => {
  const parsed = readTestBody({ apiBase: BASE, apiKey: KEY, protocol: "responses", model: "mistral-large", maxOutputTokens: 4096 });
  assert.deepEqual(parsed, {
    ok: true,
    body: { apiBase: BASE, apiKey: KEY, keyless: false, protocol: "responses", model: "mistral-large", maxOutputTokens: 4096 },
  });

  const minimal = readTestBody({ apiBase: BASE, model: "m" });
  assert.equal(minimal.ok, true);
  if (minimal.ok) assert.equal(minimal.body.protocol, "chat_completions", "the test has no stored protocol to fall back to");

  for (const bad of [
    { apiBase: BASE, model: "" },
    { model: "m" },
    { apiBase: BASE, model: "m", protocol: "grpc" },
    { apiBase: BASE, model: "m", maxOutputTokens: 10 },
  ]) {
    assert.equal(readTestBody(bad).ok, false, JSON.stringify(bad));
  }
  // Messages has no listing, so the test probe is what validates that draft.
  const messages = readTestBody({ apiBase: BASE, model: "m", protocol: "messages" });
  assert.equal(messages.ok, true);
  if (messages.ok) assert.equal(messages.body.protocol, "messages");
});

// ── Stored state ─────────────────────────────────────────────────────

test("a stored key is reused only for the base it was saved against", () => {
  const stored: StoredChannel = {
    apiBase: BASE,
    apiKey: KEY,
    model: "mistral-large",
    alias: "openai/a",
    protocol: "chat_completions",
    contextWindowTokens: 64_000,
    maxOutputTokens: 64_000,
    extraHeaders: {},
  };

  assert.deepEqual(resolveChannelKey(stored, BASE, undefined, false), { ok: true, apiKey: KEY });
  assert.deepEqual(resolveChannelKey(stored, BASE, "sk-other", false), { ok: true, apiKey: "sk-other" });
  assert.deepEqual(resolveChannelKey(stored, BASE, "", true), { ok: true, apiKey: "" });
  assert.deepEqual(resolveChannelKey(stored, "https://new.example/v1", "", true), { ok: true, apiKey: "" });

  const changed = resolveChannelKey(stored, "https://new.example/v1", undefined, false);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.match(changed.fields.apiKey, /different apiBase/);

  const fresh = resolveChannelKey(
    { ...stored, apiBase: "", apiKey: "", model: "" },
    BASE,
    undefined,
    false,
  );
  assert.equal(fresh.ok, false);
  if (!fresh.ok) assert.match(fresh.fields.apiKey, /required for a new channel/);
});

test("stored channel rows degrade to defaults instead of surfacing unusable values", () => {
  const stored = parseChannelRows(CHANNEL_ROWS);
  assert.deepEqual(stored, {
    apiBase: BASE,
    apiKey: KEY,
    model: "mistral-large",
    alias: "openai/decepticon-custom-abc123",
    protocol: "responses",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    extraHeaders: HEADERS,
  });

  // A row written before these fields existed reads back as the documented defaults.
  const legacy = parseChannelRows(CHANNEL_ROWS.slice(0, 4));
  assert.equal(legacy.protocol, "chat_completions");
  assert.equal(legacy.contextWindowTokens, CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS);
  assert.equal(legacy.maxOutputTokens, CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS);
  assert.deepEqual(legacy.extraHeaders, {});

  assert.equal(parseChannelRows([{ key: LLM_CHANNEL_KEYS.apiBase, value: "javascript:alert(1)" }]).apiBase, "");
  assert.equal(parseChannelRows([{ key: LLM_CHANNEL_KEYS.model, value: "two words" }]).model, "");
  assert.equal(parseChannelRows([{ key: LLM_CHANNEL_KEYS.protocol, value: "grpc" }]).protocol, "chat_completions");
  assert.equal(
    parseChannelRows([{ key: LLM_CHANNEL_KEYS.contextWindowTokens, value: "12" }]).contextWindowTokens,
    CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  assert.deepEqual(
    parseChannelRows([{ key: LLM_CHANNEL_KEYS.extraHeaders, value: "{not json" }]).extraHeaders,
    {},
  );
  // A stored credential-bearing header is unusable, not a value to forward.
  assert.deepEqual(
    parseChannelRows([{ key: LLM_CHANNEL_KEYS.extraHeaders, value: '{"authorization":"x"}' }]).extraHeaders,
    {},
  );
  // A stored output above its window is clamped: the pair must stay consistent.
  const clamped = parseChannelRows([
    { key: LLM_CHANNEL_KEYS.contextWindowTokens, value: "2048" },
    { key: LLM_CHANNEL_KEYS.maxOutputTokens, value: "128000" },
  ]);
  assert.equal(clamped.maxOutputTokens, 2048);
});

test("discovery and probe bodies validate headers the same way a save does", () => {
  // Headers are part of what makes an endpoint answer, so both the listing probe
  // and the test probe carry them — with the identical rules as a save.
  const discover = readDiscoverBody({ apiBase: BASE, protocol: "chat_completions", extraHeaders: { "X-Team": "red" } });
  assert.equal(discover.ok, true);
  if (discover.ok) assert.deepEqual(discover.body.extraHeaders, { "x-team": "red" });

  const test = readTestBody({ apiBase: BASE, model: "m", extraHeaders: { "X-Team": "red" } });
  assert.equal(test.ok, true);
  if (test.ok) assert.deepEqual(test.body.extraHeaders, { "x-team": "red" });
  const optionalTest = readTestBody({ apiBase: BASE, model: "m" });
  assert.equal(optionalTest.ok, true, "headers stay optional");
  if (optionalTest.ok) assert.equal(optionalTest.body.extraHeaders, undefined);

  for (const bad of [{ authorization: "Bearer x" }, { "x-evil": "a\r\nX: 1" }, ["x-team"], "x-team: red"]) {
    assert.equal(readDiscoverBody({ apiBase: BASE, protocol: "chat_completions", extraHeaders: bad }).ok, false, JSON.stringify(bad));
    assert.equal(readTestBody({ apiBase: BASE, model: "m", extraHeaders: bad }).ok, false, JSON.stringify(bad));
  }
});

test("a blank header value keeps the stored secret; a blank row only where one exists", () => {
  const stored: StoredChannel = {
    apiBase: BASE,
    apiKey: KEY,
    model: "mistral-large",
    alias: "openai/a",
    protocol: "chat_completions",
    contextWindowTokens: 64_000,
    maxOutputTokens: 64_000,
    extraHeaders: { "x-team": "red" },
  };
  assert.deepEqual(resolveChannelHeaders({ "x-team": "" }, stored.extraHeaders), { "x-team": "red" });
  assert.deepEqual(resolveChannelHeaders({ "x-new": "" }, stored.extraHeaders), { "x-new": "" }, "nothing stored to reuse");
  assert.deepEqual(resolveChannelHeaders(undefined, stored.extraHeaders), { "x-team": "red" });

  // A value is a credential of ITS endpoint: another base never receives it.
  assert.deepEqual(storedChannelHeaders(BASE, stored), { "x-team": "red" });
  assert.deepEqual(storedChannelHeaders("https://other.example/v1", stored), {});

  const moved = resolveChannelConfig({ model: "m", keyless: false, apiBase: "https://other.example/v1", extraHeaders: { "x-team": "" } }, stored);
  assert.deepEqual(moved.extraHeaders, { "x-team": "" }, "the old endpoint's header never follows a base change");
});

test("the snapshot exposes header names and every registered protocol, never a value", () => {
  const snapshot = channelSnapshot(parseChannelRows(CHANNEL_ROWS));
  assert.deepEqual(snapshot, {
    apiBase: BASE,
    apiKeySet: true,
    model: "mistral-large",
    protocol: "responses",
    protocols: ["chat_completions", "responses", "messages"],
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    extraHeadersSet: ["x-api-version", "x-team"],
  });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes("red"), false, "a header value never reaches the payload");

  assert.deepEqual(extraHeaderNames({}), []);
});

test("a successful save reads back exactly what a later GET returns", () => {
  const stored = parseChannelRows(CHANNEL_ROWS.slice(0, 4));
  const snapshot = savedChannelSnapshot(
    stored,
    { model: "m", keyless: false, contextWindowTokens: 2048, maxOutputTokens: 4096 },
    BASE,
    KEY,
    "openai/decepticon-custom-new",
  );
  // The stored output (64000) was above the new window: the response reports the
  // clamped value, so it cannot disagree with the row that was written.
  assert.equal(snapshot.contextWindowTokens, 2048);
  assert.equal(snapshot.maxOutputTokens, 2048);
  assert.equal(snapshot.apiKeySet, true);
  assert.equal(snapshot.model, "m");
});

test("resolveChannelConfig keeps stored values for absent fields and shrinks the output", () => {
  const stored = parseChannelRows(CHANNEL_ROWS);
  assert.deepEqual(resolveChannelConfig({ model: "m", keyless: false }, stored), {
    protocol: "responses",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    extraHeaders: HEADERS,
  });
  assert.deepEqual(
    resolveChannelConfig({ model: "m", keyless: false, contextWindowTokens: 8192 }, stored),
    { protocol: "responses", contextWindowTokens: 8192, maxOutputTokens: 4096, extraHeaders: HEADERS },
  );
  assert.deepEqual(
    resolveChannelConfig({ model: "m", keyless: false, contextWindowTokens: 2048, extraHeaders: {} }, stored),
    { protocol: "responses", contextWindowTokens: 2048, maxOutputTokens: 2048, extraHeaders: {} },
  );
});

test("clearing only unsets a global override that still points at this channel's alias", () => {
  const stored = parseChannelRows(CHANNEL_ROWS);
  const save = { model: "", keyless: true };

  const ours = channelWriteChanges(save, stored, "openai/decepticon-custom-abc123", undefined, "");
  assert.deepEqual(ours, [
    { key: LLM_CHANNEL_KEYS.apiBase, value: null },
    { key: LLM_CHANNEL_KEYS.apiKey, value: null },
    { key: LLM_CHANNEL_KEYS.model, value: null },
    { key: LLM_CHANNEL_KEYS.alias, value: null },
    { key: LLM_CHANNEL_KEYS.protocol, value: null },
    { key: LLM_CHANNEL_KEYS.contextWindowTokens, value: null },
    { key: LLM_CHANNEL_KEYS.maxOutputTokens, value: null },
    { key: LLM_CHANNEL_KEYS.extraHeaders, value: null },
    { key: SETTING_KEYS.globalModelOverride, value: null },
  ]);

  const theirs = channelWriteChanges(save, stored, "openai/gpt-5", undefined, "");
  assert.equal(theirs.some((change) => change.key === SETTING_KEYS.globalModelOverride), false);
});

test("a save writes protocol, tokens and headers alongside the alias in one change set", () => {
  const stored = parseChannelRows(CHANNEL_ROWS);
  const changes = new Map(
    channelWriteChanges(
      { model: "mistral-small", keyless: false, protocol: "chat_completions", contextWindowTokens: 16000, maxOutputTokens: 2000, extraHeaders: { "x-a": "1" } },
      stored,
      "openai/decepticon-custom-abc123",
      KEY,
      "openai/decepticon-custom-new",
    ).map((change) => [change.key, change.value]),
  );

  assert.equal(changes.get(LLM_CHANNEL_KEYS.protocol), "chat_completions");
  assert.equal(changes.get(LLM_CHANNEL_KEYS.contextWindowTokens), "16000");
  assert.equal(changes.get(LLM_CHANNEL_KEYS.maxOutputTokens), "2000");
  assert.equal(changes.get(LLM_CHANNEL_KEYS.extraHeaders), JSON.stringify({ "x-a": "1" }));
  assert.equal(changes.get(LLM_CHANNEL_KEYS.alias), "openai/decepticon-custom-new");
  assert.equal(changes.get(SETTING_KEYS.globalModelOverride), "openai/decepticon-custom-new");

  // No headers = no row, so the stored blob cannot linger as an empty object.
  const cleared = channelWriteChanges(
    { model: "m", keyless: false, extraHeaders: {} },
    stored,
    "",
    KEY,
    "openai/decepticon-custom-new",
  );
  assert.equal(cleared.find((change) => change.key === LLM_CHANNEL_KEYS.extraHeaders)?.value, null);

  // A blank value for a saved name means "keep the stored secret": the card can
  // only render the NAME back, so without this rule a save would wipe the value.
  const kept = channelWriteChanges(
    { model: "m", keyless: false, extraHeaders: { "x-team": "", "x-new": "typed" } },
    stored,
    "",
    KEY,
    "openai/decepticon-custom-new",
  );
  assert.equal(
    kept.find((change) => change.key === LLM_CHANNEL_KEYS.extraHeaders)?.value,
    JSON.stringify({ "x-team": "red", "x-new": "typed" }),
  );
});

// ── Response guard ───────────────────────────────────────────────────

test("a response written before the new fields existed still parses, with defaults", () => {
  assert.deepEqual(
    parseChannelSnapshot({ apiBase: "", apiKeySet: false, model: "" }),
    {
      apiBase: "",
      apiKeySet: false,
      model: "",
      protocol: "chat_completions",
      protocols: ["chat_completions", "responses", "messages"],
      contextWindowTokens: CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS,
      extraHeadersSet: [],
    },
    "an older server payload is usable, not a page error",
  );

  assert.deepEqual(
    parseChannelSnapshot({
      apiBase: BASE,
      apiKeySet: true,
      model: "m",
      protocol: "responses",
      protocols: ["chat_completions", "responses", "messages"],
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      extraHeadersSet: ["x-team"],
    }),
    {
      apiBase: BASE,
      apiKeySet: true,
      model: "m",
      protocol: "responses",
      protocols: ["chat_completions", "responses", "messages"],
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      extraHeadersSet: ["x-team"],
    },
  );

  // A PRESENT field of the wrong shape is malformed, not a default to fall back on.
  for (const bad of [
    { apiBase: "", model: "" },
    { apiBase: "", apiKeySet: false, model: "", protocol: "grpc" },
    { apiBase: "", apiKeySet: false, model: "", contextWindowTokens: 10 },
    { apiBase: "", apiKeySet: false, model: "", maxOutputTokens: "4096" },
    { apiBase: "", apiKeySet: false, model: "", extraHeadersSet: "x-team" },
    { apiBase: "", apiKeySet: false, model: "", extraHeadersSet: [1] },
    { apiBase: "", apiKeySet: false, model: "", protocols: ["grpc"] },
  ]) {
    assert.equal(parseChannelSnapshot(bad), null, JSON.stringify(bad));
  }
});

// ── Endpoint discovery ───────────────────────────────────────────────

/** Endpoint stub: records the request and answers with an OpenAI-style model list. */
function endpoint(models: string[], record?: { url?: string; init?: RequestInit }) {
  return (async (url: string, init: RequestInit) => {
    if (record) {
      record.url = url;
      record.init = init;
    }
    return new Response(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("discovery sends the key server-side, follows no redirect and never echoes upstream detail", async () => {
  const record: { url?: string; init?: RequestInit } = {};
  const models = await discoverChannelModels(
    { apiBase: BASE, apiKey: KEY, protocol: "chat_completions" },
    endpoint(["mistral-large", "mistral-small", "mistral-large"], record),
  );
  assert.deepEqual(models, ["mistral-large", "mistral-small"], "duplicates are dropped");
  assert.equal(record.url, `${BASE}/models`);
  assert.equal((record.init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.equal(record.init?.redirect, "manual", "a redirect would carry the header to another origin");

  const keyless = await discoverChannelModels(
    { apiBase: BASE, apiKey: "", protocol: "chat_completions" },
    endpoint(["m"], record),
  );
  assert.deepEqual(keyless, ["m"]);
  assert.equal((record.init?.headers as Record<string, string>).Authorization, undefined);

  const failures: Array<[typeof fetch, RegExp]> = [
    [(async () => new Response("", { status: 302, headers: { location: "https://evil" } })) as unknown as typeof fetch, /redirect/],
    [(async () => new Response(`{"key":"${KEY}"}`, { status: 401 })) as unknown as typeof fetch, /rejected the API key/],
    [(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch, /HTTP 500/],
    [(async () => new Response("<html>proxy error</html>", { status: 200 })) as unknown as typeof fetch, /did not return JSON/],
    [(async () => new Response(JSON.stringify({ data: "nope" }), { status: 200 })) as unknown as typeof fetch, /OpenAI-compatible/],
    [(async () => { throw new Error(`connect ECONNREFUSED ${BASE}?api_key=${KEY}`); }) as unknown as typeof fetch, /Could not reach the endpoint/],
  ];
  for (const [impl, pattern] of failures) {
    await assert.rejects(
      discoverChannelModels({ apiBase: BASE, apiKey: KEY, protocol: "chat_completions" }, impl),
      (error: Error) => {
        assert.match(error.message, pattern);
        assert.equal(error.message.includes(KEY), false, "the credential never appears in the error");
        return true;
      },
    );
  }
});

test("a protocol with no listing path never contacts the endpoint", async () => {
  let called = false;
  const models = await discoverChannelModels(
    { apiBase: BASE, apiKey: KEY, protocol: "messages" },
    (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  );
  assert.equal(models, null, "manual entry is the answer, not an empty list");
  assert.equal(called, false);
});

test("the test probe speaks the protocol's request shape and reports only fixed wording", async () => {
  const record: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const answer = (body: unknown) =>
    (async (url: string, init: RequestInit) => {
      record.url = url;
      record.body = JSON.parse(String(init.body)) as Record<string, unknown>;
      record.headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

  const chatProbe: TestModelInput = {
    apiBase: BASE,
    apiKey: KEY,
    protocol: "chat_completions",
    model: "mistral-large",
    maxOutputTokens: 128_000,
    extraHeaders: { "x-team": "red" },
  };
  const chat = await testChannelModel(chatProbe, answer({ choices: [{ message: { content: "pong" } }] }));
  assert.deepEqual(chat, { ok: true, detail: "The endpoint answered the test request" });
  assert.equal(record.url, `${BASE}/chat/completions`);
  assert.equal(record.headers?.Authorization, `Bearer ${KEY}`);
  assert.equal(record.headers?.["x-team"], "red", "the operator's own headers ride along");
  assert.equal(record.body?.max_tokens, 8, "the probe caps far below the declared ceiling");
  assert.equal(record.body?.model, "mistral-large");

  const responses = await testChannelModel(
    { ...chatProbe, apiBase: `${BASE}/responses`, protocol: "responses", model: "m" },
    answer({ id: "resp_1" }),
  );
  assert.equal(responses.ok, true);
  assert.equal(record.url, `${BASE}/responses`, "a base already ending in the protocol path is not doubled");
  assert.deepEqual(record.body, { model: "m", input: "ping", max_output_tokens: 8 });

  const messages = await testChannelModel(
    { ...chatProbe, protocol: "messages", model: "claude-x" },
    answer({ id: "msg_1" }),
  );
  assert.equal(messages.ok, true);
  // The probe assembles the URL the same way LiteLLM does: the operator's base
  // (with a `/v1` the protocol already appends dropped) plus `/v1/messages`, so a
  // pasted `…/v1` does NOT become `…/v1/v1/messages`.
  assert.equal(record.url, `https://llm.internal.example/v1/messages`);
  assert.equal(record.headers?.["x-api-key"], KEY, "Anthropic-compatible endpoints authenticate with x-api-key");
  assert.equal(record.headers?.Authorization, undefined);
  assert.equal(record.headers?.["anthropic-version"], "2023-06-01");
  assert.deepEqual(record.body, { model: "claude-x", max_tokens: 8, messages: [{ role: "user", content: "ping" }] });

  const failures: Array<[Response | Error, string, number]> = [
    [new Response("", { status: 302 }), "Endpoint redirected the request; use the final URL directly", 502],
    [new Response(`{"error":"key ${KEY}"}`, { status: 401 }), "The endpoint rejected the API key", 401],
    [new Response("", { status: 404 }), "The endpoint has no /chat/completions route for this protocol", 404],
    [new Response("", { status: 429 }), "The endpoint rate-limited the test request", 502],
    [new Response("<html>nope</html>", { status: 200 }), "Endpoint did not return JSON", 502],
    [new Error(`connect ECONNREFUSED ${BASE}`), "Could not reach the endpoint", 502],
  ];
  for (const [reply, detail, status] of failures) {
    const impl = (async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }) as unknown as typeof fetch;
    const result = await testChannelModel(chatProbe, impl);
    assert.deepEqual(result, { ok: false, detail, status });
    assert.equal(detail.includes(KEY), false, "upstream text never reaches the message");
  }
});

test("an oversized or oversized-count model list is capped, not trusted", () => {
  assert.equal(listedModels({ data: "x" }), null);
  assert.deepEqual(listedModels({ data: [{ id: "  a  " }, { nope: 1 }, { id: "a" }] }), ["a"]);
  const many = listedModels({ data: Array.from({ length: LLM_CHANNEL_LIMITS.modelsMaxCount + 50 }, (_, i) => ({ id: `m${i}` })) });
  assert.equal(many?.length, LLM_CHANNEL_LIMITS.modelsMaxCount);
});
