/**
 * Persisted LLM-channel state — what the `SystemSetting` rows mean, and what a
 * save/clear must write. PURE (no Prisma), so the route handlers can be tested
 * with an in-memory store.
 *
 * Split from `./llm-channel` (the request/response contract) because only the
 * server reads these: the settings card needs the snapshot type and the request
 * body rules, never the row layout.
 *
 * Rows written before the protocol/token/header fields existed are read back as
 * their documented defaults (`chat_completions`, 64000/64000, no headers), so an
 * older deployment keeps working without a migration.
 */

import {
  CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  CHANNEL_PROTOCOLS,
  CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_CHANNEL_PROTOCOL,
  LLM_CHANNEL_KEYS,
  LLM_CHANNEL_LIMITS,
  asChannelProtocol,
  normalizeChannelBase,
  type ChannelProtocol,
  type ChannelSaveBody,
  type LlmChannelSnapshot,
} from "./llm-channel";
import { SETTING_KEYS, extraHeaderNames, sanitizeExtraHeaders } from "./system-settings";

export interface StoredChannel {
  apiBase: string;
  apiKey: string;
  model: string;
  /** Alias of the last successful registration; the value written to the global override. */
  alias: string;
  protocol: ChannelProtocol;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Header values for the operator's own endpoint; never returned in a response. */
  extraHeaders: Record<string, string>;
}

/**
 * Read the channel rows. Like `parseSettingsRows`, stored values are trusted less
 * than request bodies: an unusable base/key/model/protocol/token/header value
 * reads back as its default instead of taking the settings page down.
 */
export function parseChannelRows(rows: Iterable<{ key: string; value: string }>): StoredChannel {
  const stored = new Map<string, string>();
  for (const row of rows) {
    if (row && typeof row.key === "string" && typeof row.value === "string") stored.set(row.key, row.value);
  }

  const apiBaseRow = stored.get(LLM_CHANNEL_KEYS.apiBase)?.trim() ?? "";
  const base = apiBaseRow ? normalizeChannelBase(apiBaseRow) : null;
  // A stored value is trusted less than a request body: an unusable model id
  // reads back as "unset" rather than as a model that cannot be used.
  const modelRow = stored.get(LLM_CHANNEL_KEYS.model)?.trim() ?? "";
  const contextWindowTokens = readStoredInt(
    stored.get(LLM_CHANNEL_KEYS.contextWindowTokens),
    LLM_CHANNEL_LIMITS.contextWindowTokens,
    CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  const maxOutputTokens = Math.min(
    readStoredInt(
      stored.get(LLM_CHANNEL_KEYS.maxOutputTokens),
      LLM_CHANNEL_LIMITS.maxOutputTokens,
      CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS,
    ),
    contextWindowTokens,
  );

  return {
    apiBase: base?.ok ? base.apiBase : "",
    apiKey: stored.get(LLM_CHANNEL_KEYS.apiKey)?.trim() ?? "",
    model: modelRow.length > LLM_CHANNEL_LIMITS.modelLength || /\s/.test(modelRow) ? "" : modelRow,
    alias: stored.get(LLM_CHANNEL_KEYS.alias)?.trim() ?? "",
    protocol: asChannelProtocol(stored.get(LLM_CHANNEL_KEYS.protocol)) ?? DEFAULT_CHANNEL_PROTOCOL,
    contextWindowTokens,
    maxOutputTokens,
    extraHeaders: readStoredHeaders(stored.get(LLM_CHANNEL_KEYS.extraHeaders)),
  };
}

/** A stored integer inside its bounds, else the documented default (absent row included). */
function readStoredInt(raw: string | undefined, bounds: { min: number; max: number }, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= bounds.min && value <= bounds.max ? value : fallback;
}

/** Stored headers, or `{}` when the row is absent/unparseable/violates the header rules. */
function readStoredHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return sanitizeExtraHeaders(parsed) ?? {};
}

