/**
 * System settings storage contract — the DB rows, the PUT validator and the
 * LangGraph run overrides.
 *
 * The shared vocabulary it builds on lives in `./settings-contract` (pure
 * enums/types/limits, also imported by the browser cards) and the deployment
 * half in `./system-settings-environment`. This module is PURE as well: no
 * `next/*`, no Prisma, no node builtins — it is imported by the route handlers
 * (via `system-settings-runtime`) and by the settings UI.
 *
 * Storage model (see `prisma/schema.prisma` → `SystemSetting`):
 *   key   = the snake_case key from {@link SETTING_KEYS}
 *   value = a string (numbers/JSON stringified)
 *
 * Deployment-level configuration (compose ports, DATABASE_URL, auth bootstrap)
 * is injected by the launcher at container start. It is reported read-only in
 * the snapshot so the UI can label it "takes effect after restart" instead of
 * pretending a `.env` edit was hot-reloaded.
 */

import {
  DEFAULT_SETTINGS,
  FALSY,
  HTTP_PROTOCOLS,
  MODEL_ID_ERROR,
  MODEL_PROFILES,
  REASONING_EFFORTS,
  SETTING_KEYS,
  SETTINGS_LANGUAGES,
  SETTINGS_LIMITS,
  SETTINGS_READONLY_FIELDS,
  TRUTHY,
  WS_PROTOCOLS,
  WRITABLE_SETTING_FIELDS,
  fromEnum,
  isZero,
  parseInteger,
  parseModelOverrides,
  parseNumber,
  validBrowserUrl,
  type ReasoningEffort,
  type SettingRow,
  type SettingsDefaults,
  type SettingsEnv,
  type SettingsPatch,
  type SettingsPatchResult,
  type WritableSettingField,
} from "./settings-contract";
import { settingsEnvironment } from "./system-settings-environment";

export * from "./settings-contract";
export * from "./system-settings-environment";

// ── Extra headers (owned by `./settings-headers`) ─────────────────────

/**
 * The extra-header rule lives in the `./settings-headers` leaf, and is re-exported
 * here so every existing importer keeps its single import site.
 *
 * Why the headers are NOT storable: values are credentials-adjacent, the run
 * input round-trips through the LangGraph checkpoint, and the agent core reads
 * `DECEPTICON_LLM_EXTRA_HEADERS` from its OWN environment when it builds a
 * model. The dashboard therefore REPORTS the configured header NAMES (never a
 * value) and rejects a PUT of the field — that is the only honest boundary.
 */
export {
  EXTRA_HEADER_LIMITS,
  FORBIDDEN_LLM_HEADER_NAMES,
  extraHeaderNames,
  isValidExtraHeaderName,
  parseExtraHeadersEnv,
  sanitizeExtraHeaders,
  validateExtraHeaders,
} from "./settings-headers";

// ── Parsing (DB rows → effective settings) ───────────────────────────

/**
 * Merge stored rows over the deployment defaults. Missing, unknown or invalid
 * values fall back to the default instead of throwing: a hand-edited row must
 * never take the settings page down.
 */
