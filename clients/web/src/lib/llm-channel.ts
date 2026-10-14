/**
 * Custom LLM channel contract — PURE, like `./system-settings`.
 *
 * One operator-supplied endpoint ("channel"): a base URL, an optional API key,
 * the request protocol the endpoint speaks, its context/output token budget and
 * any plain headers it needs, plus the upstream model the operator picked from
 * that endpoint's `/models` listing. The saved model is registered with LiteLLM
 * under a Decepticon-owned alias (`./llm-channel-proxy`, server-only) and the
 * alias — never the raw upstream id — is written to the global model override so
 * the existing terminal → CLI → LangGraph run chain consumes it unchanged.
 *
 * No `next/*`, Prisma or node builtins here: the settings card mirrors these
 * rules in the browser, so anything Node-only would leak into the client bundle.
 *
 * Storage keys (same `SystemSetting` KV table as the rest of the settings):
 *   llm_channel_api_base / api_key / model / alias / protocol /
 *   context_window_tokens / max_output_tokens / extra_headers
 *
 * The global override itself stays in `llm_channel_alias`'s sibling
 * `global_model_override` row so a channel clear can tell "this override is the
 * channel's alias" from "the operator typed a model by hand".
 *
 * Everything secret lives outside this contract: the API key is write-only
 * (`apiKeySet`), and header values never leave the server — the snapshot only
 * reports which header NAMES are set (`extraHeadersSet`).
 */

import { validateExtraHeaders } from "./system-settings";

/** Channel storage keys, added alongside the `SETTING_KEYS` from the settings contract. */
export const LLM_CHANNEL_KEYS = {
  apiBase: "llm_channel_api_base",
  apiKey: "llm_channel_api_key",
  model: "llm_channel_model",
  /** Alias of the last successful registration; the value written to the global override. */
  alias: "llm_channel_alias",
  protocol: "llm_channel_protocol",
  contextWindowTokens: "llm_channel_context_window_tokens",
  maxOutputTokens: "llm_channel_max_output_tokens",
  /** JSON object; values are the operator's own endpoint credentials and are never echoed back. */
  extraHeaders: "llm_channel_extra_headers",
} as const;

export const LLM_CHANNEL_LIMITS = {
  apiBaseLength: 2048,
  apiKeyLength: 512,
  modelLength: 200,
  /** Upstream `/v1/models` payloads grow with the endpoint; these cap what we hold. */
  modelsMaxCount: 500,
  modelListBytes: 1_000_000,
  /** Prompt budget the endpoint is registered with. 2M covers the largest advertised windows. */
  contextWindowTokens: { min: 1024, max: 2_000_000 },
  /** Per-response output budget; also the ceiling LiteLLM sends as `max_tokens`. */
  maxOutputTokens: { min: 256, max: 128_000 },
} as const;

/** Fallbacks for channel rows written before these fields existed. */
export const CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS = 64_000;
export const CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

// ── Protocols ────────────────────────────────────────────────────────

export const CHANNEL_PROTOCOLS = ["chat_completions", "responses", "messages"] as const;
export type ChannelProtocol = (typeof CHANNEL_PROTOCOLS)[number];
export const DEFAULT_CHANNEL_PROTOCOL: ChannelProtocol = "chat_completions";

/**
 * How each protocol is registered with LiteLLM, verified against the proxy image
 * the stack ships (v1.88.1). Per protocol:
 *
 * - `mode`: the `model_info.mode` the deployment is exposed under.
 * - `provider`: the `litellm_params.custom_llm_provider`, which selects the
 *   request translator (OpenAI-shaped vs. Anthropic Messages).
 * - `modelPrefix`: the literal prefix `litellm_params.model` MUST carry. LiteLLM
 *   strips it again before the upstream request, so the endpoint still receives
 *   the model id it advertises — but the prefix is what picks the route:
 *   `openai/responses/<model>` is the only form that makes the OpenAI provider
 *   POST `/responses` (a bare `openai/<model>` POSTs `/chat/completions` even with
 *   `mode: "responses"`), and `anthropic/<model>` is what keeps the native
 *   Messages handler instead of the OpenAI-to-Anthropic translation.
 * - `appendPath`: the path LiteLLM's own URL builder appends to `api_base`.
 * - `stripPaths`: suffixes an operator's base may carry that would double that
 *   path, longest first. `…/v1` is the OpenAI convention and LiteLLM appends the
 *   FULL `/v1/messages` for `anthropic`, so a pasted `…/v1` has to go or the
 *   request lands on `…/v1/v1/messages`.
 * - `modelList`: whether the endpoint answers a standard `GET /models` listing.
 */
