import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError } from "./auth-bridge";
import { LLM_CHANNEL_KEYS } from "./llm-channel";
import {
  discoverModels,
  getChannel,
  putChannel,
  testChannel,
  type ChannelApiDeps,
  type ChannelRegistration,
} from "./llm-channel-api";
import { SETTING_KEYS, type SettingRow, type SettingsEnv } from "./system-settings";
import type { SettingsStore } from "./system-settings-runtime";

const ENV: SettingsEnv = { WEB_PORT: "3000", DATABASE_URL: "postgres://user:pw@db:5432/decepticon_web" };
const KEY = "sk-channel-secret";
const BASE = "https://llm.internal.example/v1";
const ALIAS = "openai/decepticon-custom-abc123";
const HEADERS = { "x-team": "red" };

function memoryStore(initial: SettingRow[] = []): SettingsStore & { rows: Map<string, string> } {
  const rows = new Map(initial.map((row) => [row.key, row.value]));
  return {
    rows,
    read: async () => [...rows].map(([key, value]) => ({ key, value })),
    write: async (changes) => {
      for (const { key, value } of changes) {
        if (value === null) rows.delete(key);
        else rows.set(key, value);
      }
    },
  };
}

const CHANNEL_ROWS: SettingRow[] = [
  { key: LLM_CHANNEL_KEYS.apiBase, value: BASE },
  { key: LLM_CHANNEL_KEYS.apiKey, value: KEY },
  { key: LLM_CHANNEL_KEYS.model, value: "mistral-large" },
  { key: LLM_CHANNEL_KEYS.alias, value: ALIAS },
  { key: LLM_CHANNEL_KEYS.protocol, value: "responses" },
  { key: LLM_CHANNEL_KEYS.contextWindowTokens, value: "32768" },
  { key: LLM_CHANNEL_KEYS.maxOutputTokens, value: "4096" },
  { key: LLM_CHANNEL_KEYS.extraHeaders, value: JSON.stringify(HEADERS) },
  { key: SETTING_KEYS.globalModelOverride, value: ALIAS },
];

function jsonRequest(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function deps(store: SettingsStore, overrides: Partial<ChannelApiDeps> = {}): ChannelApiDeps {
  return {
    store,
    authenticate: async () => ({}),
    env: ENV,
    register: async () => "openai/decepticon-custom-newhash",
    ...overrides,
  };
}

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

/**
 * Endpoint stub for a save, which asks the endpoint TWO questions: the listing
 * (GET) and the protocol's own request (POST). `probe` is the POST answer —
 * accepted unless a test supplies a rejection.
 */
function saveEndpoint(
  models: string[],
  probe?: Response,
  record?: { url?: string; init?: RequestInit },
) {
  return (async (url: string, init: RequestInit) => {
    if (record) {
      record.url = url;
      record.init = init;
    }
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }), { status: 200 });
    }
    return probe ?? new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("every verb is 401 without a session and GET never returns the key or a header value", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const reject = () => Promise.reject(new AuthError());
  for (const response of [
    await getChannel(deps(store, { authenticate: reject })),
    await putChannel(jsonRequest({ apiBase: BASE, model: "" }), deps(store, { authenticate: reject })),
    await discoverModels(jsonRequest({ apiBase: BASE, protocol: "chat_completions" }), deps(store, { authenticate: reject })),
    await testChannel(jsonRequest({ apiBase: BASE, model: "m" }), deps(store, { authenticate: reject })),
  ]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await body(response), { error: "Unauthorized" });
  }

  const payload = await body(await getChannel(deps(store)));
  assert.deepEqual(payload, {
    apiBase: BASE,
    apiKeySet: true,
    model: "mistral-large",
    protocol: "responses",
    protocols: ["chat_completions", "responses", "messages"],
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    extraHeadersSet: ["x-team"],
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes("red"), false, "a header value is never returned");

  assert.deepEqual(await body(await getChannel(deps(memoryStore()))), {
    apiBase: "",
    apiKeySet: false,
    model: "",
    protocol: "chat_completions",
    protocols: ["chat_completions", "responses", "messages"],
    contextWindowTokens: 64_000,
    maxOutputTokens: 64_000,
    extraHeadersSet: [],
  });
});

