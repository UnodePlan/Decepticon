/**
 * Client-side model of the custom LLM channel card.
 *
 * The channel is one endpoint the operator configures from the console: base URL
 * and protocol → fetch the endpoint's models (or type one when the protocol has
 * no listing) → set the context/output budget and any headers it needs → test →
 * save. Saving also registers the model with the LLM proxy under a
 * Decepticon-owned alias and rewrites the global model override, so the card
 * reports the alias the server persisted and the page resyncs its "global model
 * override" field from it.
 *
 * Secrets: the API key and every header VALUE only ever travel browser → server.
 * The GET payload carries `apiKeySet` and `extraHeadersSet` (names only); values
 * never reach this module, and the draft always renders those fields empty.
 *
 * The base-URL and request-body rules are NOT re-implemented here: `./llm-channel`
 * is pure and browser-safe, so the card and the route handler share one definition
 * of "same endpoint" — which is what decides key reuse on both sides.
 */

import {
  CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  CHANNEL_PROTOCOLS,
  CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_CHANNEL_PROTOCOL,
  LLM_CHANNEL_LIMITS,
  asChannelProtocol,
  normalizeChannelBase,
  parseChannelSnapshot,
  type ChannelProtocol,
  type LlmChannelSnapshot,
} from "./llm-channel";
import { SETTINGS_LIMITS, isValidExtraHeaderName } from "./system-settings";
import type { TranslationKey, TranslationParams } from "./i18n";

export type { LlmChannelSnapshot };

/** Translator the card's validation messages are built with. */
export type ChannelTranslateFn = (key: TranslationKey, params?: TranslationParams) => string;

/**
 * One editable header row. `id` is the row's identity for React's key: the name
 * is user input, so keying a row by it would remount the inputs on every
 * keystroke and drop the value the operator typed next to the name.
 */
export interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

/**
 * Editable channel state. `apiKey` and the header rows are write-only: they start
 * empty (the server never sends a value back) and are only populated by the
 * operator typing.
 */
export interface ChannelDraft {
  apiBase: string;
  apiKey: string;
  model: string;
  protocol: ChannelProtocol;
  contextWindowTokens: string;
  maxOutputTokens: string;
  /** Rows as typed, including the empty one the card always shows. */
  extraHeaders: HeaderRow[];
}

/** Monotonic id source for header rows; unique for the life of the page. */
let nextHeaderRowId = 1;

/** A blank row: the slot the operator types the next header into. */
export function blankHeaderRow(): HeaderRow {
  return { id: nextHeaderRowId++, name: "", value: "" };
}

/** Field-keyed validation messages, keyed by the server's field names. */
export type ChannelFieldErrors = Record<string, string>;

const CHANNEL_URL = "/api/settings/llm-channel";
const CHANNEL_MODELS_URL = "/api/settings/llm-channel/models";
const CHANNEL_TEST_URL = "/api/settings/llm-channel/test";

/** Request budget: the server's own upstream probe allows 5s, so this must outlast it. */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Status stand-ins so the card can localize a failure instead of inspecting text.
 * Private: callers read failures through {@link channelErrorKey}.
 */
const CHANNEL_STATUS = {
  /** Transport failure or timeout — no response at all. */
  network: 0,
  /** The endpoint could not be reached, redirected, or rejected the credential. */
  upstream: 502,
} as const;

export const EMPTY_CHANNEL: LlmChannelSnapshot = {
  apiBase: "",
  apiKeySet: false,
  model: "",
  protocol: DEFAULT_CHANNEL_PROTOCOL,
  protocols: [...CHANNEL_PROTOCOLS],
  contextWindowTokens: CHANNEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: CHANNEL_DEFAULT_MAX_OUTPUT_TOKENS,
  extraHeadersSet: [],
};

/** Form baseline for a snapshot: every write-only field is empty. */
export function channelDraftFromSnapshot(snapshot: LlmChannelSnapshot): ChannelDraft {
  return {
    apiBase: snapshot.apiBase,
    apiKey: "",
    model: snapshot.model,
    protocol: snapshot.protocol,
    contextWindowTokens: String(snapshot.contextWindowTokens),
    maxOutputTokens: String(snapshot.maxOutputTokens),
    extraHeaders: headerRows(snapshot.extraHeadersSet),
  };
}

/**
 * Header rows for a snapshot. A previously saved header reads back as its NAME
 * only — the value is a server-side secret — so the row is shown with an empty
 * value and a "value kept" hint instead of a fake placeholder that would be saved
 * on the next edit.
 */