export const CHANNEL_PROTOCOL_REGISTRATION: Record<
  ChannelProtocol,
  {
    mode: string;
    provider: string;
    modelPrefix: string;
    appendPath: string;
    stripPaths: readonly string[];
    modelList: boolean;
  }
> = {
  chat_completions: {
    mode: "chat",
    provider: "openai",
    modelPrefix: "openai",
    appendPath: "/chat/completions",
    stripPaths: ["/chat/completions"],
    modelList: true,
  },
  responses: {
    mode: "responses",
    provider: "openai",
    modelPrefix: "openai/responses",
    appendPath: "/responses",
    stripPaths: ["/responses"],
    modelList: true,
  },
  messages: {
    mode: "anthropic_messages",
    provider: "anthropic",
    modelPrefix: "anthropic",
    appendPath: "/v1/messages",
    stripPaths: ["/v1/messages", "/v1"],
    modelList: false,
  },
};

/** Fallback discovery path for protocols whose endpoint has no standard listing. */
export const CHANNEL_MODELS_DISCOVERY_PATH = "/models";

// ── Protocol validation ──────────────────────────────────────────────

/**
 * Every protocol in this contract is registered; none is gated behind a
 * proxy-side flag, so {@link CHANNEL_PROTOCOLS} is the full option list.
 *
 * Older builds hid `messages` unless
 * `LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES=true`, assuming the
 * proxy translated the Messages API through `/v1/chat/completions`. That is not
 * what v1.88.1 does: a deployment registered as `anthropic/<model>` with
 * `mode: "anthropic_messages"` is POSTed to the endpoint's native `/v1/messages`
 * path whether or not the flag is set (the flag only changes how the proxy's own
 * `/v1/messages` route treats an OpenAI *upstream*). Gating the option behind it
 * hid a working protocol from every default install, and no flag is set in
 * `docker-compose.yml` to reveal it.
 *
 * An unknown protocol is still a 400 naming the field — the request is never
 * silently downgraded to a different route.
 */

/** Does the endpoint expose a standard model list for this protocol? */
export function protocolSupportsModelList(protocol: ChannelProtocol): boolean {
  return CHANNEL_PROTOCOL_REGISTRATION[protocol].modelList;
}

/** Narrow an unknown value to a known protocol, or null. */
export function asChannelProtocol(value: unknown): ChannelProtocol | null {
  return typeof value === "string" && (CHANNEL_PROTOCOLS as readonly string[]).includes(value)
    ? (value as ChannelProtocol)
    : null;
}

