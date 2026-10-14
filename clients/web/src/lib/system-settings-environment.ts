/**
 * Deployment half of the settings contract — what the environment already says.
 *
 * `settingsEnvironment()` mirrors, field by field, the value the agent process (or
 * the launcher) resolves for itself, so the settings page can REPORT the truth
 * about a knob it cannot write. Pure enough for tests and the server bundle: it
 * only reads the object it is handed, defaulting to `process.env`.
 *
 * Header NAMES come from the leaf `./settings-headers` rule, so a protected name
 * can never be reported as configured; the re-export that keeps the single import
 * site lives in `./system-settings`.
 */

import {
  AUTH_METHODS,
  BUDGET_ENGAGEMENT_USD_ENV,
  BUDGET_PER_AGENT_USD_ENV,
  BUDGET_SOFT_WARN_AT_PCT_ENV,
  DECEPTICON_AUTH_PRIORITY_ENV,
  DECEPTICON_SKILLOGY_EMBED_MODEL_ENV,
  DECEPTICON_TELEMETRY_ENV,
  DEFAULT_SETTINGS,
  DEFAULT_SKILLOGY_EMBED_MODEL,
  HITL_ENABLED_ENV,
  LLM_DISABLE_STREAMING_ENV,
  LLM_EXTRA_HEADERS_ENV,
  LLM_MAX_RETRIES_ENV,
  LLM_MAX_TOKENS_ENV,
  LLM_REASONING_EFFORT_ENV,
  LLM_TIMEOUT_ENV,
  REASONING_EFFORTS,
  SETTINGS_LIMITS,
  TELEMETRY_MODES,
  fromEnum,
  parseInteger,
  TRUTHY,
  FALSY,
  type AuthMethodName,
  type AuthMode,
  type ReasoningEffort,
  type SettingsEnv,
  type SettingsEnvironment,
  type TelemetryMode,
} from "./settings-contract";
import { extraHeaderNames, parseExtraHeadersEnv } from "./settings-headers";

/** Read-only deployment facts surfaced in the snapshot. */
export function settingsEnvironment(env: SettingsEnv = process.env): SettingsEnvironment {
  const port = env.WEB_PORT?.trim() || "3000";
  return {
    workspacePath: env.WORKSPACE_PATH?.trim() || `${env.HOME?.trim() ?? ""}/.decepticon/workspace`,
    langGraphBrowserUrl: env.NEXT_PUBLIC_LANGGRAPH_API_URL?.trim() || DEFAULT_SETTINGS.langGraphBrowserUrl,
    terminalBrowserUrl: env.NEXT_PUBLIC_TERMINAL_WS_URL?.trim() || DEFAULT_SETTINGS.terminalBrowserUrl,
    language: env.DECEPTICON_LANGUAGE?.trim() || DEFAULT_SETTINGS.language,
    modelProfile: env.DECEPTICON_MODEL_PROFILE?.trim() || DEFAULT_SETTINGS.modelProfile,
    // The agent core reads `DECEPTICON_LLM__TIMEOUT` / `DECEPTICON_LLM__MAX_RETRIES`
    // (pydantic nested delimiter); the coroutine guard's
    // `DECEPTICON_LLM_TIMEOUT_SECONDS` is accepted as a secondary source. These
    // are startup-scoped: no dashboard write can reach the process that uses
    // them, so the snapshot only reports what the environment resolved.
    llmTimeoutSeconds: environmentInteger(
      env,
      SETTINGS_LIMITS.llmTimeoutSeconds,
      [LLM_TIMEOUT_ENV, "DECEPTICON_LLM_TIMEOUT_SECONDS"],
      DEFAULT_SETTINGS.llmTimeoutSeconds,
    ),
    llmMaxRetries: environmentInteger(
      env,
      SETTINGS_LIMITS.llmMaxRetries,
      [LLM_MAX_RETRIES_ENV],
      DEFAULT_SETTINGS.llmMaxRetries,
    ),
    authMode: deploymentAuthMode(env),
    databaseConfigured: Boolean(env.DATABASE_URL?.trim()),
    deploymentWebPort: port,
    // The agent core resolves these at request time (`llm/factory.py`), so an
    // absent row must fall back to the same deployment value it would have used
    // on its own.
    reasoningEffort: environmentReasoningEffort(env),
    llmMaxOutputTokens: environmentInteger(
      env,
      SETTINGS_LIMITS.llmMaxOutputTokens,
      [LLM_MAX_TOKENS_ENV],
      DEFAULT_SETTINGS.llmMaxOutputTokens,
    ),
    llmDisableStreaming: environmentBoolean(env, LLM_DISABLE_STREAMING_ENV, DEFAULT_SETTINGS.llmDisableStreaming),
    // NAME-only projection: `llm/factory.py::_resolve_extra_headers` reads the
    // values inside the agent process, and the dashboard reports which headers
    // exist so an operator can confirm the deployment took them.
    llmExtraHeaderNames: extraHeaderNames(parseExtraHeadersEnv(env[LLM_EXTRA_HEADERS_ENV])),
    budgetEngagementUsd: environmentCapUsd(env, BUDGET_ENGAGEMENT_USD_ENV),
    budgetPerAgentUsd: environmentCapUsd(env, BUDGET_PER_AGENT_USD_ENV),
    budgetSoftWarnAtPct: environmentSoftWarnPct(env),
    hitlEnabled: environmentHitl(env),
    telemetryMode: environmentTelemetryMode(env),
    authPriority: parseAuthPriority(env[DECEPTICON_AUTH_PRIORITY_ENV]),
    skillogyEmbedModel:
      env[DECEPTICON_SKILLOGY_EMBED_MODEL_ENV]?.trim() || DEFAULT_SKILLOGY_EMBED_MODEL,
  };
}

