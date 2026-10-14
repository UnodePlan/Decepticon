/**
 * Upstream channel calls — the only module that talks to an operator-supplied
 * LLM endpoint on the Web server's behalf.
 *
 * Two hard rules, both enforced here rather than at the route:
 *   1. The channel credential (and any channel header value) is attached
 *      server-side and never leaves the process: no error, log or response body
 *      may echo the key, a header value or an upstream response body.
 *   2. A user-supplied base URL is untrusted input. Credentials in the URL,
 *      redirects and unbounded reads are refused, and a response is accepted
 *      only when it has the shape the protocol promises.
 *
 * `fetch` is injectable so the route tests never need a live endpoint.
 */

import {
  CHANNEL_PROTOCOL_REGISTRATION,
  LLM_CHANNEL_LIMITS,
  channelModelsUrl,
  type ChannelProtocol,
} from "./llm-channel";
import { channelUpstreamBase, channelUpstreamPath } from "./llm-channel-proxy";

/** 5s: long enough for a self-hosted endpoint, short enough for an interactive card. */
const CHANNEL_TIMEOUT_MS = 5000;
/**
 * The probe only has to prove the endpoint answers this model: an eight-token
 * completion is a real request that costs (almost) nothing and still exercises
 * auth, routing and the protocol's request shape.
 */
const PROBE_MAX_TOKENS = 8;
/** Anthropic requires the API version header on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

export interface DiscoverModelsInput {
  /** Normalized base (see `normalizeChannelBase`). */
  apiBase: string;
  /** "" for a keyless endpoint; the caller resolves reuse rules beforehand. */
  apiKey: string;
  protocol: ChannelProtocol;
  /** Plain headers the endpoint needs for its listing; values stay server-side. */
  extraHeaders?: Record<string, string>;
}

export interface TestModelInput extends DiscoverModelsInput {
  /** Upstream model id exactly as the endpoint advertises it. */
  model: string;
  /** Declared per-response ceiling; the probe still caps itself below this. */
  maxOutputTokens?: number;
  /** Validated channel headers, attached to the probe like any other request. */
  extraHeaders?: Record<string, string>;
}

export class ChannelDiscoveryError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ChannelDiscoveryError";
    this.status = status;
  }
}

/**
 * List the model ids an endpoint advertises, or `null` when the protocol has no
 * standard listing (the operator types the model id instead).
 *
 * `redirect: "manual"` matters: a redirect is how an untrusted endpoint could
 * bounce a request — and its Authorization header — to a different origin, and
 * `fetch` on Node would follow it silently.
 */
export async function discoverChannelModels(
  input: DiscoverModelsInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  const url = channelModelsUrl(input.apiBase, input.protocol);
  if (url === null) return null;

  const response = await request(url, input.apiKey, input.protocol, fetchImpl, input.extraHeaders);

  const text = await response.text();
  if (text.length > LLM_CHANNEL_LIMITS.modelListBytes) {
    throw new ChannelDiscoveryError("Endpoint listed too many models", 502);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ChannelDiscoveryError("Endpoint did not return JSON", 502);
  }

  const models = listedModels(payload);
  if (models === null) {
    throw new ChannelDiscoveryError("Endpoint did not return an OpenAI-compatible model list", 502);
  }
  return models;
}

/**
 * One minimal request against the endpoint, the way the proxy will call it.
 *
 * Purpose: let the operator prove an unsaved draft (base + key + protocol +
 * model) actually works before it is registered, so a typo is caught in the card
 * rather than at the first agent call. The reply is inspected for success only —
 * no upstream body, header or status text ever leaves this module.
 */
export async function testChannelModel(
  input: TestModelInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string; status: number }> {
  const maxTokens = Math.min(input.maxOutputTokens ?? PROBE_MAX_TOKENS, PROBE_MAX_TOKENS);
  const url = `${channelUpstreamBase(input.apiBase, input.protocol)}${channelUpstreamPath(input.protocol)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders(input.apiKey, input.protocol),
        ...(input.extraHeaders ?? {}),
      },
      body: JSON.stringify(probeBody(input.model, input.protocol, maxTokens)),
      redirect: "manual",
      signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { ok: false, detail: "Could not reach the endpoint", status: 502 };
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      detail: "Endpoint redirected the request; use the final URL directly",
      status: 502,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: "The endpoint rejected the API key", status: 401 };
  }
  if (response.status === 404) {
    return {
      ok: false,
      detail: `The endpoint has no ${CHANNEL_PROTOCOL_REGISTRATION[input.protocol].appendPath} route for this protocol`,
      status: 404,
    };
  }
  if (response.status === 429) {
    return { ok: false, detail: "The endpoint rate-limited the test request", status: 502 };
  }
  if (!response.ok) {
    return { ok: false, detail: `Endpoint returned HTTP ${response.status}`, status: 502 };
  }

  const text = await response.text();
  try {
    JSON.parse(text);
  } catch {
    return { ok: false, detail: "Endpoint did not return JSON", status: 502 };
  }
  return { ok: true, detail: "The endpoint answered the test request" };
}

/** Per-protocol credential header; Anthropic-compatible endpoints authenticate with `x-api-key`. */
function authHeaders(apiKey: string, protocol: ChannelProtocol): Record<string, string> {
  if (!apiKey) return {};
  return protocol === "messages"
    ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${apiKey}` };
}

/** The smallest request each protocol accepts. */
function probeBody(model: string, protocol: ChannelProtocol, maxTokens: number): Record<string, unknown> {
  const prompt = [{ role: "user", content: "ping" }];
  switch (protocol) {
    case "messages":
      return { model, max_tokens: maxTokens, messages: prompt };
    case "responses":
      return { model, input: "ping", max_output_tokens: maxTokens };
    default:
      return { model, max_tokens: maxTokens, messages: prompt, stream: false };
  }
}

/** One discovery request against the endpoint, with every failure collapsed to a safe error. */
async function request(
  url: string,
  apiKey: string,
  protocol: ChannelProtocol,
  fetchImpl: typeof fetch,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        // No key = keyless endpoint; sending a placeholder bearer is worse than none.
        ...authHeaders(apiKey, protocol),
        ...(extraHeaders ?? {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // Covers DNS, TLS, connection refused and the timeout abort — never their text,
    // which can embed the URL (and therefore any credentials the user pasted).
    throw new ChannelDiscoveryError("Could not reach the endpoint", 502);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ChannelDiscoveryError("Endpoint redirected the request; use the final URL directly", 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ChannelDiscoveryError("The endpoint rejected the API key", 502);
  }
  if (!response.ok) {
    throw new ChannelDiscoveryError(`Endpoint returned HTTP ${response.status}`, 502);
  }
  return response;
}

/** Model ids from an OpenAI-compatible `/models` payload, or `null` when the shape is wrong. */
export function listedModels(payload: unknown): string[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;

  const models: string[] = [];
  for (const entry of data) {
    if (models.length >= LLM_CHANNEL_LIMITS.modelsMaxCount) break;
    const id = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).id : undefined;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || trimmed.length > LLM_CHANNEL_LIMITS.modelLength || models.includes(trimmed)) continue;
    models.push(trimmed);
  }
  return models;
}