/** Public channel state. Neither the key nor header values are part of it. */
export interface LlmChannelSnapshot {
  /** "" when the channel is not configured. */
  apiBase: string;
  apiKeySet: boolean;
  /** Upstream model id as chosen by the operator, "" when unset. */
  model: string;
  protocol: ChannelProtocol;
  /** Protocols the running proxy serves; the card offers only these. */
  protocols: ChannelProtocol[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Header names only, sorted; the values stay on the server. */
  extraHeadersSet: string[];
}

/** PUT response: the snapshot plus the effective global override after the write. */
export interface LlmChannelSaved extends LlmChannelSnapshot {
  /**
   * Read-after-write value of `global_model_override`: the new alias after a
   * successful save, the surviving unrelated override after a partial clear, or
   * "" when nothing is configured. Clients resync their global-model field from it.
   */
  globalModelOverride: string;
}

/** Field-keyed rejection body, mirroring the settings API's 400 contract. */
export interface ChannelRejection {
  ok: false;
  error: string;
  fields?: Record<string, string>;
}

export type ApiBaseResult = { ok: true; apiBase: string } | ChannelRejection;

/** Field names a rejection can carry; the card renders one message per field. */
export const CHANNEL_FIELDS = [
  "apiBase",
  "apiKey",
  "model",
  "protocol",
  "contextWindowTokens",
  "maxOutputTokens",
  "extraHeaders",
] as const;
export type ChannelField = (typeof CHANNEL_FIELDS)[number];

const BASE_ERROR = "must be an http(s) URL without credentials, query or fragment";

// ── Base URL ─────────────────────────────────────────────────────────

/**
 * Normalize an operator-entered base URL, or explain why it is unusable.
 *
 * Accepted: `http(s)://host[:port][/path]` — self-hosted endpoints on private
 * networks are the normal case, so no host allow-list. Rejected: credentials in
 * the URL (they would end up in a stored setting and in logs), query/fragment,
 * oversized values and anything that is not a URL.
 *
 * The trailing slash is dropped so the protocol path appends predictably;
 * `settingsProxyUrl` normalizes the same way. The path (`/v1` or a custom
 * prefix) is PRESERVED — a `/models` suffix the operator pasted is trimmed
 * because the card and the proxy both append it.
 */
export function normalizeChannelBase(input: unknown): ApiBaseResult {
  if (typeof input !== "string") {
    return { ok: false, error: "Invalid channel", fields: { apiBase: BASE_ERROR } };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "Invalid channel", fields: { apiBase: "apiBase is required" } };
  }
  if (raw.length > LLM_CHANNEL_LIMITS.apiBaseLength) {
    return {
      ok: false,
      error: "Invalid channel",
      fields: { apiBase: `must be at most ${LLM_CHANNEL_LIMITS.apiBaseLength} characters` },
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid channel", fields: { apiBase: BASE_ERROR } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Invalid channel", fields: { apiBase: "must use http or https" } };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: "Invalid channel",
      fields: { apiBase: "must not embed credentials — use the API key field" },
    };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Invalid channel", fields: { apiBase: "must not contain ?query or #fragment" } };
  }
  if (!url.hostname) {
    return { ok: false, error: "Invalid channel", fields: { apiBase: "must include a host" } };
  }

  const path = stripModelsSuffix(url.pathname);
  return { ok: true, apiBase: `${url.origin}${path}` };
}

/** Drop trailing slashes and a `/models` tail, keeping custom prefixes intact. */
function stripModelsSuffix(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed.toLowerCase().endsWith("/models") ? trimmed.slice(0, -"/models".length).replace(/\/+$/, "") : trimmed;
}

/**
 * `<apiBase><discovery path>` — the model list URL for an already-normalized base.
 * `null` when the protocol has no standard listing (the operator types the id).
 */
export function channelModelsUrl(apiBase: string, protocol: ChannelProtocol): string | null {
  return protocolSupportsModelList(protocol) ? `${apiBase}${CHANNEL_MODELS_DISCOVERY_PATH}` : null;
}

// ── Field values ─────────────────────────────────────────────────────

type IntFieldResult = { ok: true; value: number } | { ok: false; message: string };

/** Integer inside an inclusive range; anything else names the field. */
function readRange(
  input: unknown,
  bounds: { min: number; max: number },
): IntFieldResult {
  if (typeof input !== "number" || !Number.isInteger(input) || input < bounds.min || input > bounds.max) {
    return { ok: false, message: `must be an integer between ${bounds.min} and ${bounds.max}` };
  }
  return { ok: true, value: input };
}

/** `maxOutputTokens` above the context window can never be produced; refuse the pair. */
export const CHANNEL_TOKENS_RELATION_ERROR = "maxOutputTokens must not exceed contextWindowTokens";

// ── Request bodies ───────────────────────────────────────────────────

export interface ChannelDiscoverBody {
  apiBase: string;
  /** Present = use this key; absent = reuse the stored one (same base only). */
  apiKey?: string;
  /** True when the caller wants no credential at all (keyless/self-hosted). */
  keyless: boolean;
  protocol: ChannelProtocol;
  /**
   * Plain headers the endpoint needs for its listing too. Validated like every
   * other header map; a blank value means "reuse the stored one" (same base only).
   */
  extraHeaders?: Record<string, string>;
}

