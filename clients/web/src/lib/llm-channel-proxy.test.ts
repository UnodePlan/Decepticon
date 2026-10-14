/**
 * Behaviour tests for the LiteLLM channel registration adapter.
 *
 * Everything here runs against a scripted `fetch`, so the assertions are about
 * the HTTP contract this module speaks to LiteLLM: which endpoint, which body,
 * which credential, and what happens when a deployment of the same name already
 * exists. The real end-to-end proof (a fixture endpoint registered on a live
 * proxy, then routed through it) is run separately against the compose stack.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_ALIAS_PREFIX,
  CHANNEL_KEYLESS_PLACEHOLDER,
  ChannelModelRegistrationError,
  channelDeploymentId,
  channelModelAlias,
  channelModelId,
  channelUpstreamBase,
  channelUpstreamPath,
  isChannelAliasOrId,
  redactSecrets,
  registerChannelModel,
  removeChannelModel,
  type ChannelModelInput,
} from "./llm-channel-proxy";
import type { ChannelProtocol } from "./llm-channel";
import type { SettingsEnv } from "./system-settings";

const ENV: SettingsEnv = {
  LITELLM_MASTER_KEY: "sk-master-secret-value",
  DECEPTICON_LLM__PROXY_URL: "http://proxy:4000",
};
const API_BASE = "http://gateway.example/v1";
const MODEL = "acme-chat-1";
const HEADERS = { "x-team": "red", "x-api-secret": "sk-header-secret-value" };

function channel(overrides: Partial<ChannelModelInput> = {}): ChannelModelInput {
  return {
    apiBase: API_BASE,
    apiKey: "sk-channel-key",
    model: MODEL,
    protocol: "chat_completions",
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

const ID = channelModelId(API_BASE, MODEL, "chat_completions");
const ALIAS = channelModelAlias(API_BASE, MODEL, "chat_completions");

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string;
}

type Reply = { status: number; payload?: unknown };

/** Minimal stand-in for a LiteLLM management API. */
function scriptedProxy(handler: (call: RecordedCall) => Reply) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: RecordedCall = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      authorization: headers.Authorization ?? "",
    };
    calls.push(call);
    const { status, payload } = handler(call);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(payload ?? {}),
    } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** `/v1/model/info` body for a deployment that looks like one we created. */
function infoPayload(
  options: { id?: string; dbModel?: boolean; ours?: boolean; model?: string; mode?: string } = {},
) {
  return {
    data: [
      {
        model_name: options.model ?? ALIAS,
        litellm_params: { model: "openai/acme-chat-1", api_base: API_BASE },
        model_info: {
          id: options.id ?? ID,
          db_model: options.dbModel ?? true,
          decepticon_channel: options.ours ?? true,
          mode: options.mode ?? "chat",
        },
      },
    ],
  };
}

const notFound: Reply = { status: 400, payload: { detail: { error: "not found" } } };

test("alias and id are derived from endpoint, protocol and model — never from the key or budget", () => {
  assert.ok(channelModelAlias(API_BASE, MODEL, "chat_completions").startsWith(CHANNEL_ALIAS_PREFIX));
  assert.equal(
    channelModelId(API_BASE, MODEL, "chat_completions"),
    channelModelId(`${API_BASE}/`, `${MODEL}`, "chat_completions"),
    "trailing slash is not identity",
  );
  assert.equal(
    channelModelId(API_BASE, MODEL, "chat_completions"),
    channelModelId(API_BASE, MODEL, "chat_completions"),
    "stable",
  );
  assert.notEqual(
    channelModelAlias(API_BASE, MODEL, "chat_completions"),
    channelModelAlias(API_BASE, "acme-chat-2", "chat_completions"),
    "different model → different alias",
  );
  assert.notEqual(
    channelModelAlias(API_BASE, MODEL, "chat_completions"),
    channelModelAlias("http://other.example/v1", MODEL, "chat_completions"),
    "different endpoint → different alias",
  );
  assert.notEqual(
    channelModelAlias(API_BASE, MODEL, "chat_completions"),
    channelModelAlias(API_BASE, MODEL, "responses"),
    "a different protocol is a different deployment: the proxy sends a different request",
  );
  // The key and the budget are configuration of the SAME deployment, so a change
  // to either must refresh it in place instead of leaving a second alias behind.
  assert.equal(
    channelModelId(API_BASE, MODEL, "chat_completions"),
    channelModelId(API_BASE, "acme-chat-1", "chat_completions"),
  );
  assert.ok(isChannelAliasOrId(ALIAS) && isChannelAliasOrId(ID));
  assert.ok(!isChannelAliasOrId("anthropic/claude-opus-5-5") && !isChannelAliasOrId("openai/decepticon-custom-nope"));
});

