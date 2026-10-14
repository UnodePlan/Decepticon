/**
 * REAL LiteLLM registration for the operator's custom LLM channel.
 *
 * SERVER-ONLY: this module holds the LiteLLM master key and the operator's
 * upstream credential, and imports `node:crypto`. Nothing here may be reached
 * from a client component.
 *
 * What it does
 * ------------
 * LiteLLM is the single gateway every agent already talks to
 * (`LLMFactory._create_chat_model`, base URL `DECEPTICON_LLM__PROXY_URL`). An
 * operator-supplied endpoint therefore becomes usable by registering it as a
 * *deployment* on that proxy: the channel's model id gets a Decepticon-owned
 * alias, and the alias is what the settings store writes into
 * `global_model_override` — the value the terminal hands to the CLI, the CLI
 * into the LangGraph run input, and `ModelOverrideMiddleware` into the factory.
 *
 * Registration is real, not simulated: it POSTs `/model/new`, verifies the
 * deployment is queryable (`/v1/model/info`) and only then resolves. The
 * deployment is persisted in LiteLLM's own Postgres table, which is why
 * `config/litellm.yaml` enables `general_settings.store_model_in_db` — that flag
 * is what makes `/model/new` work at all AND what reloads DB deployments after a
 * proxy restart, so a saved channel survives `docker compose restart litellm`.
 *
 * Protocol
 * --------
 * The deployment carries the `model_info.mode` of the protocol the operator
 * chose (`chat` / `responses` / `anthropic_messages`), the matching
 * `litellm_params.custom_llm_provider` AND that protocol's required model prefix
 * (`openai/<model>`, `openai/responses/<model>`, `anthropic/<model>`), and the
 * endpoint's URL is assembled from the same table `./llm-channel` validates
 * against — so what the card promises (path, prefix, mode, provider) is what the
 * proxy is told. The protocol is a validated `ChannelProtocol` before it gets
 * here, and each one maps to exactly one route: an unknown value is a 400 at the
 * API, never a silent swap to another protocol.
 *
 * Alias stability
 * ---------------
 * alias = `openai/decepticon-custom-<hash>` and id = `decepticon-custom-<hash>`,
 * where the hash is derived from (normalized apiBase, protocol, upstream model)
 * ONLY — not from the API key, the token budget or the extra headers. The
 * consequences are deliberate:
 *
 *   - Rotating the channel key, raising the output budget or changing a header
 *     re-registers the SAME alias, so we PATCH the existing deployment in place.
 *     LiteLLM never ends up with two deployments of one alias load-balanced
 *     between them, which would leak the old key to half the requests.
 *   - Switching protocol yields a different alias: the request shape changes, so
 *     the previous registration (a different endpoint contract) must not be
 *     reused, and the old alias is pruned by the caller.
 *
 * Secrets
 * -------
 *   - The master key is read from the Web server's environment only
 *     (`LITELLM_MASTER_KEY` → `LITELLM_API_KEY` → `DECEPTICON_LLM__PROXY_API_KEY`)
 *     and is never returned, logged or persisted by this module.
 *   - Error messages are built from a fixed wording plus LiteLLM's own detail run
 *     through {@link redactSecrets}, so neither the master key, the channel key nor
 *     a channel header value can surface in a response body.
 *   - The channel key and headers travel in the LiteLLM deployment params
 *     (LiteLLM encrypts them in its own DB) and nowhere else: this module never
 *     contacts the operator's endpoint.
 */

import { createHash } from "node:crypto";
import { settingsProxyUrl } from "./system-settings-runtime";
import { CHANNEL_PROTOCOL_REGISTRATION, type ChannelProtocol } from "./llm-channel";
import type { SettingsEnv } from "./system-settings";

// ── Public constants ─────────────────────────────────────────────────

/** Model-name alias the agents ask the proxy for; `openai/` makes the provider explicit. */
export const CHANNEL_ALIAS_PREFIX = "openai/decepticon-custom-";
/** Slash-free deployment id, used as LiteLLM's `model_id` and its PATCH/DELETE path key. */
export const CHANNEL_ID_PREFIX = "decepticon-custom-";
/** `model_info` marker that proves a deployment is ours before we update or delete it. */
export const CHANNEL_MARKER_FIELD = "decepticon_channel";
/** Hex chars of the (apiBase, protocol, model) digest. 12 hex = 48 bits: unique in practice. */
export const CHANNEL_HASH_LENGTH = 12;
/**
 * Explicit placeholder for a keyless endpoint. NOT a credential: it exists so
 * LiteLLM cannot fall back to the operator's real `OPENAI_API_KEY` (loaded into
 * the proxy from `.env`) and ship it to a self-hosted host the operator chose.
 */