test("POST /models reuses the stored key only for the stored base and reports manual listing", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const record: { url?: string; init?: RequestInit } = {};
  const ok = await discoverModels(
    jsonRequest({ apiBase: `${BASE}/`, protocol: "chat_completions" }),
    deps(store, { fetchImpl: endpoint(["mistral-large"], record) }),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await body(ok), { models: ["mistral-large"], manual: false });
  assert.equal((record.init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);

  // A base change with no key must not hit the network at all.
  let called = false;
  const changed = await discoverModels(
    jsonRequest({ apiBase: "https://other.example/v1", protocol: "chat_completions" }),
    deps(store, {
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal(changed.status, 400);
  assert.equal(called, false, "no request is made with a key belonging to another endpoint");
  const payload = await body(changed);
  assert.equal(JSON.stringify(payload).includes(KEY), false);
  assert.ok((payload.fields as Record<string, string>).apiKey);

  const upstream = await discoverModels(
    jsonRequest({ apiBase: BASE, apiKey: "sk-new", protocol: "chat_completions" }),
    deps(store, { fetchImpl: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch }),
  );
  assert.equal(upstream.status, 502);
  assert.deepEqual(await body(upstream), { error: "The endpoint rejected the API key" });
});

test("stored header values are reused for the same base only, and never echoed back", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const record: { init?: RequestInit } = {};

  // Same base + blank value = the stored value is attached server-side.
  await discoverModels(
    jsonRequest({ apiBase: BASE, protocol: "chat_completions", extraHeaders: { "x-team": "" } }),
    deps(store, { fetchImpl: endpoint(["mistral-large"], record) }),
  );
  assert.equal((record.init?.headers as Record<string, string>)["x-team"], "red");

  // A typed value replaces it.
  await discoverModels(
    jsonRequest({ apiBase: BASE, protocol: "chat_completions", extraHeaders: { "x-team": "blue" } }),
    deps(store, { fetchImpl: endpoint(["mistral-large"], record) }),
  );
  assert.equal((record.init?.headers as Record<string, string>)["x-team"], "blue");

  // A different base never receives it: the credential belongs to the old endpoint
  // (an empty string is what the shared resolver leaves for an unknown name).
  const movedRecord: { init?: RequestInit } = {};
  const moved = await discoverModels(
    jsonRequest({ apiBase: "https://other.example/v1", apiKey: "sk-new", protocol: "chat_completions", extraHeaders: { "x-team": "" } }),
    deps(store, { fetchImpl: endpoint(["m"], movedRecord) }),
  );
  assert.equal(moved.status, 200);
  assert.equal((movedRecord.init?.headers as Record<string, string>)["x-team"] ?? "", "", "the old endpoint's header is not reused");

  // The probe is the same rule.
  const probeRecord: { init?: RequestInit } = {};
  await testChannel(
    jsonRequest({ apiBase: BASE, model: "mistral-large", protocol: "chat_completions", extraHeaders: { "x-team": "" } }),
    deps(store, {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        probeRecord.init = init;
        return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal((probeRecord.init?.headers as Record<string, string>)["x-team"], "red");
  assert.equal(JSON.stringify(await body(await getChannel(deps(store)))).includes("red"), false, "the value never leaves the server");
});

test("an unknown protocol is refused with a named field, before any request", async () => {
  const store = memoryStore();
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  for (const response of [
    await discoverModels(jsonRequest({ apiBase: BASE, protocol: "grpc" }), deps(store, { fetchImpl })),
    await putChannel(jsonRequest({ apiBase: BASE, apiKey: KEY, model: "m", protocol: "grpc" }), deps(store, { fetchImpl })),
    await testChannel(jsonRequest({ apiBase: BASE, model: "m", protocol: "grpc" }), deps(store, { fetchImpl })),
  ]) {
    assert.equal(response.status, 400);
    const fields = (await body(response)).fields as Record<string, string>;
    assert.match(fields.protocol, /must be one of chat_completions, responses, messages/);
  }
  assert.equal(called, false, "an unknown protocol never reaches the endpoint");
});

test("Anthropic Messages is offered but has no model list, so discovery names the field", async () => {
  const store = memoryStore();
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const response = await discoverModels(jsonRequest({ apiBase: BASE, protocol: "messages" }), deps(store, { fetchImpl }));
  assert.equal(response.status, 400);
  const fields = (await body(response)).fields as Record<string, string>;
  assert.equal(fields.protocol, "this protocol has no model list — enter the model id");
  assert.equal(called, false, "no listing path is requested for a protocol that has none");
});

test("PUT saves the channel configuration and the global alias override in one write", async () => {
  const store = memoryStore();
  const registered: ChannelRegistration[] = [];
  const response = await putChannel(
    jsonRequest({
      apiBase: BASE,
      apiKey: KEY,
      model: "mistral-large",
      protocol: "responses",
      contextWindowTokens: 16384,
      maxOutputTokens: 2048,
      extraHeaders: HEADERS,
    }),
    deps(store, {
      fetchImpl: saveEndpoint(["mistral-large", "mistral-small"]),
      register: async (input) => {
        registered.push(input);
        return "openai/decepticon-custom-newhash";
      },
    }),
  );

  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.deepEqual(payload, {
    apiBase: BASE,
    apiKeySet: true,
    model: "mistral-large",
    protocol: "responses",
    protocols: ["chat_completions", "responses", "messages"],
    contextWindowTokens: 16384,
    maxOutputTokens: 2048,
    extraHeadersSet: ["x-team"],
    globalModelOverride: "openai/decepticon-custom-newhash",
  });
  assert.equal(JSON.stringify(payload).includes(KEY), false);
  assert.equal(JSON.stringify(payload).includes("red"), false, "the response carries header names only");
  assert.deepEqual(registered, [
    {
      apiBase: BASE,
      apiKey: KEY,
      model: "mistral-large",
      protocol: "responses",
      contextWindowTokens: 16384,
      maxOutputTokens: 2048,
      extraHeaders: HEADERS,
    },
  ]);
  assert.equal(store.rows.get(SETTING_KEYS.globalModelOverride), "openai/decepticon-custom-newhash");
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.alias), "openai/decepticon-custom-newhash");
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.apiKey), KEY);
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.protocol), "responses");
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.contextWindowTokens), "16384");
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.maxOutputTokens), "2048");
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.extraHeaders), JSON.stringify(HEADERS));
});