/**
 * Public view of the channel: the key is reduced to `apiKeySet`, header VALUES to
 * their names, and the protocol list is the contract's full list — every protocol is
 * registered by this build.
 */
export function channelSnapshot(channel: StoredChannel): LlmChannelSnapshot {
  return {
    apiBase: channel.apiBase,
    apiKeySet: channel.apiKey !== "",
    model: channel.model,
    protocol: channel.protocol,
    protocols: [...CHANNEL_PROTOCOLS],
    contextWindowTokens: channel.contextWindowTokens,
    maxOutputTokens: channel.maxOutputTokens,
    extraHeadersSet: extraHeaderNames(channel.extraHeaders),
  };
}

/**
 * Public view of a save that just succeeded — exactly what a follow-up GET
 * returns, derived from the same pure helpers rather than trusted from the
 * request body (so a shrunk output budget shows up in the response too).
 */
export function savedChannelSnapshot(
  stored: StoredChannel,
  save: ChannelSaveBody,
  apiBase: string,
  apiKey: string,
  alias: string,
): LlmChannelSnapshot {
  return channelSnapshot(
    { ...stored, ...resolveChannelConfig(save, stored), apiBase, apiKey, model: save.model, alias },
  );
}

/** The token/header configuration a save must end up with, given the stored row. */
export interface ChannelConfig {
  protocol: ChannelProtocol;
  contextWindowTokens: number;
  maxOutputTokens: number;
  extraHeaders: Record<string, string>;
}

/**
 * Fill a save request out to a complete configuration.
 *
 * An absent field keeps the stored value (a client that predates the field must
 * not reset the channel), `contextWindowTokens` below the stored output shrinks
 * the output to stay inside the window, and the request's own fields win. The
 * result is validated by `readSaveBody` before it gets here.
 *
 * Header values are the exception, because the browser cannot read a stored one
 * back: a row sent with the NAME kept but a BLANK value means "leave that
 * header's stored value alone" (the card renders one blank row per saved name).
 * Dropping a header is done by clearing its name — that is, not sending it.
 */
export function resolveChannelConfig(save: ChannelSaveBody, stored: StoredChannel): ChannelConfig {
  const protocol = save.protocol ?? stored.protocol;
  const contextWindowTokens = save.contextWindowTokens ?? stored.contextWindowTokens;
  const maxOutputTokens = Math.min(save.maxOutputTokens ?? stored.maxOutputTokens, contextWindowTokens);
  // Stored header VALUES are a credential of the endpoint they were saved for: a
  // base the operator just changed must never receive them (the same rule the API
  // key follows), so only a same-base save resolves a blank value from the store.
  const base = save.apiBase ?? stored.apiBase;
  return {
    protocol,
    contextWindowTokens,
    maxOutputTokens,
    extraHeaders: resolveChannelHeaders(save.extraHeaders, storedChannelHeaders(base, stored)),
  };
}

/** The stored header VALUES a request against `apiBase` may reuse (same endpoint only). */
export function storedChannelHeaders(
  apiBase: string,
  stored: StoredChannel,
): Record<string, string> {
  // A header value is a credential of the endpoint it was saved for: another base
  // must never receive it, exactly like the API key.
  return apiBase === stored.apiBase && stored.apiBase !== "" ? stored.extraHeaders : {};
}

/** The header map a save/probe must end up with: sent values win, blanks keep the stored value. */
export function resolveChannelHeaders(
  sent: Record<string, string> | undefined,
  stored: Record<string, string>,
): Record<string, string> {
  if (sent === undefined) return stored;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(sent)) {
    if (value === "" && Object.hasOwn(stored, name)) headers[name] = stored[name];
    else headers[name] = value;
  }
  return headers;
}

export type KeyResolution = { ok: true; apiKey: string } | { ok: false; error: string; fields: Record<string, string> };