export function headerRows(names: string[]): HeaderRow[] {
  const rows = names.map((name) => ({ id: nextHeaderRowId++, name, value: "" }));
  return [...rows, blankHeaderRow()];
}

/** Drop blank rows and turn the typed rows into the request's header map. */
export function headerMap(rows: HeaderRow[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim().toLowerCase();
    if (name) headers[name] = row.value.trim();
  }
  return headers;
}

/** Do two bases address the same endpoint? Same normalization the server compares with. */
export function sameChannelBase(left: string, right: string): boolean {
  const normalizedLeft = normalizeChannelBase(left);
  const normalizedRight = normalizeChannelBase(right);
  return normalizedLeft.ok && normalizedRight.ok && normalizedLeft.apiBase === normalizedRight.apiBase;
}

/** Endpoint fields only: the probes need a base URL, a protocol and a usable key. */
export function validateChannelEndpoint(draft: ChannelDraft, t: ChannelTranslateFn): ChannelFieldErrors {
  const errors: ChannelFieldErrors = {};

  if (!normalizeChannelBase(draft.apiBase).ok) {
    errors.apiBase = t("settings.channel.error.apiBase");
  }

  if (!asChannelProtocol(draft.protocol)) {
    errors.protocol = t("settings.channel.error.protocol");
  }

  const key = draft.apiKey.trim();
  if (/\s/.test(key) || key.length > LLM_CHANNEL_LIMITS.apiKeyLength) {
    errors.apiKey = t("settings.channel.error.apiKey");
  }

  const headers = validateHeaderRows(draft, t);
  for (const field of Object.keys(headers)) errors[field] = headers[field];

  return errors;
}

/** Validate the draft before a request leaves the browser. */
export function validateChannelDraft(draft: ChannelDraft, t: ChannelTranslateFn): ChannelFieldErrors {
  const errors = validateChannelEndpoint(draft, t);

  const model = draft.model.trim();
  if (model === "" || /\s/.test(model) || model.length > LLM_CHANNEL_LIMITS.modelLength) {
    errors.model = t("settings.channel.error.model");
  }

  const context = readTokenField(draft.contextWindowTokens, LLM_CHANNEL_LIMITS.contextWindowTokens.min, LLM_CHANNEL_LIMITS.contextWindowTokens.max);
  if (context === null) errors.contextWindowTokens = t("settings.channel.error.context");
  const output = readTokenField(draft.maxOutputTokens, LLM_CHANNEL_LIMITS.maxOutputTokens.min, LLM_CHANNEL_LIMITS.maxOutputTokens.max);
  if (output === null) errors.maxOutputTokens = t("settings.channel.error.output");
  if (context !== null && output !== null && output > context) {
    errors.maxOutputTokens = t("settings.channel.error.tokens");
  }

  return errors;
}

/** `null` when the field is not an integer inside its bounds. */
function readTokenField(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Header rows, validated with the SHARED rule (`./system-settings`): the same
 * predicate that guards the PUT body and the global headers, so a name the
 * browser lets through is a name the server accepts, and a credential-bearing
 * name is refused before a request is made.
 */
function validateHeaderRows(draft: ChannelDraft, t: ChannelTranslateFn): ChannelFieldErrors {
  const errors: ChannelFieldErrors = {};
  const rows = draft.extraHeaders.filter((row) => row.name.trim() !== "");
  if (rows.length > SETTINGS_LIMITS.extraHeadersMaxEntries) {
    errors.extraHeaders = t("settings.channel.error.headers");
    return errors;
  }
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (
      !isValidExtraHeaderName(name) ||
      value.length > SETTINGS_LIMITS.extraHeaderValueLength ||
      /[\r\n]/.test(value)
    ) {
      errors.extraHeaders = t("settings.channel.error.headers");
      return errors;
    }
  }
  const names = rows.map((row) => row.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) errors.extraHeaders = t("settings.channel.error.headers");
  return errors;
}

/**
 * Credential rule shared by the models probe, the test and the save: keep the
 * stored key only when the base is unchanged and the operator left the field
 * blank; otherwise send the typed key, or an explicit "" (keyless) when there is
 * nothing worth reusing. The server derives the same answer from the same inputs.
 */