/**
 * Mirrors `isAuthConfigured()` in `@/lib/auth-crypto` — duplicated (rather than
 * imported) because that module pulls in `node:crypto` and this module is also
 * bundled for the browser. `system-settings.test.ts` pins the two together.
 */
function deploymentAuthMode(env: SettingsEnv): AuthMode {
  if (env.DECEPTICON_AUTH_DISABLED === "true") return "disabled";
  const hasCredential = Boolean(env.DECEPTICON_ADMIN_PASSWORD_HASH?.trim() || env.DECEPTICON_ADMIN_PASSWORD);
  const hasSecret = Boolean(env.DECEPTICON_SESSION_SECRET?.trim());
  return hasCredential && hasSecret ? "password" : "unconfigured";
}

/** Reasoning effort from the deployment; unknown values fall back to `none`. */
function environmentReasoningEffort(env: SettingsEnv): ReasoningEffort {
  return fromEnum(env[LLM_REASONING_EFFORT_ENV], REASONING_EFFORTS) ?? DEFAULT_SETTINGS.reasoningEffort;
}

/**
 * Read the first env var that parses to an in-range integer, else the fallback.
 * A malformed or out-of-range deployment value falls back rather than taking the
 * settings page down.
 */
function environmentInteger(
  env: SettingsEnv,
  bounds: { min: number; max: number },
  names: readonly string[],
  fallback: number,
): number {
  for (const name of names) {
    const parsed = parseInteger(env[name], bounds);
    if (typeof parsed === "number") return parsed;
  }
  return fallback;
}

/** A boolean env var; the fallback when unset, and when it is not a known spelling. */
function environmentBoolean(env: SettingsEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase() ?? "";
  if (raw === "" || (!Object.hasOwn(TRUTHY, raw) && !Object.hasOwn(FALSY, raw))) return fallback;
  return Object.hasOwn(TRUTHY, raw);
}

/**
 * `DECEPTICON_HITL__ENABLED` is truthy-only, exactly like
 * `middleware/hitl.py::_env_enabled_default`: the flag is a real
 * enable/disable, so an unrecognised spelling must mean *off*, never "on by
 * accident".
 */
function environmentHitl(env: SettingsEnv): boolean {
  return environmentBoolean(env, HITL_ENABLED_ENV, false);
}

/** `DECEPTICON_TELEMETRY`, fail-closed: `DO_NOT_TRACK` or an unknown value ⇒ `off`. */
function environmentTelemetryMode(env: SettingsEnv): TelemetryMode {
  if (Object.hasOwn(TRUTHY, env.DO_NOT_TRACK?.trim().toLowerCase() ?? "")) return "off";
  return fromEnum(env[DECEPTICON_TELEMETRY_ENV], TELEMETRY_MODES) ?? "off";
}

/** A USD cap. `0` (the Python default) and unset both mean "no cap". */
function environmentCapUsd(env: SettingsEnv, name: string): number | null {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > SETTINGS_LIMITS.budgetUsd.max) return null;
  return value > 0 ? value : null;
}

/** `DECEPTICON_BUDGET__SOFT_WARN_AT_PCT` is a fraction (0.7) in Python; the UI edits percent. */
function environmentSoftWarnPct(env: SettingsEnv): number {
  const raw = env[BUDGET_SOFT_WARN_AT_PCT_ENV]?.trim() ?? "";
  if (raw === "") return DEFAULT_SETTINGS.budgetSoftWarnAtPct;
  const fraction = Number(raw);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return DEFAULT_SETTINGS.budgetSoftWarnAtPct;
  return Math.round(fraction * 1000) / 10;
}

/**
 * `DECEPTICON_AUTH_PRIORITY`: comma-separated `AuthMethod` slugs, lowercased,
 * unknown tokens dropped (the Python parser logs and skips them). `[]` means
 * "use the built-in default chain".
 */
export function parseAuthPriority(raw: string | undefined): AuthMethodName[] {
  const value = raw?.trim() ?? "";
  if (!value) return [];
  const priority: AuthMethodName[] = [];
  for (const token of value.split(",")) {
    const method = fromEnum(token, AUTH_METHODS);
    if (method && !priority.includes(method)) priority.push(method);
  }
  return priority;
}
