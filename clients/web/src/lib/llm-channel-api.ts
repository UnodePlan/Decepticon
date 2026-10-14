/**
 * Custom LLM channel route handlers — HTTP behaviour only, no wiring.
 *
 * The route files under `src/app/api/settings/llm-channel/**` are thin adapters
 * that inject the Prisma store, `requireAuth` and the LiteLLM proxy functions;
 * everything testable lives here so it can run without a database, a session
 * cookie or a live LiteLLM deployment:
 *
 *   GET  → `{ apiBase, apiKeySet, model, protocol, protocols, contextWindowTokens,
 *             maxOutputTokens, extraHeadersSet }`             (never the key or a header value)
 *   PUT  → discover the chosen model, prove the endpoint serves the chosen
 *          protocol with one minimal request on that protocol's own route,
 *          register the alias with LiteLLM, persist the channel + the GLOBAL
 *          model override in one transaction, then return the snapshot plus
 *          `globalModelOverride`.
 *   POST /models → models the operator's endpoint advertises (key reuse rules,
 *          protocol-aware listing path).
 *   POST /test   → one minimal upstream request for the *unsaved* draft, so an
 *          operator can prove the endpoint answers before saving.
 *
 * Error contract, identical to `/api/settings`:
 *   401 `{ error }` · 400 `{ error, fields? }` · 500 `{ error }` (storage) ·
 *   502 `{ error }` (upstream). No response, header or message ever contains the
 *   channel credential, a channel header value or an upstream response body.
 *
 * An unknown protocol, or one without a standard model listing, is a 400
 * (`fields.protocol`) — never a silent fallback to another protocol.
 */

import { NextResponse } from "next/server";
import { AuthError } from "./auth-bridge";
import { readDiscoverBody, readSaveBody, readTestBody } from "./llm-channel";
import type { ChannelModelInput } from "./llm-channel-proxy";
import {
  channelSnapshot,
  channelWriteChanges,
  parseChannelRows,
  resolveChannelConfig,
  resolveChannelHeaders,
  resolveChannelKey,
  storedChannelHeaders,
  savedChannelSnapshot,
  type StoredChannel,
} from "./llm-channel-state";
import {
  ChannelDiscoveryError,
  discoverChannelModels,
  testChannelModel,
} from "./llm-channel-fetch";
import { parseSettingsRows, type SettingsEnv } from "./system-settings";
import { type SettingsStore } from "./system-settings-runtime";

/** What the routes hand to the proxy adapter: the validated channel configuration. */
export type ChannelRegistration = ChannelModelInput;

export interface ChannelApiDeps {
  store: SettingsStore;
  /** Injected so the handlers stay decoupled from `next/headers`. */
  authenticate: () => Promise<unknown>;
  env?: SettingsEnv;
  fetchImpl?: typeof fetch;
  /** `registerChannelModel` from `@/lib/llm-channel-proxy`; resolves with the alias. */
  register: (input: ChannelRegistration) => Promise<string>;
  /** `removeChannelModel`; best-effort pruning of a registration we replaced or cleared. */
  unregister?: (alias: string) => Promise<unknown>;
}

/** GET /api/settings/llm-channel — current channel state, without the key or header values. */
export async function getChannel(deps: ChannelApiDeps): Promise<NextResponse> {
  try {
    await deps.authenticate();
  } catch (error) {
    return authFailure(error);
  }

  try {
    const stored = parseChannelRows(await deps.store.read());
    return NextResponse.json(channelSnapshot(stored));
  } catch {
    return NextResponse.json({ error: "Failed to read the LLM channel" }, { status: 500 });
  }
}

/** POST /api/settings/llm-channel/models — discover the endpoint's model ids. */
export async function discoverModels(request: Request, deps: ChannelApiDeps): Promise<NextResponse> {
  try {
    await deps.authenticate();
  } catch (error) {
    return authFailure(error);
  }

  const raw = await readBody(request);
  if (!raw.ok) return raw.response;
  const parsed = readDiscoverBody(raw.body);
  if (!parsed.ok) return rejected(parsed);

  const rows = await readRows(deps);
  if (!rows.ok) return rows.response;
  const stored = parseChannelRows(rows.value);

  const key = resolveChannelKey(stored, parsed.body.apiBase, parsed.body.apiKey, parsed.body.keyless);
  if (!key.ok) return rejected(key);

  try {
    // A blank row means "the value is stored" (same base only), so the listing
    // request is authenticated the way the endpoint actually expects.
    const headers = resolveChannelHeaders(parsed.body.extraHeaders, storedChannelHeaders(parsed.body.apiBase, stored));
    const models = await discoverChannelModels(
      {
        apiBase: parsed.body.apiBase,
        apiKey: key.apiKey,
        protocol: parsed.body.protocol,
        ...(Object.keys(headers).length > 0 ? { extraHeaders: headers } : {}),
      },
      deps.fetchImpl,
    );
    return NextResponse.json({ models: models ?? [], manual: models === null });
  } catch (error) {
    return upstreamFailure(error);
  }
}