test("a save with no protocol/token/header fields keeps the stored configuration", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const registered: ChannelRegistration[] = [];
  const response = await putChannel(
    jsonRequest({ apiBase: BASE, model: "mistral-large" }),
    deps(store, {
      fetchImpl: saveEndpoint(["mistral-large"]),
      register: async (input) => {
        registered.push(input);
        return "openai/decepticon-custom-newhash";
      },
    }),
  );

  assert.equal(response.status, 200);
  // A client that predates the fields must not reset the channel to defaults.
  assert.deepEqual(registered[0], {
    apiBase: BASE,
    apiKey: KEY,
    model: "mistral-large",
    protocol: "responses",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    extraHeaders: HEADERS,
  });
  assert.equal((await body(response)).protocol, "responses");
});

test("a smaller context window shrinks the output budget instead of writing an impossible pair", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const registered: ChannelRegistration[] = [];
  const response = await putChannel(
    jsonRequest({ apiBase: BASE, model: "mistral-large", contextWindowTokens: 2048 }),
    deps(store, {
      fetchImpl: saveEndpoint(["mistral-large"]),
      register: async (input) => {
        registered.push(input);
        return "openai/decepticon-custom-newhash";
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(registered[0].contextWindowTokens, 2048);
  assert.equal(registered[0].maxOutputTokens, 2048, "the stored 4096 output is clamped to the new window");
  const payload = await body(response);
  assert.equal(payload.contextWindowTokens, 2048);
  assert.equal(payload.maxOutputTokens, 2048, "the response reports what was written, not what was requested");
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.maxOutputTokens), "2048");
});

test("a protocol without a model list is validated by a test probe, and a failing probe saves nothing", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    return init.method === "POST"
      ? new Response(JSON.stringify({ error: "bad key" }), { status: 401 })
      : new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  let registered = false;
  const response = await putChannel(
    jsonRequest({ apiBase: BASE, model: "claude-x", protocol: "messages" }),
    deps(store, {
      fetchImpl,
      register: async () => {
        registered = true;
        return "openai/decepticon-custom-newhash";
      },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(registered, false);
  assert.equal(store.rows.get(LLM_CHANNEL_KEYS.model), "mistral-large", "the stored channel is untouched");
  const fields = (await body(response)).fields as Record<string, string>;
  assert.equal(fields.apiKey, "The endpoint rejected the API key");
  // No listing for this protocol: the draft is validated by ONE request to the
  // protocol's own path (the same URL the proxy will call), and nothing else.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.startsWith(BASE), "the operator's base is used");
  assert.ok(calls[0].url.endsWith("/v1/messages"), calls[0].url);
});

test("a save probes the protocol's own route even when the model listing succeeded", async () => {
  // The listing is a GET on the OpenAI-compatible route: it proves the model id
  // and nothing about `/responses`. A save whose protocol the endpoint does not
  // implement must be refused while the operator is still looking at the form —
  // otherwise the alias is registered and adopted, and the first agent call is
  // the only thing that ever reports the protocol as missing.
  const store = memoryStore();
  const calls: Array<{ method: string; url: string }> = [];
  let registered = false;
  const response = await putChannel(
    jsonRequest({ apiBase: BASE, apiKey: KEY, model: "mistral-large", protocol: "responses" }),
    deps(store, {
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ method: init.method ?? "GET", url: String(url) });
        return (init.method ?? "GET") === "GET"
          ? new Response(JSON.stringify({ object: "list", data: [{ id: "mistral-large" }] }), { status: 200 })
          : new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
      register: async () => {
        registered = true;
        return "openai/decepticon-custom-x";
      },
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(calls, [
    { method: "GET", url: `${BASE}/models` },
    { method: "POST", url: `${BASE}/responses` },
  ]);
  const fields = (await body(response)).fields as Record<string, string>;
  assert.equal(fields.protocol, "The endpoint has no /responses route for this protocol");
  assert.equal(registered, false, "nothing is registered for a protocol the endpoint does not serve");
  assert.equal(store.rows.size, 0, "no channel row and no global override is written");

  // A rejected credential is answered on the key field, not the protocol one.
  const wrongKey = await putChannel(
    jsonRequest({ apiBase: BASE, apiKey: KEY, model: "mistral-large", protocol: "chat_completions" }),
    deps(memoryStore(), {
      fetchImpl: saveEndpoint(["mistral-large"], new Response("denied", { status: 401 })),
      register: async () => {
        registered = true;
        return "openai/decepticon-custom-x";
      },
    }),
  );
  assert.equal(wrongKey.status, 400);
  const keyFields = (await body(wrongKey)).fields as Record<string, string>;
  assert.equal(keyFields.apiKey, "The endpoint rejected the API key");
  assert.equal(registered, false);

  // A probe that fails for a reason no form field can fix (rate limit, upstream
  // 5xx, network) is reported with the probe's own status and no field error, so
  // the banner matches the class of failure instead of blaming an input.
  const throttled = memoryStore();
  const busy = await putChannel(
    jsonRequest({ apiBase: BASE, apiKey: KEY, model: "mistral-large" }),
    deps(throttled, {
      fetchImpl: saveEndpoint(["mistral-large"], new Response("", { status: 429 })),
      register: async () => {
        registered = true;
        return "openai/decepticon-custom-x";
      },
    }),
  );
  assert.equal(busy.status, 502);
  assert.deepEqual(await body(busy), { error: "The endpoint rate-limited the test request" });
  assert.equal(registered, false);
  assert.equal(throttled.rows.size, 0);
});

test("PUT refuses a model the endpoint does not offer, without registering or writing", async () => {
  const store = memoryStore();
  let registered = false;
  const response = await putChannel(
    jsonRequest({ apiBase: BASE, apiKey: KEY, model: "ghost-model" }),
    deps(store, {
      fetchImpl: endpoint(["mistral-large"]),
      register: async () => {
        registered = true;
        return "openai/decepticon-custom-x";
      },
    }),
  );

  assert.equal(response.status, 400);
  const payload = await body(response);
  assert.match((payload.fields as Record<string, string>).model, /does not offer/);
  assert.equal(registered, false);
  assert.equal(store.rows.size, 0);
});

test("a registration or storage failure never masquerades as a saved channel and never leaks the key", async () => {
  const failingRegister = await putChannel(
    jsonRequest({ apiBase: BASE, apiKey: KEY, model: "mistral-large" }),
    deps(memoryStore(), {
      fetchImpl: saveEndpoint(["mistral-large"]),
      register: async () => {
        throw new Error(`litellm rejected key ${KEY}`);
      },
    }),
  );
  assert.equal(failingRegister.status, 502);
  assert.equal(JSON.stringify(await body(failingRegister)).includes(KEY), false);

  const store = memoryStore();
  const pruned: string[] = [];
  const failingWrite = await putChannel(
    jsonRequest({ apiBase: BASE, apiKey: KEY, model: "mistral-large" }),
    deps(
      {
        read: store.read,
        write: async () => {
          throw new Error(`relation "SystemSetting" does not exist (${KEY})`);
        },
      },
      { fetchImpl: saveEndpoint(["mistral-large"]), unregister: async (alias) => void pruned.push(alias) },
    ),
  );
  assert.equal(failingWrite.status, 500);
  const payload = await body(failingWrite);
  assert.deepEqual(payload, { error: "Failed to save the LLM channel" });
  assert.equal(JSON.stringify(payload).includes(KEY), false);
  assert.deepEqual(pruned, ["openai/decepticon-custom-newhash"], "the unreferenced registration is pruned");
});

test("changing the base demands the new endpoint's key before anything is contacted", async () => {
  let called = false;
  const response = await putChannel(
    jsonRequest({ apiBase: "https://new.example/v1", model: "mistral-large" }),
    deps(memoryStore(CHANNEL_ROWS), {
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
  const fields = (await body(response)).fields as Record<string, string>;
  assert.match(fields.apiKey, /different apiBase/);
});

test("POST /test probes the unsaved draft and forwards only fixed wording", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const record: { url?: string; init?: RequestInit } = {};
  const ok = await testChannel(
    jsonRequest({ apiBase: BASE, model: "mistral-large", protocol: "chat_completions", maxOutputTokens: 4096 }),
    deps(store, {
      fetchImpl: (async (url: string, init: RequestInit) => {
        record.url = url;
        record.init = init;
        return new Response(JSON.stringify({ choices: [{ message: { content: `${KEY} ok` } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal(ok.status, 200);
  const payload = await body(ok);
  assert.deepEqual(payload, { ok: true, detail: "The endpoint answered the test request" });
  assert.equal(JSON.stringify(payload).includes(KEY), false);
  assert.equal(record.url, `${BASE}/chat/completions`);
  assert.equal((record.init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`, "the stored key is reused server-side");

  // A rejection keeps the status class and never echoes the upstream body.
  const rejected = await testChannel(
    jsonRequest({ apiBase: BASE, model: "mistral-large" }),
    deps(store, {
      fetchImpl: (async () => new Response(`{"error":"secret ${KEY}"}`, { status: 401 })) as unknown as typeof fetch,
    }),
  );
  assert.equal(rejected.status, 401);
  const failure = await body(rejected);
  assert.deepEqual(failure, { ok: false, detail: "The endpoint rejected the API key" });
  assert.equal(JSON.stringify(failure).includes(KEY), false);

  const down = await testChannel(
    jsonRequest({ apiBase: BASE, model: "m" }),
    deps(store, {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal(down.status, 502);
  assert.deepEqual(await body(down), { ok: false, detail: "Could not reach the endpoint" });
});

test("clearing drops every channel row, unsets only its own alias override and prunes the registration", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const pruned: string[] = [];
  const response = await putChannel(
    jsonRequest({ model: "" }),
    deps(store, { unregister: async (alias) => void pruned.push(alias) }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    apiBase: "",
    apiKeySet: false,
    model: "",
    protocol: "responses",
    protocols: ["chat_completions", "responses", "messages"],
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    extraHeadersSet: [],
    globalModelOverride: "",
  });
  assert.equal(store.rows.size, 0, "every channel row is deleted, including the alias override");
  assert.deepEqual(pruned, [ALIAS]);

  const unrelated = memoryStore([
    ...CHANNEL_ROWS.filter((row) => row.key !== SETTING_KEYS.globalModelOverride),
    { key: SETTING_KEYS.globalModelOverride, value: "openai/gpt-5" },
  ]);
  const kept = await putChannel(jsonRequest({ model: "" }), deps(unrelated));
  assert.equal((await body(kept)).globalModelOverride, "openai/gpt-5");
  assert.equal(unrelated.rows.get(SETTING_KEYS.globalModelOverride), "openai/gpt-5");
});

test("re-registering prunes the alias it replaced and an unsaved key stays cleared", async () => {
  const store = memoryStore(CHANNEL_ROWS);
  const pruned: string[] = [];
  const record: { init?: RequestInit } = {};
  const response = await putChannel(
    jsonRequest({ apiBase: BASE, model: "mistral-large" }),
    deps(store, {
      fetchImpl: saveEndpoint(["mistral-large"], undefined, record),
      register: async () => "openai/decepticon-custom-newhash",
      unregister: async (alias) => void pruned.push(alias),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(pruned, [ALIAS], "the superseded alias is pruned");
  assert.equal(
    (record.init?.headers as Record<string, string>).Authorization,
    `Bearer ${KEY}`,
    "an unchanged base reuses the stored key without the client resending it",
  );

  const keyless = memoryStore();
  const saved = await putChannel(
    jsonRequest({ apiBase: BASE, apiKey: "", model: "mistral-large" }),
    deps(keyless, { fetchImpl: saveEndpoint(["mistral-large"]) }),
  );
  assert.equal(saved.status, 200);
  const payload = await body(saved);
  assert.equal(payload.apiKeySet, false);
  assert.equal(keyless.rows.has(LLM_CHANNEL_KEYS.apiKey), false, "a keyless channel stores no key row");
});

test("malformed JSON and storage failures keep the documented status codes", async () => {
  const badJson = await putChannel(
    { json: async () => Promise.reject(new SyntaxError("unexpected token")) } as unknown as Request,
    deps(memoryStore()),
  );
  assert.equal(badJson.status, 400);

  const down: SettingsStore = {
    read: async () => {
      throw new Error("connect ECONNREFUSED postgres://user:pw@db");
    },
    write: async () => {},
  };
  for (const response of [
    await getChannel(deps(down)),
    await putChannel(jsonRequest({ model: "" }), deps(down)),
    await discoverModels(jsonRequest({ apiBase: BASE, protocol: "chat_completions" }), deps(down)),
    await testChannel(jsonRequest({ apiBase: BASE, model: "m" }), deps(down)),
  ]) {
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(await body(response)).includes("pw@db"), false);
  }
});