export const CHANNEL_KEYLESS_PLACEHOLDER = "sk-decepticon-keyless";

/** Management calls are interactive (a settings card awaits them): fail fast. */
const PROXY_TIMEOUT_MS = 5000;
/** `add_deployment` runs inside the POST response, so one retry is already generous. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 150;
/** Cap on upstream detail echoed into an error message. */
const DETAIL_MAX_LENGTH = 300;

/** Registration failed. `message` is already sanitized; safe to log or return. */
export class ChannelModelRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelModelRegistrationError";
  }
}

export interface ChannelModelInput {
  /** Normalized channel base (`normalizeChannelBase`); preserved verbatim apart from trailing slashes. */
  apiBase: string;
  /** "" for a keyless endpoint. */
  apiKey: string;
  /** The upstream model id exactly as the endpoint advertises it. */
  model: string;
  /** Request protocol the endpoint speaks; decides mode, provider and path. */
  protocol: ChannelProtocol;
  /** Declared prompt budget, published as `model_info.max_input_tokens`. */
  contextWindowTokens: number;
  /** Declared per-response ceiling: `model_info.max_output_tokens` AND `litellm_params.max_tokens`. */
  maxOutputTokens: number;
  /** Plain headers the endpoint needs; values stay on the server. */
  extraHeaders?: Record<string, string>;
}