export function parseSettingsRows(
  rows: Iterable<SettingRow>,
  env: SettingsEnv = process.env,
): SettingsDefaults {
  const stored = new Map<string, string>();
  for (const row of rows) {
    if (row && typeof row.key === "string" && typeof row.value === "string") {
      stored.set(row.key, row.value);
    }
  }

  const deployment = settingsEnvironment(env);
  const storedLanguage = fromEnum(stored.get(SETTING_KEYS.language), SETTINGS_LANGUAGES);

  return {
    // Startup-scoped: the effective value is ALWAYS the deployment environment,
    // because the LangGraph process resolves `DECEPTICON_MODEL_PROFILE` from its
    // own env at start. A legacy row is not read, so the page can never report a
    // profile the agent does not use.
    modelProfile: fromEnum(deployment.modelProfile, MODEL_PROFILES) ?? DEFAULT_SETTINGS.modelProfile,
    // `DECEPTICON_LANGUAGE` supports more locales than the dashboard has
    // translations for; an unsupported deployment value falls back to English
    // (the root layout normalises the cookie/default pair the same way).
    language: storedLanguage ?? fromEnum(deployment.language, SETTINGS_LANGUAGES) ?? DEFAULT_SETTINGS.language,
    globalModelOverride: storedModelId(stored.get(SETTING_KEYS.globalModelOverride)) ?? "",
    modelOverrides: storedModelOverrides(stored.get(SETTING_KEYS.modelOverrides)) ?? {},
    // Startup-scoped like the profile: the agent core reads
    // `DECEPTICON_LLM__TIMEOUT` / `DECEPTICON_LLM__MAX_RETRIES` from its own
    // environment, so a legacy row is reported from the deployment instead.
    llmTimeoutSeconds: deployment.llmTimeoutSeconds,
    llmMaxRetries: deployment.llmMaxRetries,
    // Deployment-owned: a legacy `workspace_path` row is deliberately NOT read,
    // because nothing consumes it — the PTY, engagement creation and the file
    // APIs all resolve `WORKSPACE_PATH` from their own environment, so showing a
    // stored value here would claim a setting the agent never applies.
    workspacePath: deployment.workspacePath,
    langGraphBrowserUrl:
      storedBrowserUrl(stored.get(SETTING_KEYS.langGraphBrowserUrl), HTTP_PROTOCOLS) ?? deployment.langGraphBrowserUrl,
    terminalBrowserUrl:
      storedBrowserUrl(stored.get(SETTING_KEYS.terminalBrowserUrl), WS_PROTOCOLS) ?? deployment.terminalBrowserUrl,
    reasoningEffort:
      fromEnum(stored.get(SETTING_KEYS.reasoningEffort), REASONING_EFFORTS) ?? deployment.reasoningEffort,
    llmMaxOutputTokens:
      storedInteger(stored.get(SETTING_KEYS.llmMaxOutputTokens), SETTINGS_LIMITS.llmMaxOutputTokens) ??
      deployment.llmMaxOutputTokens,
    llmDisableStreaming:
      storedBoolean(stored.get(SETTING_KEYS.llmDisableStreaming)) ?? deployment.llmDisableStreaming,
    // Names only, and only from the deployment env: `llm/factory.py` parses the
    // actual headers inside the agent process, and a legacy stored row is
    // ignored so the page cannot claim a header policy the agent never applies.
    llmExtraHeaderNames: deployment.llmExtraHeaderNames,
    // `undefined` (no usable row, or a stored `0`) falls back to the deployment
    // cap: a run input may only tighten a cap, so a 0 is not a real override.
    budgetEngagementUsd:
      storedCapUsd(stored.get(SETTING_KEYS.budgetEngagementUsd)) ?? deployment.budgetEngagementUsd,
    budgetPerAgentUsd:
      storedCapUsd(stored.get(SETTING_KEYS.budgetPerAgentUsd)) ?? deployment.budgetPerAgentUsd,
    budgetSoftWarnAtPct:
      storedPositiveDecimal(stored.get(SETTING_KEYS.budgetSoftWarnAtPct), SETTINGS_LIMITS.budgetSoftWarnAtPct) ??
      deployment.budgetSoftWarnAtPct,
    hitlEnabled: storedBoolean(stored.get(SETTING_KEYS.hitlEnabled)) ?? deployment.hitlEnabled,
  };
}

/** A stored boolean row (`true`/`1`/`yes`/`on` ↔ `false`/`0`/`no`/`off`), else null. */
function storedBoolean(value: string | undefined): boolean | null {
  const raw = value?.trim().toLowerCase() ?? "";
  if (Object.hasOwn(TRUTHY, raw)) return true;
  if (Object.hasOwn(FALSY, raw)) return false;
  return null;
}

/** A stored USD cap: `undefined` = no usable row, so the deployment cap governs. */
function storedCapUsd(value: string | undefined): number | undefined {
  // A stored `0` is not a usable override: the run plane drops it (a run may only
  // tighten a cap), so reporting it would show a limit the agent never enforces.
  return storedPositiveDecimal(value, SETTINGS_LIMITS.budgetUsd) ?? undefined;
}