export type ChannelDiscoverResult = { ok: true; body: ChannelDiscoverBody } | ChannelRejection;

/**
 * POST /api/settings/llm-channel/models body: a base, a protocol, plus an
 * optional key. The protocol is required here — discovery runs BEFORE saving, so
 * there is no stored value to fall back to, and the card always knows which
 * protocol the operator picked.
 */
export function readDiscoverBody(input: unknown): ChannelDiscoverResult {
  const body = asRecord(input);
  if (!body) return rejection("Request body must be a JSON object");
  if (!Object.hasOwn(body, "apiBase")) return rejection("apiBase is required", { apiBase: "apiBase is required" });

  const base = normalizeChannelBase(body.apiBase);
  if (!base.ok) return base;

  const protocol = asChannelProtocol(body.protocol);
  if (!protocol) {
    return rejection("Invalid channel", {
      protocol: `must be one of ${CHANNEL_PROTOCOLS.join(", ")}`,
    });
  }
  if (!protocolSupportsModelList(protocol)) {
    return rejection("Invalid channel", { protocol: "this protocol has no model list — enter the model id" });
  }

  const key = readOptionalKey(body);
  if (!key.ok) return rejection("Invalid channel", { apiKey: key.message });

  const discover: ChannelDiscoverBody = {
    apiBase: base.apiBase,
    ...(key.key !== undefined ? { apiKey: key.key } : {}),
    keyless: key.key === "",
    protocol,
  };
  if (body.extraHeaders !== undefined) {
    const headers = validateExtraHeaders(body.extraHeaders);
    if (typeof headers === "string") return rejection("Invalid channel", { extraHeaders: headers });
    discover.extraHeaders = headers;
  }
  return { ok: true, body: discover };
}

export interface ChannelSaveBody {
  /** Present = the operator changed the channel; absent = keep the stored base (a clear keeps it too). */
  apiBase?: string;
  apiKey?: string;
  /** "" clears the channel (and the alias override, when it still points at it). */
  model: string;
  /** True when the request sent an empty key — a keyless endpoint, no stored key. */
  keyless: boolean;
  /** Absent = keep the stored protocol (or `chat_completions` for a pre-protocol row). */
  protocol?: ChannelProtocol;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  /** Absent = keep the stored headers; `{}` clears them. */
  extraHeaders?: Record<string, string>;
}

export type ChannelSaveResult = { ok: true; body: ChannelSaveBody } | ChannelRejection;

/**
 * PUT /api/settings/llm-channel body.
 *
 * `model: ""` is the clear operation, which is why `apiBase` may also be absent
 * there. Any other request must arrive with a model, and the handler resolves the
 * base from the body or the stored row. Protocol/token/header fields are optional
 * so a client that predates them keeps the stored values instead of resetting the
 * channel to defaults, but anything that IS sent is validated here.
 */