export interface ChannelProxyDeps {
  env?: SettingsEnv;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ── Pure helpers (unit-tested directly) ──────────────────────────────

/**
 * Digest of the (base, protocol, model) triple; the whole alias/id identity
 * derives from it. The protocol is part of the identity because it changes the
 * request the proxy sends (a different route and provider), so the same model id
 * reached over two protocols is two deployments.
 *
 * The base is hashed in the form the registration actually uses
 * (`channelUpstreamBase`), NOT the raw operator entry: `.../v1` and `.../v1/`
 * must address one deployment, and a base the protocol already names in full
 * must not look like a different endpoint.
 */
export function channelModelHash(apiBase: string, model: string, protocol: ChannelProtocol): string {
  return createHash("sha256")
    .update(`${channelUpstreamBase(apiBase, protocol)}\n${protocol}\n${model}`)
    .digest("hex")
    .slice(0, CHANNEL_HASH_LENGTH);
}

/** LiteLLM deployment id (`model_id`) for a channel model. */
export function channelModelId(apiBase: string, model: string, protocol: ChannelProtocol): string {
  return `${CHANNEL_ID_PREFIX}${channelModelHash(apiBase, model, protocol)}`;
}

/** The model name agents must ask the proxy for; this is what lands in the global override. */
export function channelModelAlias(apiBase: string, model: string, protocol: ChannelProtocol): string {
  return `${CHANNEL_ALIAS_PREFIX}${channelModelHash(apiBase, model, protocol)}`;
}

/**
 * `api_base` LiteLLM should call, for a given protocol.
 *
 * The operator's base IS the API root: a custom prefix they typed is kept, because
 * LiteLLM appends the protocol's own path to it. Dropped are trailing slashes, a
 * `/models` discovery suffix, and any suffix the protocol would double:
 *
 * - `messages` (native Anthropic) appends the FULL `/v1/messages`, so a pasted
 *   `…/v1` has to go or the request lands on `…/v1/v1/messages`; a base that already
 *   ends in `/v1/messages` is trimmed to the host for the same reason.
 * - `responses` appends only `/responses`, so `…/v1` stays and the call reaches
 *   `…/v1/responses` — stripping it would move the endpoint.
 * - `chat_completions` appends only `/chat/completions`, same reasoning.
 */
export function channelUpstreamBase(apiBase: string, protocol?: ChannelProtocol): string {
  const trimmed = apiBase.trim().replace(/\/+$/, "");
  const withoutListing = trimmed.toLowerCase().endsWith("/models")
    ? trimmed.slice(0, -"/models".length).replace(/\/+$/, "")
    : trimmed;
  if (!protocol) return withoutListing;
  // Longest suffix first, so `/v1/messages` is not half-matched by `/v1`.
  for (const suffix of CHANNEL_PROTOCOL_REGISTRATION[protocol].stripPaths) {
    if (withoutListing.toLowerCase().endsWith(suffix.toLowerCase())) {
      return withoutListing.slice(0, -suffix.length).replace(/\/+$/, "");
    }
  }
  return withoutListing;
}

/** The path LiteLLM's own URL builder appends for each protocol. */
export function channelUpstreamPath(protocol: ChannelProtocol): string {
  return CHANNEL_PROTOCOL_REGISTRATION[protocol].appendPath;
}

/** Does this string look like a channel registration we own (and may delete)? */
export function isChannelAliasOrId(value: string): boolean {
  return new RegExp(`^${CHANNEL_ID_PREFIX}[0-9a-f]{${CHANNEL_HASH_LENGTH}}$`).test(channelDeploymentId(value));
}

/** Alias → deployment id (the alias is the id behind an explicit provider prefix). */
export function channelDeploymentId(aliasOrId: string): string {
  const slash = aliasOrId.indexOf("/");
  return slash === -1 ? aliasOrId : aliasOrId.slice(slash + 1);
}

/**
 * LiteLLM master key, server-side only.
 *
 * Ordered by what the compose stack actually provides: the proxy's own
 * `LITELLM_MASTER_KEY`, the health endpoint's `LITELLM_API_KEY` alias, then the
 * name the agent core uses for the same value. An empty result means the
 * deployment is misconfigured — never a reason to fall back to a public default.
 */
export function channelProxyCredential(env: SettingsEnv = process.env): string {
  return (
    env.LITELLM_MASTER_KEY?.trim() ||
    env.LITELLM_API_KEY?.trim() ||
    env.DECEPTICON_LLM__PROXY_API_KEY?.trim() ||
    ""
  );
}

/** Replace every occurrence of each secret with a marker; the only sanitizer in the stack. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.trim().length < 8) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

// ── Proxy plumbing ───────────────────────────────────────────────────

interface ProxyResponse {
  status: number;
  payload: unknown;
}

interface ProxyContext {
  url: string;
  credential: string;
  secrets: string[];
  fetchImpl: typeof fetch;
}

function proxyContext(input: ChannelModelInput | null, deps: ChannelProxyDeps): ProxyContext {
  const env = deps.env ?? process.env;
  const credential = channelProxyCredential(env);
  if (!credential) {
    // Fail loudly instead of calling the proxy unauthenticated: a 401 from LiteLLM
    // would look like a channel problem and send the operator hunting in the wrong place.
    throw new ChannelModelRegistrationError(
      "LiteLLM master key is not configured on the Web server (LITELLM_MASTER_KEY)",
    );
  }
  return {
    url: settingsProxyUrl(env),
    credential,
    // Header VALUES are credentials for the operator's endpoint: they are redacted
    // from every message this module can produce.
    secrets: [credential, input?.apiKey ?? "", ...Object.values(input?.extraHeaders ?? {})],
    fetchImpl: deps.fetchImpl ?? fetch,
  };
}

/** One management call. Never throws for an HTTP status; the caller interprets it. */
async function callProxy(ctx: ProxyContext, path: string, init: RequestInit): Promise<ProxyResponse> {
  let response: Response;
  try {
    response = await ctx.fetchImpl(`${ctx.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${ctx.credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    // Connection refused, DNS, TLS, timeout — LiteLLM is unreachable, not the channel.
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, DETAIL_MAX_LENGTH);
    throw new ChannelModelRegistrationError(
      redactSecrets(`Could not reach the LiteLLM proxy at ${ctx.url}: ${reason}`, ctx.secrets),
    );
  }

  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

/** LiteLLM's own message, if the payload carries one. */
function proxyDetail(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  const detail = record.detail;
  if (typeof detail === "string") return detail;
  if (typeof detail === "object" && detail !== null) {
    const nested = (detail as Record<string, unknown>).error;
    if (typeof nested === "string") return nested;
    if (typeof nested === "object" && nested !== null) {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return "";
}

/**
 * Error for a non-2xx proxy answer: fixed wording + LiteLLM's redacted detail.
 * The detail is what turns "502" into an actionable "Set STORE_MODEL_IN_DB=True".
 */
function proxyFailure(ctx: ProxyContext, action: string, response: ProxyResponse): ChannelModelRegistrationError {
  const detail = redactSecrets(proxyDetail(response.payload).trim(), ctx.secrets).slice(0, DETAIL_MAX_LENGTH);
  const suffix = detail ? `: ${detail}` : "";
  return new ChannelModelRegistrationError(`LiteLLM ${action} failed (HTTP ${response.status})${suffix}`);
}

// ── Deployment lookup ─────────────────────────────────────────────────

interface Deployment {
  /** LiteLLM `model_id` (our `<prefix><hash>` for channel deployments). */
  id: string;
  /** True when the deployment lives in LiteLLM's DB (i.e. was registered dynamically). */
  dbModel: boolean;
  /** Marker present only on deployments this module created. */
  ours: boolean;
}

/** First entry of a `/v1/model/info` payload. */
function firstDeployment(payload: unknown): Deployment | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const entry = data[0];
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const info = (record.model_info ?? {}) as Record<string, unknown>;
  const id = typeof info.id === "string" ? info.id : "";
  if (!id) return null;
  return { id, dbModel: info.db_model === true, ours: info[CHANNEL_MARKER_FIELD] === true };
}

/** Look a deployment up by id. `null` = LiteLLM answered "no such model". */
async function findDeployment(ctx: ProxyContext, id: string): Promise<Deployment | null> {
  const response = await callProxy(
    ctx,
    `/v1/model/info?litellm_model_id=${encodeURIComponent(id)}`,
    { method: "GET" },
  );
  if (response.status === 400 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) throw proxyFailure(ctx, "model lookup", response);
  return firstDeployment(response.payload);
}

// ── Registration ──────────────────────────────────────────────────────

/**
 * `litellm_params` for the channel deployment.
 *
 * `max_tokens` is the operator's declared output ceiling: LiteLLM would otherwise
 * apply its own default and let a request ask for more than the endpoint's
 * contract. `extra_headers` carries the operator's plain headers to the upstream
 * call only — LiteLLM keeps them inside the deployment params.
 */
function deploymentParams(input: ChannelModelInput): Record<string, unknown> {
  const { provider, modelPrefix } = CHANNEL_PROTOCOL_REGISTRATION[input.protocol];
  const headers = input.extraHeaders ?? {};
  return {
    // The prefix is what selects the route, not just the provider. LiteLLM strips
    // `<provider>/` before the upstream request, so the endpoint receives the id it
    // advertises — but `openai/<model>` always POSTs `/chat/completions`, so a
    // Responses endpoint needs the literal `openai/responses/<model>` (the only form
    // that reaches `/responses`), and `anthropic/<model>` keeps the native Messages
    // handler instead of the OpenAI-to-Anthropic translation. The explicit prefix
    // also keeps a model id containing a slash (e.g. `meta-llama/Llama-3-8B`) from
    // being parsed as one.
    model: `${modelPrefix}/${input.model}`,
    custom_llm_provider: provider,
    api_base: channelUpstreamBase(input.apiBase, input.protocol),
    api_key: input.apiKey || CHANNEL_KEYLESS_PLACEHOLDER,
    max_tokens: input.maxOutputTokens,
    ...(Object.keys(headers).length > 0 ? { extra_headers: headers } : {}),
  };
}

/** `model_info` for the channel deployment: ownership marker, protocol mode and token budget. */
function deploymentInfo(input: ChannelModelInput, id: string): Record<string, unknown> {
  return {
    id,
    [CHANNEL_MARKER_FIELD]: true,
    mode: CHANNEL_PROTOCOL_REGISTRATION[input.protocol].mode,
    max_input_tokens: input.contextWindowTokens,
    max_output_tokens: input.maxOutputTokens,
  };
}

/**
 * Register (or refresh) the channel model on LiteLLM and resolve with the alias.
 *
 * Rejects with {@link ChannelModelRegistrationError} when the endpoint could not be
 * created or verified, or the alias/id is already taken by something that is not
 * ours (a config-model name collision, or a DB row an operator created by hand) —
 * overwriting either would silently redirect an existing model. The protocol is a
 * validated {@link ChannelProtocol} by the time it arrives, and each one maps to its
 * own `custom_llm_provider` + model prefix, so a request is never silently routed
 * to a different protocol's path.
 */
export async function registerChannelModel(
  input: ChannelModelInput,
  deps: ChannelProxyDeps = {},
): Promise<string> {
  const model = input.model.trim();
  if (!model) throw new ChannelModelRegistrationError("Channel model id is required");
  if (input.maxOutputTokens > input.contextWindowTokens) {
    throw new ChannelModelRegistrationError("Channel max output tokens exceed its context window");
  }

  const ctx = proxyContext(input, deps);
  const id = channelModelId(input.apiBase, model, input.protocol);
  const alias = channelModelAlias(input.apiBase, model, input.protocol);
  const params = deploymentParams(input);
  const info = deploymentInfo(input, id);

  const existing = await findDeployment(ctx, id);
  if (existing) {
    if (!existing.dbModel) {
      throw new ChannelModelRegistrationError(
        `LiteLLM already serves "${alias}" from its own config; the channel cannot take that alias`,
      );
    }
    if (!existing.ours) {
      throw new ChannelModelRegistrationError(
        `LiteLLM already has a deployment "${id}" that this dashboard did not create; refusing to overwrite it`,
      );
    }

    // Refresh in place: this is what keeps a key rotation from leaving a second
    // deployment of the same alias behind with the previous key still attached.
    const patched = await callProxy(
      ctx,
      `/model/${encodeURIComponent(id)}/update`,
      {
        method: "PATCH",
        body: JSON.stringify({ model_name: alias, litellm_params: params, model_info: info }),
      },
    );
    if (patched.status < 200 || patched.status >= 300) throw proxyFailure(ctx, "model update", patched);
  } else {
    const created = await callProxy(
      ctx,
      "/model/new",
      {
        method: "POST",
        body: JSON.stringify({ model_name: alias, litellm_params: params, model_info: info }),
      },
    );
    if (created.status < 200 || created.status >= 300) throw proxyFailure(ctx, "model registration", created);
  }

  await verifyRegistered(ctx, id);
  return alias;
}

/**
 * Confirm the deployment is live in the proxy's router before the caller persists
 * the alias: `/model/new` returns before the router necessarily exposes it, and a
 * saved override pointing at an unregistered alias fails at the first agent call.
 */
async function verifyRegistered(ctx: ProxyContext, id: string): Promise<void> {
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    const found = await findDeployment(ctx, id);
    if (found && found.dbModel && found.ours) return;
    if (attempt < VERIFY_ATTEMPTS - 1) await delay(VERIFY_DELAY_MS);
  }
  throw new ChannelModelRegistrationError(
    `LiteLLM accepted the deployment "${id}" but did not expose it on the router; nothing was saved`,
  );
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ── Deregistration ────────────────────────────────────────────────────

/**
 * Delete a channel deployment so a replaced or cleared channel leaves no orphan.
 *
 * Best-effort by contract: a deployment LiteLLM no longer knows about resolves
 * `false` rather than throwing, because the settings store (not LiteLLM) is the
 * source of truth for what the operator configured. Any other failure rejects with
 * a sanitized message; callers treat that as a warning, never as a save failure.
 */
export async function removeChannelModel(
  aliasOrId: string,
  deps: ChannelProxyDeps = {},
): Promise<boolean> {
  const value = aliasOrId.trim();
  // Refuse anything outside our namespace: this endpoint must not become a generic
  // "delete a model from the proxy" privilege escalator.
  if (!isChannelAliasOrId(value)) {
    throw new ChannelModelRegistrationError("Not a Decepticon channel alias");
  }

  const ctx = proxyContext(null, deps);
  const id = channelDeploymentId(value);

  const existing = await findDeployment(ctx, id);
  if (!existing) return false;
  if (!existing.dbModel || !existing.ours) return false;

  const deleted = await callProxy(ctx, "/model/delete", { method: "POST", body: JSON.stringify({ id }) });
  if (deleted.status === 400 || deleted.status === 404) return false;
  if (deleted.status < 200 || deleted.status >= 300) throw proxyFailure(ctx, "model deletion", deleted);
  return true;
}