function credentialField(snapshot: LlmChannelSnapshot, draft: ChannelDraft): { apiKey?: string } {
  const typed = draft.apiKey.trim();
  if (typed !== "") return { apiKey: typed };
  if (snapshot.apiKeySet && sameChannelBase(snapshot.apiBase, draft.apiBase)) return {};
  return { apiKey: "" };
}

/** Configuration half of every channel request, shared by probe and save. */
function configField(draft: ChannelDraft): Record<string, unknown> {
  const context = readTokenField(
    draft.contextWindowTokens,
    LLM_CHANNEL_LIMITS.contextWindowTokens.min,
    LLM_CHANNEL_LIMITS.contextWindowTokens.max,
  );
  const output = readTokenField(
    draft.maxOutputTokens,
    LLM_CHANNEL_LIMITS.maxOutputTokens.min,
    LLM_CHANNEL_LIMITS.maxOutputTokens.max,
  );
  return {
    protocol: draft.protocol,
    ...(context !== null ? { contextWindowTokens: context } : {}),
    ...(output !== null ? { maxOutputTokens: output } : {}),
    ...headersField(draft),
  };
}

/**
 * Headers on the wire. Only rows the operator actually typed are sent, so an
 * untouched "value kept" row (name from the snapshot, empty value) leaves the
 * stored value alone instead of blanking it — the same reuse rule as the key.
 */
function headersField(draft: ChannelDraft): Record<string, unknown> {
  if (!draft.extraHeaders.some((row) => row.name.trim() !== "")) return {};
  return { extraHeaders: headerMap(draft.extraHeaders) };
}

/**
 * Options for the model dropdown: whatever the endpoint returned, plus the model
 * already stored or picked, so a selection survives a reload before the next fetch.
 * Order is preserved and duplicates collapse.
 */
export function channelModelOptions(
  ...candidates: Array<string | null | undefined | readonly string[]>
): string[] {
  const options: string[] = [];
  for (const candidate of candidates) {
    const values = typeof candidate === "string" ? [candidate] : (candidate ?? []);
    for (const value of values) {
      const model = typeof value === "string" ? value.trim() : "";
      if (model && !options.includes(model)) options.push(model);
    }
  }
  return options;
}

export type ChannelLoadOutcome =
  | { ok: true; snapshot: LlmChannelSnapshot }
  | { ok: false; status: number };