/** A finite, in-range number from a stored row, else null. */
function storedDecimal(value: string | undefined, bounds: { min: number; max: number }): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max ? parsed : null;
}

/** Like {@link storedDecimal}, but a stored `0` is not an override ("keep the deployment value"). */
function storedPositiveDecimal(value: string | undefined, bounds: { min: number; max: number }): number | null {
  const parsed = storedDecimal(value, bounds);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** Stored rows are trusted less than request bodies: bad values silently fall back. */
function storedModelId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const id = value.trim();
  return id.length > SETTINGS_LIMITS.modelIdLength || /\s/.test(id) ? null : id;
}

function storedModelOverrides(value: string | undefined): Record<string, string> | null {
  if (value === undefined) return null;
  try {
    const parsed = parseModelOverrides(JSON.parse(value));
    return typeof parsed === "string" ? null : parsed;
  } catch {
    return null;
  }
}

function storedInteger(
  value: string | undefined,
  bounds: { min: number; max: number },
): number | null {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= bounds.min && parsed <= bounds.max ? parsed : null;
}

function storedBrowserUrl(value: string | undefined, protocols: readonly string[]): string | null {
  const url = value?.trim() ?? "";
  return validBrowserUrl(url, protocols) && url !== "" ? url : null;
}

/** Stored `llm_proxy_api_key`, trimmed; empty string when unset. */
export function storedApiKey(row: SettingRow | undefined): string {
  return typeof row?.value === "string" ? row.value.trim() : "";
}

/**
 * Existence-only view of a secret: the API and UI may learn *whether* a key is
 * stored, never any part of its value.
 */