test("upstream base keeps the operator's path but drops discovery and doubled protocol suffixes", () => {
  assert.equal(channelUpstreamBase("http://h:1234"), "http://h:1234");
  assert.equal(channelUpstreamBase("http://h:1234/v1///"), "http://h:1234/v1");
  assert.equal(channelUpstreamBase("http://h:1234/openai/v1/models"), "http://h:1234/openai/v1");
  // Anthropic appends the FULL `/v1/messages`, so a pasted `/v1` has to go.
  assert.equal(channelUpstreamBase("http://h:1234/v1", "messages"), "http://h:1234");
  assert.equal(channelUpstreamBase("http://h:1234/api/v1", "messages"), "http://h:1234/api");
  assert.equal(channelUpstreamBase("http://h:1234/v1/messages", "messages"), "http://h:1234");
  assert.equal(channelUpstreamBase("http://h:1234/v1/messages/", "messages"), "http://h:1234");
  // Responses and chat only append their own path: `/v1` is the OpenAI convention
  // and stripping it would move the endpoint off `/v1/responses`.
  assert.equal(channelUpstreamBase("http://h:1234/v1", "responses"), "http://h:1234/v1");
  assert.equal(channelUpstreamBase("http://h:1234/v1/responses", "responses"), "http://h:1234/v1");
  assert.equal(channelUpstreamBase("http://h:1234/v1", "chat_completions"), "http://h:1234/v1");
  assert.equal(channelUpstreamBase("http://h:1234/v1/chat/completions", "chat_completions"), "http://h:1234/v1");
  // Without a protocol the base is left alone (it is the operator's own entry).
  assert.equal(channelUpstreamBase("http://h:1234/v1/messages"), "http://h:1234/v1/messages");
  assert.equal(channelUpstreamPath("chat_completions"), "/chat/completions");
  assert.equal(channelUpstreamPath("responses"), "/responses");
  assert.equal(channelUpstreamPath("messages"), "/v1/messages");
  assert.equal(channelDeploymentId(ALIAS), ID);
  assert.equal(channelDeploymentId(ID), ID);
  assert.equal(channelDeploymentId("anthropic/decepticon-custom-abc"), "decepticon-custom-abc");
});

test("redaction removes every occurrence of a secret and ignores short placeholders", () => {
  assert.equal(redactSecrets("key=sk-master-secret-value!", ["sk-master-secret-value"]), "key=[redacted]!");
  assert.equal(redactSecrets("sk-master-secret-value sk-master-secret-value", ["sk-master-secret-value"]), "[redacted] [redacted]");
  assert.equal(redactSecrets("abc", ["abc"]), "abc", "too short to be a real secret");
});

test("registering a new channel model POSTs the deployment with protocol, token and header metadata", async () => {
  // The lookup runs first (miss), then the POST, then verification (hit).
  let lookups = 0;
  const { calls, fetchImpl } = scriptedProxy((call) => {
    if (call.url.includes("/model/info")) {
      lookups += 1;
      return lookups === 1 ? notFound : { status: 200, payload: infoPayload() };
    }
    return { status: 200, payload: {} };
  });

  const alias = await registerChannelModel(channel({ extraHeaders: HEADERS }), { env: ENV, fetchImpl });
  assert.equal(alias, ALIAS);

  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ["GET", "/v1/model/info"],
      ["POST", "/model/new"],
      ["GET", "/v1/model/info"],
    ],
  );
  assert.equal(calls[1].body?.model_name, ALIAS);
  assert.deepEqual(calls[1].body?.litellm_params, {
    model: "openai/acme-chat-1",
    custom_llm_provider: "openai",
    api_base: API_BASE,
    api_key: "sk-channel-key",
    max_tokens: 4096,
    extra_headers: HEADERS,
  });
  assert.deepEqual(calls[1].body?.model_info, {
    id: ID,
    decepticon_channel: true,
    mode: "chat",
    max_input_tokens: 32768,
    max_output_tokens: 4096,
  });
  assert.ok(calls.every((call) => call.authorization === "Bearer sk-master-secret-value"), "master key on every management call");
});

