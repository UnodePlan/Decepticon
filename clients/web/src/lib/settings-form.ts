/**
 * Client-side form model for the Settings page.
 *
 * The server owns the persisted contract (`@/lib/system-settings`); this module
 * mirrors its rules so the operator sees field errors before a request leaves
 * the browser, and turns the editable draft into a partial `SettingsPatch`.
 *
 * Secrets: `llmProxyApiKey` only ever travels browser → server. The draft holds
 * whatever the operator typed and the snapshot never carries the key back, so
 * the field is always rendered empty.
 */

import {
  AUTH_METHODS,
  MODEL_PROFILES,
  MODEL_ROLE_IDS,
  REASONING_EFFORTS,
  SETTINGS_LIMITS,
  TELEMETRY_MODES,
  type SettingsPatch,
  type SettingsSnapshot,
} from "./system-settings";
import type { TranslationKey, TranslationParams } from "./i18n";

export type TranslateFn = (key: TranslationKey, params?: TranslationParams) => string;

/** Numeric settings are edited as text so partial input stays typeable. */
export interface SettingsDraft {
  globalModelOverride: string;
  modelOverrides: Record<string, string>;
  language: SettingsSnapshot["language"];
  langGraphBrowserUrl: string;
  terminalBrowserUrl: string;
  /** Write-only: empty means "leave the stored key untouched". */
  llmProxyApiKey: string;
  /** Explicit request to delete the stored key. */
  clearProxyKey: boolean;
  reasoningEffort: SettingsSnapshot["reasoningEffort"];
  /** Text like the other numerics; `""` clears the stored override. */
  llmMaxOutputTokens: string;
  llmDisableStreaming: boolean;
  budgetEngagementUsd: string;
  budgetPerAgentUsd: string;
  budgetSoftWarnAtPct: string;
  hitlEnabled: boolean;
}

/** Field-keyed validation messages, rendered verbatim under each input. */
export type FieldErrors = Record<string, string>;

export interface ModelTestResult {
  ok: boolean;
  model: string;
  detail: string;
}

export function draftFromSnapshot(snapshot: SettingsSnapshot): SettingsDraft {
  return {
    globalModelOverride: snapshot.globalModelOverride,
    modelOverrides: { ...snapshot.modelOverrides },
    language: snapshot.language,
    langGraphBrowserUrl: snapshot.langGraphBrowserUrl,
    terminalBrowserUrl: snapshot.terminalBrowserUrl,
    llmProxyApiKey: "",
    clearProxyKey: false,
    reasoningEffort: snapshot.reasoningEffort,
    llmMaxOutputTokens: String(snapshot.llmMaxOutputTokens),
    llmDisableStreaming: snapshot.llmDisableStreaming,
    budgetEngagementUsd: snapshot.budgetEngagementUsd === null ? "" : String(snapshot.budgetEngagementUsd),
    budgetPerAgentUsd: snapshot.budgetPerAgentUsd === null ? "" : String(snapshot.budgetPerAgentUsd),
    budgetSoftWarnAtPct: String(snapshot.budgetSoftWarnAtPct),
    hitlEnabled: snapshot.hitlEnabled,
  };
}

/**
 * Guard the GET payload before it becomes form state: a malformed response is
 * an error the page can report, not a render crash.
 */
export function parseSettingsSnapshot(payload: unknown): SettingsSnapshot | null {
  if (typeof payload !== "object" || payload === null) return null;
  const source = payload as Record<string, unknown>;

  const overrides = source.modelOverrides;
  if (
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides) ||
    Object.values(overrides as Record<string, unknown>).some((value) => typeof value !== "string")
  ) {
    return null;
  }
  for (const key of [
    "globalModelOverride",
    "workspacePath",
    "langGraphBrowserUrl",
    "terminalBrowserUrl",
    "deploymentWebPort",
  ] as const) {
    if (typeof source[key] !== "string") return null;
  }
  if (!(MODEL_PROFILES as readonly unknown[]).includes(source.modelProfile)) return null;
  if (source.language !== "en" && source.language !== "zh") return null;
  if (typeof source.llmTimeoutSeconds !== "number" || typeof source.llmMaxRetries !== "number") return null;
  if (typeof source.llmProxyApiKeySet !== "boolean" || typeof source.databaseConfigured !== "boolean") {
    return null;
  }
  if (source.authMode !== "password" && source.authMode !== "disabled" && source.authMode !== "unconfigured") {
    return null;
  }
  if (typeof source.llmMaxOutputTokens !== "number" || typeof source.llmDisableStreaming !== "boolean") {
    return null;
  }
  if (!(REASONING_EFFORTS as readonly unknown[]).includes(source.reasoningEffort)) return null;
  if (
    !Array.isArray(source.llmExtraHeaderNames) ||
    source.llmExtraHeaderNames.some((name) => typeof name !== "string")
  ) {
    return null;
  }
  if (typeof source.hitlEnabled !== "boolean" || typeof source.budgetSoftWarnAtPct !== "number") return null;
  for (const key of ["budgetEngagementUsd", "budgetPerAgentUsd"] as const) {
    const value = source[key];
    if (value !== null && typeof value !== "number") return null;
  }
  if (!(TELEMETRY_MODES as readonly unknown[]).includes(source.telemetryMode)) return null;
  if (
    !Array.isArray(source.authPriority) ||
    source.authPriority.some((method) => !(AUTH_METHODS as readonly unknown[]).includes(method))
  ) {
    return null;
  }
  if (typeof source.skillogyEmbedModel !== "string") return null;
  return source as unknown as SettingsSnapshot;
}