export function maskSecretState(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// ── Validation (PUT payload) ─────────────────────────────────────────

/**
 * Validate a PUT body. Unknown fields (including the read-only snapshot fields)
 * are rejected rather than ignored: silently dropping a typo'd key is how an
 * operator ends up believing a setting was saved.
 */
export function validateSettingsPatch(input: unknown): SettingsPatchResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Settings payload must be a JSON object" };
  }

  const body = input as Record<string, unknown>;
  const fields: Record<string, string> = {};

  for (const key of Object.keys(body)) {
    // `Object.hasOwn`, not `in`: prototype keys ("constructor") are not settings.
    if (Object.hasOwn(SETTING_KEYS, key)) {
      // A known key that is no longer writable (`workspacePath`) is rejected with
      // the same wording as the snapshot-only read-only fields, so a client
      // cannot mistake it for editable.
      if ((SETTINGS_READONLY_FIELDS as readonly string[]).includes(key)) fields[key] = "read-only field";
      continue;
    }
    fields[key] = (SETTINGS_READONLY_FIELDS as readonly string[]).includes(key)
      ? "read-only field"
      : "unknown field";
  }

  const patch: SettingsPatch = {};

  for (const field of WRITABLE_SETTING_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    const asString = typeof value === "string" ? value : null;

    switch (field) {
      case "language": {
        // Empty string = reset to the deployment default (DECEPTICON_LANGUAGE).
        if (asString === "") patch.language = "";
        else {
          const language = fromEnum(asString, SETTINGS_LANGUAGES);
          if (language) patch.language = language;
          else fields[field] = `must be one of ${SETTINGS_LANGUAGES.join(", ")} or "" to reset`;
        }
        break;
      }
      case "globalModelOverride": {
        const id = typeof value === "string" ? value.trim() : null;
        if (id === null || id.length > SETTINGS_LIMITS.modelIdLength || /\s/.test(id)) {
          fields[field] = MODEL_ID_ERROR;
        } else {
          patch.globalModelOverride = id;
        }
        break;
      }
      case "modelOverrides": {
        const overrides = parseModelOverrides(value);
        if (typeof overrides === "string") fields[field] = overrides;
        else patch.modelOverrides = overrides;
        break;
      }
      case "langGraphBrowserUrl": {
        const url = asString?.trim() ?? null;
        if (url === null || !validBrowserUrl(url, HTTP_PROTOCOLS)) fields[field] = "must be an http(s) URL";
        else patch.langGraphBrowserUrl = url;
        break;
      }
      case "terminalBrowserUrl": {
        const url = asString?.trim() ?? null;
        if (url === null || !validBrowserUrl(url, WS_PROTOCOLS)) fields[field] = "must be a ws(s) URL";
        else patch.terminalBrowserUrl = url;
        break;
      }
      case "llmProxyApiKey": {
        const key = asString?.trim() ?? null;
        if (key === null) fields[field] = "must be a string";
        else if (key.length > SETTINGS_LIMITS.apiKeyLength) {
          fields[field] = `must be at most ${SETTINGS_LIMITS.apiKeyLength} characters`;
        } else if (/\s/.test(key)) fields[field] = "must not contain whitespace";
        // Empty string = clear the stored override.
        else patch.llmProxyApiKey = key;
        break;
      }
      case "reasoningEffort": {
        // Empty string = clear, back to DECEPTICON_LLM_REASONING_EFFORT / none.
        if (asString === "") patch.reasoningEffort = "";
        else {
          const effort = fromEnum(asString, REASONING_EFFORTS);
          if (effort) patch.reasoningEffort = effort;
          else fields[field] = `must be one of ${REASONING_EFFORTS.join(", ")} or "" to reset`;
        }
        break;
      }
      case "llmMaxOutputTokens": {
        // Empty string = clear the stored value, back to the deployment default.
        // A literal `0` is NOT a reset: it is below the documented floor.
        if (asString === "") {
          patch.llmMaxOutputTokens = "";
          break;
        }
        const parsed = parseInteger(value, SETTINGS_LIMITS.llmMaxOutputTokens);
        if (typeof parsed === "string") fields[field] = parsed;
        else patch.llmMaxOutputTokens = parsed;
        break;
      }
      case "budgetSoftWarnAtPct": {
        // Empty string — or `0`, which means "keep the deployment threshold" —
        // clears the stored row.
        if (asString === "" || isZero(value)) {
          patch.budgetSoftWarnAtPct = "";
          break;
        }
        const parsed = parseNumber(value, SETTINGS_LIMITS.budgetSoftWarnAtPct);
        if (typeof parsed === "string") fields[field] = parsed;
        else patch.budgetSoftWarnAtPct = parsed;
        break;
      }
      case "budgetEngagementUsd":
      case "budgetPerAgentUsd": {
        // Empty string = clear the row, back to the deployment cap.
        //
        // `0` normalises to the same thing: a run input may only ever RAISE the
        // posture, so an explicit 0 cannot erase a cap the deployment set
        // (`usableBudgetUsd` in `./run-settings` drops it for exactly that reason).
        // Storing it separately would render a cap the agent does not enforce.
        if (asString === "" || isZero(value)) {
          patch[field] = "";
          break;
        }
        const parsed = parseNumber(value, SETTINGS_LIMITS.budgetUsd);
        if (typeof parsed === "string") fields[field] = parsed;
        else patch[field] = parsed;
        break;
      }
      case "llmDisableStreaming":
      case "hitlEnabled": {
        if (typeof value !== "boolean") fields[field] = "must be a boolean";
        else patch[field] = value;
        break;
      }
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, error: "Invalid settings", fields };
  if (Object.keys(patch).length === 0) return { ok: false, error: "No settings provided" };
  return { ok: true, patch };
}

/**
 * Encode a validated patch value for storage. `null` = delete the row so the
 * deployment default applies again.
 */
export function encodeSettingValue(field: WritableSettingField, value: unknown): string | null {
  switch (field) {
    case "modelOverrides": {
      const entries = Object.entries((value ?? {}) as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
      );
      return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null;
    }
    case "llmMaxOutputTokens":
    case "budgetSoftWarnAtPct":
      return typeof value === "number" ? String(value) : null;
    case "budgetEngagementUsd":
    case "budgetPerAgentUsd":
      // A cap of `0` is not storable: it means "no per-run override", and the row
      // would otherwise report a limit the agent never enforces.
      return typeof value === "number" && value > 0 ? String(value) : null;
    case "llmDisableStreaming":
    case "hitlEnabled":
      return typeof value === "boolean" ? String(value) : null;
    default:
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }
}