/**
 * POST /api/settings/llm-channel/test — probe the unsaved draft.
 *
 * The probe speaks the operator's protocol against the operator's endpoint with
 * the operator's key, and reports only a fixed sentence: success, or the class of
 * failure. Nothing from the upstream response (body, headers or status text) is
 * forwarded.
 */
export async function testChannel(request: Request, deps: ChannelApiDeps): Promise<NextResponse> {
  try {
    await deps.authenticate();
  } catch (error) {
    return authFailure(error);
  }

  const raw = await readBody(request);
  if (!raw.ok) return raw.response;
  const parsed = readTestBody(raw.body);
  if (!parsed.ok) return rejected(parsed);
  const probe = parsed.body;

  const rows = await readRows(deps);
  if (!rows.ok) return rows.response;
  const stored = parseChannelRows(rows.value);
  const key = resolveChannelKey(stored, probe.apiBase, probe.apiKey, probe.keyless);
  if (!key.ok) return rejected(key);
  // A blank row means "the value is stored": the probe must send the SAVED value
  // for that name, exactly as a save would keep it, or a working endpoint would
  // be reported as unreachable. Stored values are reused ONLY for the base they
  // were saved against — a newly typed base gets no old credential.
  const headers = resolveChannelHeaders(probe.extraHeaders, storedChannelHeaders(probe.apiBase, stored));

  try {
    const result = await testChannelModel(
      {
        apiBase: probe.apiBase,
        apiKey: key.apiKey,
        protocol: probe.protocol,
        model: probe.model,
        ...(probe.maxOutputTokens !== undefined ? { maxOutputTokens: probe.maxOutputTokens } : {}),
        // The draft's OWN header rows: they are part of what makes the endpoint
        // answer, so the probe has to send them, and a plain-header value that
        // fails here would fail the same way on every agent call.
        ...(Object.keys(headers).length > 0 ? { extraHeaders: headers } : {}),
      },
      deps.fetchImpl,
    );
    return NextResponse.json(
      { ok: result.ok, detail: result.detail },
      { status: result.ok ? 200 : result.status },
    );
  } catch {
    return NextResponse.json({ ok: false, detail: "Could not reach the endpoint" }, { status: 502 });
  }
}

/**
 * PUT /api/settings/llm-channel — save or clear the channel.
 *
 * Saving validates the endpoint twice over — the model listing (does it offer the
 * chosen model?) and a minimal request on the protocol's own route (does it serve
 * that protocol?) — registers the alias, and only then writes the channel rows
 * plus the global override in a single transaction: a failed registration
 * persists nothing, a failed write is rolled back (the fresh registration is
 * pruned) and reported as a 500, and the superseded registration is pruned only
 * after the new one is durable.
 */