test("each protocol registers with its own mode, provider, model prefix and upstream base", async () => {
  // The model prefix selects the route LiteLLM calls, so it is asserted verbatim:
  // `openai/<model>` POSTs /chat/completions even under `mode: "responses"`, and
  // only `openai/responses/<model>` reaches the Responses API.
  const cases: Array<[ChannelProtocol, string, string, string, string]> = [
    ["chat_completions", "chat", "openai", "openai/acme-chat-1", "http://gateway.example/v1"],
    ["responses", "responses", "openai", "openai/responses/acme-chat-1", "http://gateway.example/v1"],
    // Anthropic appends the full `/v1/messages`, so the pasted `/v1` is dropped or
    // the call would land on `…/v1/v1/messages`.
    ["messages", "anthropic_messages", "anthropic", "anthropic/acme-chat-1", "http://gateway.example"],
  ];

  for (const [protocol, mode, provider, model, apiBase] of cases) {
    const { calls, fetchImpl } = scriptedProxy((call) =>
      call.url.includes("/model/info") ? { status: 200, payload: infoPayload({ id: channelModelId(API_BASE, MODEL, protocol) }) } : { status: 200, payload: {} },
    );
    const alias = await registerChannelModel(channel({ protocol }), { env: ENV, fetchImpl });
    assert.equal(alias, channelModelAlias(API_BASE, MODEL, protocol));

    const post = calls.find((call) => call.method === "POST") ?? calls.find((call) => call.method === "PATCH");
    const params = post?.body?.litellm_params as Record<string, unknown>;
    const info = post?.body?.model_info as Record<string, unknown>;
    assert.equal(params.custom_llm_provider, provider, protocol);
    assert.equal(params.model, model, protocol);
    assert.equal(params.api_base, apiBase, protocol);
    assert.equal(info.mode, mode, protocol);
    assert.equal(info.max_input_tokens, 32768, protocol);
    assert.equal(info.max_output_tokens, 4096, protocol);
  }
});

test("a bare host base registers the full /v1/messages path for Anthropic Messages", async () => {
  let lookups = 0;
  const { calls, fetchImpl } = scriptedProxy((call) =>
    call.url.includes("/model/info")
      ? (lookups += 1) === 1
        ? notFound
        : { status: 200, payload: infoPayload({ id: channelModelId("http://gateway.example", MODEL, "messages") }) }
      : { status: 200, payload: {} },
  );
  const alias = await registerChannelModel(
    channel({ apiBase: "http://gateway.example", protocol: "messages" }),
    { env: ENV, fetchImpl },
  );
  assert.equal(alias, channelModelAlias("http://gateway.example", MODEL, "messages"));

  const params = calls.find((call) => call.method === "POST")?.body?.litellm_params as Record<string, unknown>;
  assert.equal(params.api_base, "http://gateway.example", "nothing to strip, nothing appended here");
  assert.equal(params.model, `anthropic/${MODEL}`);
});

test("an output budget above the context window is refused instead of registered", async () => {
  const { calls, fetchImpl } = scriptedProxy(() => ({ status: 200, payload: {} }));
  await assert.rejects(
    registerChannelModel(channel({ contextWindowTokens: 2048, maxOutputTokens: 4096 }), { env: ENV, fetchImpl }),
    /exceed its context window/,
  );
  assert.equal(calls.length, 0);
});

test("a keyless endpoint gets a placeholder, never the stack's own key", async () => {
  const { calls, fetchImpl } = scriptedProxy((call) => {
    if (call.url.includes("/model/info")) return calls.length === 1 ? notFound : { status: 200, payload: infoPayload() };
    return { status: 200, payload: {} };
  });

  await registerChannelModel(channel({ apiKey: "" }), { env: ENV, fetchImpl });
  const params = calls.find((call) => call.method === "POST")?.body?.litellm_params as Record<string, unknown>;
  assert.equal(params.api_key, CHANNEL_KEYLESS_PLACEHOLDER);
  assert.notEqual(params.api_key, ENV.LITELLM_MASTER_KEY);
  assert.equal(params.extra_headers, undefined, "no headers means no extra_headers key at all");
});