// ── Run overrides ────────────────────────────────────────────────────

/**
 * LangGraph run fields derived from the saved settings.
 *
 * The model fields are consumed by the agent's `ModelOverrideMiddleware`, keyed
 * by agent id (`role`); the rest are the `ModelOverridesState` channels declared
 * in `middleware/model_override.py`. Defaults and empty settings produce an
 * EMPTY object so existing run payloads stay byte-identical when nothing is
 * configured.
 *
 * Extra provider headers are deliberately absent: they are a startup-scoped
 * deployment value (`llm/factory.py::_resolve_extra_headers`), so the run input
 * never carries a header VALUE that would then be persisted into the LangGraph
 * checkpoint.
 *
 * NOTE: the live dashboard→agent path does not call this. `server/terminal-server.ts`
 * forwards the same values through `DECEPTICON_RUN_*`
 * (`src/lib/run-settings.ts`) and the CLI injects them into the run input, because
 * the dashboard has no run submitter of its own. This function is the direct
 * equivalent for a caller that posts run input itself; keep the two in step.
 */
export interface RunOverrides {
  model_override?: string;
  model_overrides?: Record<string, string>;
  /** Omitted for `none`, so models that reject the parameter never receive it. */
  reasoning_effort?: Exclude<ReasoningEffort, "none">;
  llm_max_output_tokens?: number;
  llm_disable_streaming?: boolean;
  /** Positive only: a run can tighten a cap, never remove the deployment's. */
  budget_engagement_usd?: number;
  budget_per_agent_usd?: number;
  /** FRACTION 0..1, matching `BudgetEnforcementMiddleware(soft_warn_at_pct=…)`. */
  budget_soft_warn_at_pct?: number;
  /** Can only enable the gate; a deployment that set it stays enabled. */
  hitl_enabled?: boolean;
}

export function buildRunOverrides(settings: SettingsDefaults): RunOverrides {
  const overrides: RunOverrides = {};
  const global = settings.globalModelOverride.trim();
  if (global) overrides.model_override = global;

  const perRole: Record<string, string> = {};
  for (const [role, model] of Object.entries(settings.modelOverrides ?? {})) {
    const id = typeof model === "string" ? model.trim() : "";
    if (id) perRole[role] = id;
  }
  if (Object.keys(perRole).length > 0) overrides.model_overrides = perRole;

  // Only values that differ from the documented defaults travel: a caller that
  // posts run input must not pin a model to 64k (or disable streaming) just
  // because the settings page had nothing to say about it.
  const { reasoningEffort } = settings;
  if (reasoningEffort !== "none") overrides.reasoning_effort = reasoningEffort;
  if (settings.llmMaxOutputTokens !== DEFAULT_SETTINGS.llmMaxOutputTokens) {
    overrides.llm_max_output_tokens = settings.llmMaxOutputTokens;
  }
  if (settings.llmDisableStreaming !== DEFAULT_SETTINGS.llmDisableStreaming) {
    overrides.llm_disable_streaming = settings.llmDisableStreaming;
  }
  // No `llm_extra_headers`: a header value must not enter the checkpoint, and the
  // agent process already resolved the deployment's headers from its own env.
  // A cap only ever RAISES the posture: `0`/absent sends nothing, because the run
  // input must not be able to erase a financial guardrail the deployment set.
  if (settings.budgetEngagementUsd !== null && settings.budgetEngagementUsd > 0) {
    overrides.budget_engagement_usd = settings.budgetEngagementUsd;
  }
  if (settings.budgetPerAgentUsd !== null && settings.budgetPerAgentUsd > 0) {
    overrides.budget_per_agent_usd = settings.budgetPerAgentUsd;
  }
  if (settings.budgetSoftWarnAtPct !== DEFAULT_SETTINGS.budgetSoftWarnAtPct) {
    overrides.budget_soft_warn_at_pct = settings.budgetSoftWarnAtPct / 100;
  }
  if (settings.hitlEnabled !== DEFAULT_SETTINGS.hitlEnabled) overrides.hitl_enabled = settings.hitlEnabled;

  return overrides;
}