/**
 * Decide which credential a request may use.
 *
 * A base the operator just changed must NEVER be contacted with the key stored
 * for the previous base: an absent `apiKey` is only reusable when it was stored
 * for exactly this normalized base. The rejected request carries the apiKey field
 * error so the card can prompt for the key instead of silently falling back.
 */
export function resolveChannelKey(
  stored: StoredChannel,
  normalizedBase: string,
  providedKey: string | undefined,
  keyless: boolean,
): KeyResolution {
  if (keyless) return { ok: true, apiKey: "" };
  if (providedKey !== undefined) return { ok: true, apiKey: providedKey };

  const storedKeyUsable = stored.apiBase === normalizedBase && stored.apiBase !== "";
  if (storedKeyUsable) return { ok: true, apiKey: stored.apiKey };
  return {
    ok: false,
    error: "Invalid channel",
    fields: {
      apiKey:
        stored.apiBase && stored.apiBase !== normalizedBase
          ? "the saved API key belongs to a different apiBase — enter the key for this endpoint (or send \"\" for a keyless endpoint)"
          : "apiKey is required for a new channel (send \"\" for a keyless endpoint)",
    },
  };
}

/**
 * Which stored rows a save/clear writes.
 *
 * Values follow the settings store's convention: `null` deletes the row, a string
 * upserts it. A clear removes every channel row and only unsets the global
 * override while it still equals this channel's alias — an unrelated model the
 * operator configured elsewhere survives. A save writes the channel rows and the
 * global override together so one transaction covers both.
 */
export function channelWriteChanges(
  save: ChannelSaveBody,
  stored: StoredChannel,
  globalModelOverride: string,
  resolvedKey: string | undefined,
  alias: string,
): Array<{ key: string; value: string | null }> {
  if (save.model === "") {
    const changes: Array<{ key: string; value: string | null }> = [
      { key: LLM_CHANNEL_KEYS.apiBase, value: null },
      { key: LLM_CHANNEL_KEYS.apiKey, value: null },
      { key: LLM_CHANNEL_KEYS.model, value: null },
      { key: LLM_CHANNEL_KEYS.alias, value: null },
      { key: LLM_CHANNEL_KEYS.protocol, value: null },
      { key: LLM_CHANNEL_KEYS.contextWindowTokens, value: null },
      { key: LLM_CHANNEL_KEYS.maxOutputTokens, value: null },
      { key: LLM_CHANNEL_KEYS.extraHeaders, value: null },
    ];
    if (stored.alias && globalModelOverride === stored.alias) {
      changes.push({ key: SETTING_KEYS.globalModelOverride, value: null });
    }
    return changes;
  }

  const apiBase = save.apiBase ?? stored.apiBase;
  const apiKey = resolvedKey ?? "";
  const config = resolveChannelConfig(save, stored);
  return [
    { key: LLM_CHANNEL_KEYS.apiBase, value: apiBase },
    // An empty key is stored as an absent row so `apiKeySet` stays honest.
    { key: LLM_CHANNEL_KEYS.apiKey, value: apiKey === "" ? null : apiKey },
    { key: LLM_CHANNEL_KEYS.model, value: save.model },
    { key: LLM_CHANNEL_KEYS.alias, value: alias },
    { key: LLM_CHANNEL_KEYS.protocol, value: config.protocol },
    { key: LLM_CHANNEL_KEYS.contextWindowTokens, value: String(config.contextWindowTokens) },
    { key: LLM_CHANNEL_KEYS.maxOutputTokens, value: String(config.maxOutputTokens) },
    // No headers is stored as an absent row rather than an empty object.
    {
      key: LLM_CHANNEL_KEYS.extraHeaders,
      value: Object.keys(config.extraHeaders).length === 0 ? null : JSON.stringify(config.extraHeaders),
    },
    { key: SETTING_KEYS.globalModelOverride, value: alias },
  ];
}