/**
 * Validate the draft before it leaves the browser.
 *
 * Only fields that differ from the loaded snapshot are checked: the snapshot may
 * legitimately hold values the PUT endpoint would reject (e.g. the relative
 * `/runtime` LangGraph default), and an untouched read-only-in-practice value
 * must never block saving a different card.
 */
export function validateDraft(
  snapshot: SettingsSnapshot,
  draft: SettingsDraft,
  t: TranslateFn,
): FieldErrors {
  const errors: FieldErrors = {};
  const patch = buildPatch(snapshot, draft);

  if (patch.globalModelOverride !== undefined && patch.globalModelOverride !== "") {
    const model = patch.globalModelOverride;
    if (model.length > SETTINGS_LIMITS.modelIdLength || /\s/.test(model)) {
      errors.globalModelOverride = t("settings.model.error.model");
    }
  }

  if (patch.modelOverrides) {
    const entries = Object.entries(patch.modelOverrides);
    if (entries.some(([role]) => !MODEL_ROLE_IDS.includes(role))) {
      errors.modelOverrides = t("settings.model.error.role");
    } else if (
      entries.some(
        ([, model]) => model.length > SETTINGS_LIMITS.modelIdLength || /\s/.test(model),
      )
    ) {
      errors.modelOverrides = t("settings.model.error.model");
    }
  }

  const maxOutput = patch.llmMaxOutputTokens;
  if (typeof maxOutput === "number") {
    const { min, max } = SETTINGS_LIMITS.llmMaxOutputTokens;
    if (!Number.isInteger(maxOutput) || maxOutput < min || maxOutput > max) {
      errors.llmMaxOutputTokens = t("settings.models.error.maxOutput", { min, max });
    }
  }

  const caps: Array<[string, TranslationKey]> = [
    ["budgetEngagementUsd", "settings.guardrails.error.budget"],
    ["budgetPerAgentUsd", "settings.guardrails.error.budget"],
  ];
  for (const [field, key] of caps) {
    const value = (patch as Record<string, number | "" | undefined>)[field];
    // `undefined` = untouched, `""` = the operator cleared the override.
    if (typeof value !== "number") continue;
    const { min, max } = SETTINGS_LIMITS.budgetUsd;
    if (!Number.isFinite(value) || value < min || value > max) {
      errors[field] = t(key, { min, max });
    }
  }

  const softWarn = patch.budgetSoftWarnAtPct;
  // `0` and blank both mean "keep the deployment threshold"; the server normalises
  // a literal 0 to the same row deletion the blank field asks for.
  if (typeof softWarn === "number" && !(softWarn === 0)) {
    if (!Number.isFinite(softWarn) || softWarn < 0 || softWarn > 100) {
      const { min, max } = SETTINGS_LIMITS.budgetSoftWarnAtPct;
      errors.budgetSoftWarnAtPct = t("settings.guardrails.error.softWarn", { min, max });
    }
  }

  const urls: Array<[string, readonly string[], TranslationKey]> = [
    ["langGraphBrowserUrl", ["http:", "https:"], "settings.runtime.error.langGraphUrl"],
    ["terminalBrowserUrl", ["ws:", "wss:"], "settings.runtime.error.terminalUrl"],
  ];
  for (const [field, protocols, key] of urls) {
    const raw = (patch as Record<string, string | undefined>)[field];
    if (raw === undefined || raw === "") continue; // empty clears the DB override
    if (raw.length > SETTINGS_LIMITS.browserUrlLength) {
      errors[field] = t(key);
      continue;
    }
    try {
      const parsed = new URL(raw);
      if (!protocols.includes(parsed.protocol) || parsed.host === "") errors[field] = t(key);
    } catch {
      errors[field] = t(key);
    }
  }

  return errors;
}

/**
 * Diff the draft against the loaded snapshot: only touched keys travel to the
 * server, so saving one card never rewrites settings the operator never opened.
 */