/** GET /api/settings/llm-channel — current channel, or a status to localize. */
export async function loadChannel(): Promise<ChannelLoadOutcome> {
  let response: Response;
  try {
    response = await fetch(CHANNEL_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return { ok: false, status: CHANNEL_STATUS.network };
  }

  const payload = await readJsonObject(response);
  if (!response.ok) return { ok: false, status: response.status };
  const snapshot = parseChannelSnapshot(payload);
  return snapshot ? { ok: true, snapshot } : { ok: false, status: 500 };
}

export type ChannelModelsOutcome =
  | { ok: true; models: string[]; manual: boolean }
  | { ok: false; status: number; fields: ChannelFieldErrors };

/** POST /api/settings/llm-channel/models — list the endpoint's models. */
export async function fetchChannelModels(
  snapshot: LlmChannelSnapshot,
  draft: ChannelDraft,
): Promise<ChannelModelsOutcome> {
  let response: Response;
  try {
    response = await fetch(CHANNEL_MODELS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiBase: draft.apiBase.trim(),
        protocol: draft.protocol,
        ...credentialField(snapshot, draft),
        // An endpoint that requires a plain header will not answer its listing
        // without it, so the draft's rows ride along (blank value = reuse stored).
        ...headersField(draft),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: CHANNEL_STATUS.network, fields: {} };
  }

  const body = await readJsonObject(response);
  if (!response.ok) {
    return { ok: false, status: response.status, fields: channelFields(body) };
  }
  // A payload without `models` is not "an empty list": report a server problem
  // instead of letting the dropdown claim the endpoint advertises nothing.
  const models = Array.isArray(body?.models)
    ? body.models.filter((model): model is string => typeof model === "string" && model.trim() !== "")
    : null;
  if (!models) return { ok: false, status: 500, fields: {} };
  return { ok: true, models, manual: body?.manual === true };
}

export type ChannelTestOutcome = { ok: true } | { ok: false; detail: string; status: number };

/**
 * POST /api/settings/llm-channel/test — one minimal upstream request for the
 * unsaved draft. The server returns `{ ok, detail }` with fixed wording; the
 * detail is a sentence about the endpoint, never upstream text.
 */
export async function testChannel(
  snapshot: LlmChannelSnapshot,
  draft: ChannelDraft,
  t: ChannelTranslateFn,
): Promise<ChannelTestOutcome> {
  let response: Response;
  try {
    response = await fetch(CHANNEL_TEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiBase: draft.apiBase.trim(),
        model: draft.model.trim(),
        ...credentialField(snapshot, draft),
        ...configField(draft),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: CHANNEL_STATUS.network, detail: t(channelErrorKey(CHANNEL_STATUS.network)) };
  }

  const body = await readJsonObject(response);
  if (response.ok && body?.ok === true) return { ok: true };
  const detail = typeof body?.detail === "string" && body.detail ? body.detail : t(channelErrorKey(response.status));
  return { ok: false, status: response.status, detail };
}

export type ChannelSaveOutcome =
  | { ok: true; snapshot: LlmChannelSnapshot; globalModelOverride: string }
  | { ok: false; status: number; fields: ChannelFieldErrors };

/** PUT /api/settings/llm-channel — register the model and persist the channel. */
export async function saveChannel(
  snapshot: LlmChannelSnapshot,
  draft: ChannelDraft,
): Promise<ChannelSaveOutcome> {
  return putChannel({
    apiBase: draft.apiBase.trim(),
    ...credentialField(snapshot, draft),
    model: draft.model.trim(),
    ...configField(draft),
  });
}

/** PUT { model: "" } — drop the channel, its key, its headers and its alias. */
export async function removeChannel(): Promise<ChannelSaveOutcome> {
  return putChannel({ apiBase: "", apiKey: "", model: "" });
}

/**
 * The PUT envelope carries the effective global override, which is exactly what the
 * page adopts: a registered channel yields its proxy alias, a removal yields "" only
 * when the stored override still pointed at this channel's alias.
 */
async function putChannel(body: Record<string, unknown>): Promise<ChannelSaveOutcome> {
  let response: Response;
  try {
    response = await fetch(CHANNEL_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: CHANNEL_STATUS.network, fields: {} };
  }

  const payload = await readJsonObject(response);
  if (!response.ok) {
    return { ok: false, status: response.status, fields: channelFields(payload) };
  }

  const stored = parseChannelSnapshot(payload);
  if (!stored || typeof payload?.globalModelOverride !== "string") {
    return { ok: false, status: 500, fields: {} };
  }
  return { ok: true, snapshot: stored, globalModelOverride: payload.globalModelOverride };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const payload: unknown = await response.json().catch(() => null);
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function channelFields(body: Record<string, unknown> | null): ChannelFieldErrors {
  const fields: ChannelFieldErrors = {};
  const reported = body?.fields;
  if (typeof reported !== "object" || reported === null || Array.isArray(reported)) return fields;
  for (const [key, value] of Object.entries(reported as Record<string, unknown>)) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

/**
 * Localized wording for a failed channel request. Upstream error text is never
 * shown: the status decides the sentence, the `fields` map only marks inputs.
 */
export function channelErrorKey(status: number): TranslationKey {
  if (status === 401) return "settings.channel.error.unauthorized";
  if (status === 404) return "settings.channel.error.missingRoute";
  if (status === CHANNEL_STATUS.upstream) return "settings.channel.error.upstream";
  if (status === CHANNEL_STATUS.network) return "settings.channel.error.network";
  if (status >= 500) return "settings.channel.error.server";
  return "settings.channel.error.invalid";
}

/** Replace server field messages with localized copy, keeping the fields the server named. */
export function localizeChannelFields(
  fields: ChannelFieldErrors,
  t: ChannelTranslateFn,
): ChannelFieldErrors {
  const localized: ChannelFieldErrors = {};
  const known: Record<string, TranslationKey> = {
    apiBase: "settings.channel.error.apiBase",
    apiKey: "settings.channel.error.apiKey",
    model: "settings.channel.error.model",
    protocol: "settings.channel.error.protocol",
    contextWindowTokens: "settings.channel.error.context",
    maxOutputTokens: "settings.channel.error.tokens",
    extraHeaders: "settings.channel.error.headers",
  };
  for (const field of Object.keys(fields)) {
    localized[field] = known[field] ? t(known[field]) : t("settings.channel.error.invalid");
  }
  return localized;
}

/** Protocol option list for the select: every protocol this build registers. */
export function channelProtocolOptions(snapshot: LlmChannelSnapshot): ChannelProtocol[] {
  return snapshot.protocols.length > 0 ? snapshot.protocols : [...CHANNEL_PROTOCOLS];
}