export function readSaveBody(input: unknown): ChannelSaveResult {
  const body = asRecord(input);
  if (!body) return rejection("Request body must be a JSON object");
  if (!Object.hasOwn(body, "model")) return rejection("model is required", { model: "model is required" });

  const rawModel = typeof body.model === "string" ? body.model : null;
  if (rawModel === null) {
    return rejection("Invalid channel", { model: "model must be a string" });
  }
  // Only an exactly-empty model clears the channel: a whitespace typo must not be
  // read as a destructive clear.
  const model = rawModel.trim();
  if (rawModel !== "" && model === "") {
    return rejection("Invalid channel", { model: "must be a model id, or \"\" to clear the channel" });
  }
  if (model.length > LLM_CHANNEL_LIMITS.modelLength) {
    return rejection("Invalid channel", {
      model: `must be at most ${LLM_CHANNEL_LIMITS.modelLength} characters`,
    });
  }
  if (/\s/.test(model)) return rejection("Invalid channel", { model: "must be a single model id" });

  let apiBase: string | undefined;
  if (body.apiBase !== undefined) {
    // `""` is what a client sends alongside a clear, where there is no base left to
    // keep; on a save the check below still rejects it as missing.
    const blank = typeof body.apiBase === "string" && body.apiBase.trim() === "";
    if (!blank) {
      const base = normalizeChannelBase(body.apiBase);
      if (!base.ok) return base;
      apiBase = base.apiBase;
    }
  }
  if (!apiBase && model !== "") {
    // Saving a model needs somewhere to fetch it from; a clear does not.
    return rejection("Invalid channel", { apiBase: "apiBase is required" });
  }

  const key = readOptionalKey(body);
  if (!key.ok) return rejection("Invalid channel", { apiKey: key.message });

  const save: ChannelSaveBody = {
    ...(apiBase ? { apiBase } : {}),
    ...(key.key !== undefined ? { apiKey: key.key } : {}),
    model,
    keyless: key.key === "",
  };
  if (model === "") return { ok: true, body: save };

  // A clear carries none of the configuration fields; a save validates whatever
  // it was given and lets the handler fill the rest from the stored row.
  if (body.protocol !== undefined) {
    const protocol = asChannelProtocol(body.protocol);
    if (!protocol) {
      return rejection("Invalid channel", { protocol: `must be one of ${CHANNEL_PROTOCOLS.join(", ")}` });
    }
    save.protocol = protocol;
  }
  if (body.contextWindowTokens !== undefined) {
    const context = readRange(body.contextWindowTokens, LLM_CHANNEL_LIMITS.contextWindowTokens);
    if (!context.ok) return rejection("Invalid channel", { contextWindowTokens: context.message });
    save.contextWindowTokens = context.value;
  }
  if (body.maxOutputTokens !== undefined) {
    const output = readRange(body.maxOutputTokens, LLM_CHANNEL_LIMITS.maxOutputTokens);
    if (!output.ok) return rejection("Invalid channel", { maxOutputTokens: output.message });
    save.maxOutputTokens = output.value;
  }
  if (save.contextWindowTokens !== undefined && save.maxOutputTokens !== undefined) {
    if (save.maxOutputTokens > save.contextWindowTokens) {
      return rejection("Invalid channel", { maxOutputTokens: CHANNEL_TOKENS_RELATION_ERROR });
    }
  }
  if (body.extraHeaders !== undefined) {
    // Same rules as the global extra headers (`./system-settings` owns them):
    // plain lower-case names, no credential-bearing names, no CR/LF, bounded count
    // and length. One validator serves both, so a stored row and a live edit can
    // never disagree about what is acceptable.
    const headers = validateExtraHeaders(body.extraHeaders);
    if (typeof headers === "string") return rejection("Invalid channel", { extraHeaders: headers });
    save.extraHeaders = headers;
  }

  return { ok: true, body: save };
}

export interface ChannelTestBody {
  apiBase: string;
  apiKey?: string;
  keyless: boolean;
  protocol: ChannelProtocol;
  model: string;
  /** Upper bound for the probe request; the probe itself caps far lower. */
  maxOutputTokens?: number;
  /**
   * The draft's header rows, so the probe sends exactly what a save would
   * register. Values stay server-side: they are attached to the upstream request
   * and never echoed in the response.
   */
  extraHeaders?: Record<string, string>;
}

export type ChannelTestResult = { ok: true; body: ChannelTestBody } | ChannelRejection;

/**
 * POST /api/settings/llm-channel/test body: the *unsaved* draft, so an operator
 * can prove an endpoint/model/protocol combination works before committing it.
 * Same field rules as a save, minus the destructive clear.
 */
export function readTestBody(input: unknown): ChannelTestResult {
  const body = asRecord(input);
  if (!body) return rejection("Request body must be a JSON object");

  const parsed = readSaveBody({ ...body, apiBase: body.apiBase });
  if (!parsed.ok) return parsed;
  const save = parsed.body;
  if (save.model === "") {
    return rejection("Invalid channel", { model: "a model id is required to test the endpoint" });
  }
  if (!save.apiBase) return rejection("Invalid channel", { apiBase: "apiBase is required" });

  const protocol = save.protocol ?? DEFAULT_CHANNEL_PROTOCOL;
  return {
    ok: true,
    body: {
      apiBase: save.apiBase,
      ...(save.apiKey !== undefined ? { apiKey: save.apiKey } : {}),
      keyless: save.keyless,
      protocol,
      model: save.model,
      ...(save.maxOutputTokens !== undefined ? { maxOutputTokens: save.maxOutputTokens } : {}),
      // Already validated by `readSaveBody`: the probe sends the operator's own
      // plain headers so it exercises the endpoint the way the proxy will.
      ...(save.extraHeaders !== undefined ? { extraHeaders: save.extraHeaders } : {}),
    },
  };
}