export function buildPatch(snapshot: SettingsSnapshot, draft: SettingsDraft): SettingsPatch {
  const patch: SettingsPatch = {};

  const global = draft.globalModelOverride.trim();
  if (global !== snapshot.globalModelOverride) patch.globalModelOverride = global;

  const overrides: Record<string, string> = {};
  for (const [role, model] of Object.entries(draft.modelOverrides)) overrides[role] = model.trim();
  const draftRoles = Object.keys(overrides);
  const snapshotRoles = Object.keys(snapshot.modelOverrides);
  const overridesChanged =
    draftRoles.length !== snapshotRoles.length ||
    draftRoles.some((role) => overrides[role] !== snapshot.modelOverrides[role]);
  if (overridesChanged) patch.modelOverrides = overrides;

  if (draft.language !== snapshot.language) patch.language = draft.language;

  if (draft.langGraphBrowserUrl.trim() !== snapshot.langGraphBrowserUrl) {
    patch.langGraphBrowserUrl = draft.langGraphBrowserUrl.trim();
  }
  if (draft.terminalBrowserUrl.trim() !== snapshot.terminalBrowserUrl) {
    patch.terminalBrowserUrl = draft.terminalBrowserUrl.trim();
  }

  if (draft.clearProxyKey) patch.llmProxyApiKey = "";
  else if (draft.llmProxyApiKey.trim()) patch.llmProxyApiKey = draft.llmProxyApiKey.trim();

  if (draft.reasoningEffort !== snapshot.reasoningEffort) patch.reasoningEffort = draft.reasoningEffort;
  if (draft.llmMaxOutputTokens.trim() !== String(snapshot.llmMaxOutputTokens)) {
    patch.llmMaxOutputTokens = toNumberOrEmpty(draft.llmMaxOutputTokens);
  }
  if (draft.llmDisableStreaming !== snapshot.llmDisableStreaming) {
    patch.llmDisableStreaming = draft.llmDisableStreaming;
  }
  if (draft.hitlEnabled !== snapshot.hitlEnabled) patch.hitlEnabled = draft.hitlEnabled;

  for (const field of ["budgetEngagementUsd", "budgetPerAgentUsd"] as const) {
    const draftValue = draft[field].trim();
    const snapshotValue = snapshot[field] === null ? "" : String(snapshot[field]);
    if (draftValue !== snapshotValue) patch[field] = toNumberOrEmpty(draftValue);
  }
  if (draft.budgetSoftWarnAtPct.trim() !== String(snapshot.budgetSoftWarnAtPct)) {
    patch.budgetSoftWarnAtPct = toNumberOrEmpty(draft.budgetSoftWarnAtPct);
  }

  return patch;
}

/** A numeric draft field: `""` asks the server to clear the row, junk stays junk for validation. */
function toNumberOrEmpty(value: string): number | "" {
  const trimmed = value.trim();
  return trimmed === "" ? "" : Number(trimmed);
}

export function isDirty(snapshot: SettingsSnapshot, draft: SettingsDraft): boolean {
  return Object.keys(buildPatch(snapshot, draft)).length > 0;
}

/** Confirm a model is registered on the LiteLLM proxy; never touches the key. */
export async function testModelRegistration(model: string, role?: string): Promise<ModelTestResult> {
  const response = await fetch("/api/settings/test-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(role ? { model, role } : { model }),
    signal: AbortSignal.timeout(10000),
  });

  const payload: unknown = await response.json().catch(() => null);
  const body =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

  if (!response.ok) {
    const detail = body && typeof body.error === "string" && body.error ? body.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!body || typeof body.ok !== "boolean") throw new Error("Invalid test-model response");
  return {
    ok: body.ok,
    model: typeof body.model === "string" && body.model ? body.model : model,
    detail: typeof body.detail === "string" ? body.detail : "",
  };
}

export interface SaveOutcome {
  snapshot: SettingsSnapshot | null;
  fields: FieldErrors;
  message: string;
}

/** PUT the partial patch; classify failures so the page can localize them. */
export async function saveSettingsPatch(patch: SettingsPatch, t: TranslateFn): Promise<SaveOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    return { snapshot: null, fields: {}, message: t("settings.error.network") };
  }

  const payload: unknown = await response.json().catch(() => null);
  const body =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

  if (!response.ok) {
    const fields: FieldErrors = {};
    const reported = body?.fields;
    if (typeof reported === "object" && reported !== null && !Array.isArray(reported)) {
      for (const [key, value] of Object.entries(reported as Record<string, unknown>)) {
        if (typeof value === "string") fields[key] = value;
      }
    }
    // The status decides the operator-facing wording: upstream error text is not
    // translated, so it never reaches the UI as the primary message.
    const reason: TranslationKey =
      response.status === 401
        ? "settings.error.unauthorized"
        : response.status >= 500
          ? "settings.error.server"
          : "settings.error.invalid";
    return { snapshot: null, fields, message: t(reason) };
  }

  const snapshot = parseSettingsSnapshot(payload);
  if (!snapshot) return { snapshot: null, fields: {}, message: t("settings.error.server") };
  return { snapshot, fields: {}, message: "" };
}