test("a re-registration PATCHes the deployment we own instead of duplicating the alias", async () => {
  const { calls, fetchImpl } = scriptedProxy((call) =>
    call.url.includes("/model/info") ? { status: 200, payload: infoPayload() } : { status: 200, payload: {} },
  );

  const alias = await registerChannelModel(channel({ apiKey: "sk-rotated" }), { env: ENV, fetchImpl });
  assert.equal(alias, ALIAS);
  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ["GET", "/v1/model/info"],
      ["PATCH", `/model/${ID}/update`],
      ["GET", "/v1/model/info"],
    ],
  );
  assert.equal((calls[1].body?.litellm_params as Record<string, unknown>).api_key, "sk-rotated");
  // The PATCH must carry the same metadata the POST would: a key rotation must not
  // drop the protocol mode or the token budget off the deployment.
  assert.deepEqual(calls[1].body?.model_info, {
    id: ID,
    decepticon_channel: true,
    mode: "chat",
    max_input_tokens: 32768,
    max_output_tokens: 4096,
  });
});

test("a config-owned name or a foreign DB row is never overwritten", async () => {
  const configOwned = scriptedProxy(() => ({ status: 200, payload: infoPayload({ dbModel: false }) }));
  await assert.rejects(
    registerChannelModel(channel(), { env: ENV, fetchImpl: configOwned.fetchImpl }),
    /cannot take that alias/,
  );
  assert.ok(!configOwned.calls.some((call) => call.method !== "GET"), "no write was attempted");

  const foreign = scriptedProxy(() => ({ status: 200, payload: infoPayload({ ours: false }) }));
  await assert.rejects(
    registerChannelModel(channel(), { env: ENV, fetchImpl: foreign.fetchImpl }),
    /refusing to overwrite/,
  );
  assert.ok(!foreign.calls.some((call) => call.method !== "GET"));
});

test("a deployment LiteLLM never exposes fails registration instead of a fake success", async () => {
  const { fetchImpl } = scriptedProxy((call) => (call.url.includes("/model/info") ? notFound : { status: 200, payload: {} }));
  await assert.rejects(
    registerChannelModel(channel(), { env: ENV, fetchImpl }),
    /did not expose it on the router/,
  );
});

test("registration errors are sanitized and never carry a credential or a header value", async () => {
  const upstream = scriptedProxy((call) => {
    if (call.url.includes("/model/info")) return notFound;
    return {
      status: 400,
      payload: {
        error: {
          message: `bad key sk-channel-key for master sk-master-secret-value with header sk-header-secret-value`,
        },
      },
    };
  });
  await assert.rejects(
    registerChannelModel(channel({ extraHeaders: HEADERS }), { env: ENV, fetchImpl: upstream.fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof ChannelModelRegistrationError);
      for (const secret of ["sk-channel-key", "sk-master-secret-value", "sk-header-secret-value"]) {
        assert.doesNotMatch(error.message, new RegExp(secret));
      }
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test("a proxy that cannot be reached reports the URL, not a silent failure", async () => {
  const unreachable = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
  }) as unknown as typeof fetch;
  await assert.rejects(
    registerChannelModel(channel(), { env: ENV, fetchImpl: unreachable }),
    /Could not reach the LiteLLM proxy at http:\/\/proxy:4000/,
  );
});

test("registration refuses to run without a server-side master key", async () => {
  await assert.rejects(
    registerChannelModel(channel(), { env: { DECEPTICON_LLM__PROXY_URL: "http://proxy:4000" } }),
    /master key is not configured/,
  );
});

test("removing a channel deployment deletes only our own DB row", async () => {
  const { calls, fetchImpl } = scriptedProxy((call) =>
    call.url.includes("/model/info") ? { status: 200, payload: infoPayload() } : { status: 200, payload: { message: "deleted" } },
  );
  assert.equal(await removeChannelModel(ALIAS, { env: ENV, fetchImpl }), true);
  assert.deepEqual(calls.at(-1)?.body, { id: ID });

  const alreadyGone = scriptedProxy(() => notFound);
  assert.equal(await removeChannelModel(ID, { env: ENV, fetchImpl: alreadyGone.fetchImpl }), false);

  const foreign = scriptedProxy(() => ({ status: 200, payload: infoPayload({ ours: false }) }));
  assert.equal(await removeChannelModel(ALIAS, { env: ENV, fetchImpl: foreign.fetchImpl }), false);
  assert.ok(!foreign.calls.some((call) => call.method === "POST"));

  const unrelated = scriptedProxy(() => ({ status: 200, payload: infoPayload() }));
  await assert.rejects(
    removeChannelModel("anthropic/claude-opus-5-5", { env: ENV, fetchImpl: unrelated.fetchImpl }),
    /Not a Decepticon channel alias/,
  );
  assert.equal(unrelated.calls.length, 0, "a non-channel name never reaches the proxy");
});