export async function putChannel(request: Request, deps: ChannelApiDeps): Promise<NextResponse> {
  try {
    await deps.authenticate();
  } catch (error) {
    return authFailure(error);
  }

  const raw = await readBody(request);
  if (!raw.ok) return raw.response;
  const parsed = readSaveBody(raw.body);
  if (!parsed.ok) return rejected(parsed);
  const save = parsed.body;

  const rows = await readRows(deps);
  if (!rows.ok) return rows.response;
  const stored = parseChannelRows(rows.value);
  const globalOverride = parseSettingsRows(rows.value, deps.env).globalModelOverride;

  // Clearing the channel: drop every channel row and unset the global override
  // only while it still points at this channel's alias.
  if (save.model === "") return clearChannel(deps, stored, globalOverride);

  const apiBase = save.apiBase ?? stored.apiBase;
  const key = resolveChannelKey(stored, apiBase, save.apiKey, save.keyless);
  if (!key.ok) return rejected(key);
  const config = resolveChannelConfig(save, stored);

  // Configuration check BEFORE anything is written or registered. Two questions,
  // and neither answers the other:
  //
  //   1. does the endpoint offer the selected model? — a model LISTING, and an
  //      empty answer means "no standard listing" (Anthropic Messages), which is
  //      not a failure;
  //   2. does the endpoint actually serve the selected PROTOCOL for it? — the
  //      protocol's own request. `/models` is an OpenAI-compatible route that
  //      says nothing about `/responses` or `/v1/messages`, so a channel whose
  //      protocol the endpoint does not implement would be registered, adopt the
  //      global model override and then fail on the first agent call — silently
  //      falling back to whatever the agent ran before. The probe catches that
  //      here, while the operator is still looking at the form.
  try {
    const models = await discoverChannelModels(
      {
        apiBase,
        apiKey: key.apiKey,
        protocol: config.protocol,
        // The headers the save will store: an endpoint that needs one to answer
        // must be checked WITH it, or a working configuration looks unreachable.
        ...(Object.keys(config.extraHeaders).length > 0 ? { extraHeaders: config.extraHeaders } : {}),
      },
      deps.fetchImpl,
    );
    if (models !== null && !models.includes(save.model)) {
      return rejected({
        error: "Invalid channel",
        fields: {
          model: `the endpoint does not offer "${save.model}" (it lists ${models.length} model${models.length === 1 ? "" : "s"})`,
        },
      });
    }
    const probe = await testChannelModel(
      {
        apiBase,
        apiKey: key.apiKey,
        protocol: config.protocol,
        model: save.model,
        maxOutputTokens: config.maxOutputTokens,
        // The headers the save would store: an endpoint that needs a plain
        // header to answer must be probed WITH it, or a working configuration
        // would be rejected as unreachable.
        ...(Object.keys(config.extraHeaders).length > 0 ? { extraHeaders: config.extraHeaders } : {}),
      },
      deps.fetchImpl,
    );
    if (!probe.ok) {
      // The probe's class decides where the answer belongs: a rejected
      // credential is an apiKey answer, a route the endpoint does not serve is
      // the protocol's, and anything else (rate limit, upstream 5xx, network)
      // is reported with the probe's own status so the banner matches it instead
      // of blaming a field the operator cannot change.
      if (probe.status === 401 || probe.status === 403) {
        return rejected({ error: "Invalid channel", fields: { apiKey: probe.detail } });
      }
      if (probe.status === 404) {
        return rejected({ error: "Invalid channel", fields: { protocol: probe.detail } });
      }
      return NextResponse.json({ error: probe.detail }, { status: probe.status });
    }
  } catch (error) {
    return upstreamFailure(error);
  }

  let alias: string;
  try {
    alias = await deps.register({ apiBase, apiKey: key.apiKey, model: save.model, ...config });
  } catch {
    // Registration errors are sanitized upstream too; keep the fixed wording so no
    // upstream text can reach the browser through this path.
    return NextResponse.json(
      { error: "LiteLLM refused to register this channel model — check the base URL, key, protocol and model" },
      { status: 502 },
    );
  }
  if (!alias) {
    return NextResponse.json({ error: "LiteLLM did not return a model alias" }, { status: 502 });
  }

  try {
    await deps.store.write(channelWriteChanges(save, stored, globalOverride, key.apiKey, alias));
  } catch {
    // Nothing references the alias we just created: leave LiteLLM as clean as we
    // found it instead of keeping a registration no setting points at.
    await prune(deps, alias);
    return NextResponse.json({ error: "Failed to save the LLM channel" }, { status: 500 });
  }
  // The previous registration is unreachable now; pruning it is best-effort.
  if (stored.alias && stored.alias !== alias) await prune(deps, stored.alias);

  return NextResponse.json({
    ...savedChannelSnapshot(stored, save, apiBase, key.apiKey, alias),
    globalModelOverride: alias,
  });
}

/** Clear path, shared by PUT `{ model: "" }`. */
async function clearChannel(
  deps: ChannelApiDeps,
  stored: StoredChannel,
  globalOverride: string,
): Promise<NextResponse> {
  const save = { model: "", keyless: true };
  try {
    await deps.store.write(channelWriteChanges(save, stored, globalOverride, undefined, ""));
  } catch {
    return NextResponse.json({ error: "Failed to save the LLM channel" }, { status: 500 });
  }
  if (stored.alias) await prune(deps, stored.alias);

  return NextResponse.json({
    apiBase: "",
    apiKeySet: false,
    model: "",
    protocol: stored.protocol,
    protocols: channelSnapshot(stored).protocols,
    contextWindowTokens: stored.contextWindowTokens,
    maxOutputTokens: stored.maxOutputTokens,
    extraHeadersSet: [],
    // Read-after-write: an unrelated override the operator set elsewhere survives.
    globalModelOverride: stored.alias && globalOverride === stored.alias ? "" : globalOverride,
  });
}

/** Best-effort LiteLLM deregistration; a failure leaves the DB as the source of truth. */
async function prune(deps: ChannelApiDeps, alias: string): Promise<void> {
  if (!deps.unregister) return;
  try {
    await deps.unregister(alias);
  } catch {
    // An orphaned LiteLLM deployment is harmless; never fail the API call for it.
  }
}

/** Parsed JSON body, or the 400 the caller must return. */
async function readBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 }),
    };
  }
}

/** Stored rows, or the 500 the caller must return. */
async function readRows(
  deps: ChannelApiDeps,
): Promise<{ ok: true; value: Array<{ key: string; value: string }> } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, value: await deps.store.read() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Failed to read the LLM channel" }, { status: 500 }),
    };
  }
}

function authFailure(error: unknown): NextResponse {
  return error instanceof AuthError
    ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    : NextResponse.json({ error: "LLM channel unavailable" }, { status: 500 });
}

function rejected(result: { error: string; fields?: Record<string, string> }): NextResponse {
  return NextResponse.json(
    { error: result.error, ...(result.fields ? { fields: result.fields } : {}) },
    { status: 400 },
  );
}

/** Discovery failures are already sanitized; anything else must not leak either. */
function upstreamFailure(error: unknown): NextResponse {
  const message =
    error instanceof ChannelDiscoveryError ? error.message : "Could not reach the endpoint";
  return NextResponse.json({ error: message }, { status: 502 });
}