/**
 * Optional `apiKey`: `{ key }` when the body carried one (possibly empty, which
 * means keyless), `{}` when it was absent — absent is what allows the stored key
 * to be reused, so the distinction has to survive parsing. A discriminated result
 * rather than an error-prefixed string: an operator's key may legitimately start
 * with any word.
 */
type OptionalKey = { ok: true; key?: string } | { ok: false; message: string };

function readOptionalKey(body: Record<string, unknown>): OptionalKey {
  if (!Object.hasOwn(body, "apiKey")) return { ok: true };
  const value = body.apiKey;
  if (typeof value !== "string") return { ok: false, message: "must be a string" };
  const key = value.trim();
  if (key.length > LLM_CHANNEL_LIMITS.apiKeyLength) {
    return { ok: false, message: `must be at most ${LLM_CHANNEL_LIMITS.apiKeyLength} characters` };
  }
  return /\s/.test(key) ? { ok: false, message: "must not contain whitespace" } : { ok: true, key };
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function rejection(error: string, fields?: Record<string, string>): ChannelRejection {
  return { ok: false, error, fields };
}

// ── Response guard ───────────────────────────────────────────────────

/**
 * Guard a browser-parsed `/api/settings/llm-channel` payload before it becomes
 * form state: a malformed response is a page error, not a render crash.
 *
 * Absent protocol/token/header fields fall back to the same defaults the server
 * uses for a stored row written before they existed (a channel configured by an
 * older build reads back as a chat-completions channel), while a PRESENT field of
 * the wrong type is a malformed response.
 */
export function parseChannelSnapshot(payload: unknown): LlmChannelSnapshot | null {
  const body = asRecord(payload);
  if (!body) return null;
  const { apiBase, model } = body;
  if (typeof apiBase !== "string" || typeof model !== "string") return null;
  if (typeof body.apiKeySet !== "boolean") return null;

  const protocol = body.protocol === undefined ? DEFAULT_CHANNEL_PROTOCOL : asChannelProtocol(body.protocol);
  if (!protocol) return null;

  const protocols = body.protocols === undefined
    ? [...CHANNEL_PROTOCOLS]
    : readProtocolList(body.protocols);
  if (protocols === null) return null;

  const context = readRangeOr(body.contextWindowTokens, LLM_CHANNEL_LIMITS.contextWindowTokens, CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS);
  const output = readRangeOr(body.maxOutputTokens, LLM_CHANNEL_LIMITS.maxOutputTokens, CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS);
  if (context === null || output === null) return null;

  const headers = readHeaderNameList(body.extraHeadersSet);
  if (headers === null) return null;

  return {
    apiBase,
    model,
    apiKeySet: body.apiKeySet,
    protocol,
    protocols,
    contextWindowTokens: context,
    maxOutputTokens: output,
    extraHeadersSet: headers,
  };
}

/** Accepts a valid in-range integer, the documented default when absent, or null (malformed). */
function readRangeOr(input: unknown, bounds: { min: number; max: number }, fallback: number): number | null {
  if (input === undefined) return fallback;
  const result = readRange(input, bounds);
  return result.ok ? result.value : null;
}

/** Known protocols only; an absent `protocols` means the full contract list. */
function readProtocolList(input: unknown): ChannelProtocol[] | null {
  if (!Array.isArray(input)) return null;
  const protocols = input.map(asChannelProtocol);
  if (protocols.some((protocol) => protocol === null)) return null;
  return protocols as ChannelProtocol[];
}

/** Sorted string list; absent = no headers, anything else malformed. */
function readHeaderNameList(input: unknown): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((name) => typeof name !== "string")) return null;
  return [...(input as string[])].sort();
}
