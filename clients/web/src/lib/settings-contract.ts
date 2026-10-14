/**
 * System settings contract — the shared vocabulary of the settings API and UI.
 *
 * PURE by construction: no `next/*`, no Prisma, no node builtins, so it can be
 * bundled for the browser (the settings cards import the enums, the limits and
 * the snapshot types) while the route handlers reuse the very same shapes.
 *
 * What lives here: the enumerations mirrored from the Python core, the DB keys,
 * the validation bounds, the snapshot/patch types, the per-field effect boundary
 * and the primitive parsers both halves of the contract use.
 *
 * What does NOT live here and deliberately so:
 *   - `./system-settings-environment` — the deployment half, which reads
 *     `process.env` via {@link SettingsEnv}. Kept separate so importing a type
 *     never drags the environment mapping into a page bundle.
 *   - `./system-settings` — the storage/API half (row merge, PUT validation,
 *     encoding, run overrides) plus the `./settings-headers` re-export.
 */

import { AGENT_DISPLAY_CONFIG } from "./agents";
import { EXTRA_HEADER_LIMITS } from "./settings-headers";

// ── Enumerations ─────────────────────────────────────────────────────

/** Model tiering presets — mirrors `DECEPTICON_MODEL_PROFILE` in the agent core. */
export const MODEL_PROFILES = ["eco", "max", "test"] as const;
export type ModelProfile = (typeof MODEL_PROFILES)[number];

/** Languages the dashboard ships translations for — mirrors `DECEPTICON_LANGUAGE` support. */
export const SETTINGS_LANGUAGES = ["en", "zh"] as const;
export type SettingsLanguage = (typeof SETTINGS_LANGUAGES)[number];

/** How the running deployment resolves requests (mirrors `@/lib/auth-bridge`). */
export const AUTH_MODES = ["password", "disabled", "unconfigured"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Reasoning effort sent to models that accept it, in ascending order.
 * `none` (and "not set") sends nothing at all, so a model that rejects the
 * parameter is never handed it; every other tier is forwarded verbatim, and a
 * model whose provider does not know the tier is left to ignore or reject it
 * rather than being silently downgraded by this dashboard.
 * Mirrors the run-input channel `ModelOverridesState.reasoning_effort`.
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Telemetry consent tiers — mirrors `decepticon.telemetry.config.TelemetryMode`. */
export const TELEMETRY_MODES = ["off", "basic", "research"] as const;
export type TelemetryMode = (typeof TELEMETRY_MODES)[number];

/**
 * `AuthMethod` slugs accepted in `DECEPTICON_AUTH_PRIORITY`
 * (`decepticon_core.types.llm.AuthMethod`). Kept as a literal list because the
 * contract module is also bundled for the browser and must stay dependency-free;
 * an unknown slug is rejected (400 territory) rather than silently dropped.
 */
export const AUTH_METHODS = [
  "anthropic_api",
  "anthropic_oauth",
  "openai_api",
  "openai_oauth",
  "google_api",
  "google_oauth",
  "minimax_api",
  "deepseek_api",
  "xai_api",
  "mistral_api",
  "openrouter_api",
  "nvidia_api",
  "ollama_local",
  "ollama_cloud",
  "copilot_oauth",
  "grok_oauth",
  "perplexity_oauth",
  "bedrock_api",
  "vertex_api",
  "azure_api",
  "groq_api",
  "together_api",
  "fireworks_api",
  "cohere_api",
  "moonshot_api",
  "kimi_api",
  "zai_api",
  "dashscope_api",
  "github_models_api",
  "lmstudio_local",
  "llamacpp_local",
  "custom_openai_api",
  "cerebras_api",
  "xiaomi_mimo_api",
  "opencode_api",
  "vercel_gateway_api",
  "huggingface_api",
  "venice_api",
  "nanogpt_api",
  "synthetic_api",
  "zenmux_api",
  "qianfan_api",
  "cloudflare_gateway_api",
] as const;
export type AuthMethodName = (typeof AUTH_METHODS)[number];

/**
 * Agent ids allowed as keys in `modelOverrides`.
 *
 * The backend reads `model_overrides` as `{<agent id>: <model id>}`
 * (`ModelOverrideMiddleware(role=...)` in the agent slots), so the whitelist is
 * the agent registry itself — exported here to keep the dropdown and the server
 * validator from drifting into two lists.
 */
export const MODEL_ROLE_IDS: readonly string[] = Object.keys(AGENT_DISPLAY_CONFIG).sort();

// ── Keys ─────────────────────────────────────────────────────────────

/**
 * DB keys the settings store knows. Includes `workspacePath`, whose row is no
 * longer writable (see {@link SETTINGS_READONLY_FIELDS}) — the key stays so a
 * `PUT` of it answers "read-only field" instead of the misleading "unknown
 * field", and so the store never has to special-case the legacy row.
 */
export const SETTING_KEYS = {
  modelProfile: "model_profile",
  globalModelOverride: "global_model_override",
  modelOverrides: "model_overrides",
  language: "language",
  llmTimeoutSeconds: "llm_timeout_seconds",
  llmMaxRetries: "llm_max_retries",
  workspacePath: "workspace_path",
  langGraphBrowserUrl: "langgraph_browser_url",
  terminalBrowserUrl: "terminal_browser_url",
  llmProxyApiKey: "llm_proxy_api_key",
  reasoningEffort: "reasoning_effort",
  llmMaxOutputTokens: "llm_max_output_tokens",
  llmDisableStreaming: "llm_disable_streaming",
  llmExtraHeaders: "llm_extra_headers",
  budgetEngagementUsd: "budget_engagement_usd",
  budgetPerAgentUsd: "budget_per_agent_usd",
  budgetSoftWarnAtPct: "budget_soft_warn_at_pct",
  hitlEnabled: "hitl_enabled",
} as const;

/**
 * The only write-only field: accepted on PUT, never echoed on GET/PUT.
 * Listed separately so the UI can render "replace key" controls without
 * treating it as a readable value.
 */
export const SETTINGS_SECRET_FIELDS = ["llmProxyApiKey"] as const;

/**
 * Field names the PUT endpoint accepts: every known key except the read-only
 * ones. Legacy rows (`modelProfile`, `llmTimeoutSeconds`, `llmMaxRetries`,
 * `llmExtraHeaders`, `workspacePath`) keep their keys solely so a PUT of one is
 * answered with "read-only field" instead of the misleading "unknown field".
 */
export type WritableSettingField = Exclude<keyof typeof SETTING_KEYS, (typeof SETTINGS_READONLY_FIELDS)[number]>;

/**
 * Fields the dashboard reports but never stores. Rejected by
 * {@link validateSettingsPatch} so a client cannot mistake them for editable
 * knobs — the trap these fields exist to close is a Save button that writes a
 * row nothing reads.
 */
export const SETTINGS_READONLY_FIELDS = [
  "authMode",
  "databaseConfigured",
  "deploymentWebPort",
  "llmProxyApiKeySet",
  // Consumed by the agent process from its OWN environment at startup (or by a
  // file/JSONL the web container cannot write), so a DB row would be a fake
  // setting: reported for the operator, never accepted by the PUT endpoint.
  "telemetryMode",
  "authPriority",
  "skillogyEmbedModel",
  // Startup-scoped agent knobs, read by the LangGraph process (`load_config()`)
  // when it starts: `DECEPTICON_MODEL_PROFILE` picks the model tiering,
  // `DECEPTICON_LLM__TIMEOUT` / `DECEPTICON_LLM__MAX_RETRIES` reach LiteLLM, and
  // `DECEPTICON_LLM_EXTRA_HEADERS` is parsed by `llm/factory.py` at model
  // construction. No PTY, run input or request path re-reads a stored row for
  // them, so a stored row could never take effect — the dashboard reports the
  // environment value instead and refuses the write.
  "modelProfile",
  "llmTimeoutSeconds",
  "llmMaxRetries",
  "llmExtraHeaders",
  // Deployment-owned too: the PTY (`WORKSPACE_PATH`), engagement creation and
  // the workspace file APIs all resolve the root from their own environment, so
  // a stored row could never move the on-disk workspace. A legacy
  // `workspace_path` row is still READ (so an operator sees what is pinned) but
  // is no longer writable.
  "workspacePath",
] as const;

/** Known keys minus the read-only ones — the set {@link validateSettingsPatch} walks. */
export const WRITABLE_SETTING_FIELDS = (Object.keys(SETTING_KEYS) as Array<keyof typeof SETTING_KEYS>).filter(
  (field): field is WritableSettingField => !(SETTINGS_READONLY_FIELDS as readonly string[]).includes(field),
);

// ── Bounds ───────────────────────────────────────────────────────────

/** Inclusion bounds enforced by {@link validateSettingsPatch}. */
export const SETTINGS_LIMITS = {
  /** Seconds. Default 120; 3600 (1h) is the practical ceiling for a single call. */
  llmTimeoutSeconds: { min: 5, max: 3600 },
  llmMaxRetries: { min: 0, max: 10 },
  modelIdLength: 200,
  browserUrlLength: 2048,
  apiKeyLength: 512,
  modelOverridesMaxEntries: MODEL_ROLE_IDS.length,
  /** Matches `_resolve_max_tokens`' clamp; above this the upstream rejects it. */
  llmMaxOutputTokens: { min: 256, max: 128000 },
  /** USD. 0 = explicit "unlimited" override of a deployment cap. */
  budgetUsd: { min: 0, max: 1_000_000 },
  /** Percent; the wire format the UI edits (the run input carries 0..1). */
  budgetSoftWarnAtPct: { min: 0, max: 100 },
  /** `llmExtraHeaders`: key count / per-value length — owned by `./settings-headers`. */
  extraHeadersMaxEntries: EXTRA_HEADER_LIMITS.maxEntries,
  extraHeaderValueLength: EXTRA_HEADER_LIMITS.valueLength,
} as const;

// ── Types ────────────────────────────────────────────────────────────

/**
 * Settings the operator may change, with effective values (DB override when
 * present and valid, otherwise the deployment default).
 */
export interface SettingsDefaults {
  /**
   * Startup-scoped: the LangGraph process picks the model tiering from
   * `DECEPTICON_MODEL_PROFILE` when it starts (`load_config().model_profile`),
   * so the dashboard reports the effective value and never stores one.
   */
  modelProfile: ModelProfile;
  /** Empty string = no global override. */
  globalModelOverride: string;
  /** `<agent id>` → `<model id>`; per-role wins over the global override. */
  modelOverrides: Record<string, string>;
  language: SettingsLanguage;
  /**
   * Seconds. Startup-scoped: the agent core resolves
   * `DECEPTICON_LLM__TIMEOUT` from its own environment for the LiteLLM
   * transport (`llm/factory.py::_resolve_llm_timeout_seconds`), which no
   * dashboard write can reach. Reported, never stored.
   */
  llmTimeoutSeconds: number;
  /** Startup-scoped, same as the timeout (`DECEPTICON_LLM__MAX_RETRIES`). */
  llmMaxRetries: number;
  /**
   * Engagement workspace root, absolute POSIX path — reported, never written
   * (see {@link SETTINGS_READONLY_FIELDS}). The PTY, engagement creation and the
   * workspace file APIs read `WORKSPACE_PATH` from the deployment env, so a
   * stored row here could never move the on-disk workspace.
   */
  workspacePath: string;
  langGraphBrowserUrl: string;
  terminalBrowserUrl: string;
  /**
   * Reasoning effort for the next terminal session's agent runs. `none` sends
   * no parameter at all (the deployment default), so models that reject
   * `reasoning_effort` are unaffected; every other tier travels verbatim, with
   * no per-model downgrade.
   */
  reasoningEffort: ReasoningEffort;
  /** Per-call output ceiling override; mirrors `DECEPTICON_LLM_MAX_TOKENS`. */
  llmMaxOutputTokens: number;
  /** Mirrors `DECEPTICON_LLM_DISABLE_STREAMING`. */
  llmDisableStreaming: boolean;
  /**
   * NAMES of the extra provider headers the agent process resolved from
   * `DECEPTICON_LLM_EXTRA_HEADERS`. Startup-scoped and reported for diagnosis
   * only: values never leave the server (or the agent process), and the run
   * input does not carry them, because a run-state value would land in the
   * LangGraph checkpoint.
   */
  llmExtraHeaderNames: string[];
  /** USD cap for the whole engagement; `null` = no override (the deployment value governs, usually unlimited). */
  budgetEngagementUsd: number | null;
  /** USD cap per specialist agent; `null` = no override. */
  budgetPerAgentUsd: number | null;
  /** Percent of a cap at which the agent emits its soft warning. */
  budgetSoftWarnAtPct: number;
  /** Mirrors the deployment's truthy-only `DECEPTICON_HITL__ENABLED`. */
  hitlEnabled: boolean;
}

/** Full GET payload. Top-level JSON object, never wrapped. */
export interface SettingsSnapshot extends SettingsDefaults {
  /** True when a LiteLLM/proxy key override is stored. The key itself is never returned. */
  llmProxyApiKeySet: boolean;
  authMode: AuthMode;
  databaseConfigured: boolean;
  deploymentWebPort: string;
  /**
   * Startup-scoped deployment values, reported so the operator sees the truth
   * but never accepted by the PUT endpoint (see {@link SETTINGS_READONLY_FIELDS}).
   */
  telemetryMode: TelemetryMode;
  /** Configured `DECEPTICON_AUTH_PRIORITY`, in order; `[]` = built-in default chain. */
  authPriority: AuthMethodName[];
  /** `DECEPTICON_SKILLOGY_EMBED_MODEL`; the embedding dimension is fixed at startup. */
  skillogyEmbedModel: string;
}

/**
 * Partial update. Every field is optional: absent fields keep their stored
 * value; an empty string / empty map clears the stored row so the deployment
 * default applies again.
 *
 * Startup-scoped fields (`modelProfile`, `llmTimeoutSeconds`,
 * `llmMaxRetries`, `llmExtraHeaders`, `workspacePath`) are NOT patchable: they
 * are carried in {@link SettingsSnapshot} for reporting only, and a PUT of one
 * is rejected as a read-only field.
 */
export type SettingsPatch = Partial<{
  globalModelOverride: string;
  modelOverrides: Record<string, string>;
  language: SettingsLanguage | "";
  langGraphBrowserUrl: string;
  terminalBrowserUrl: string;
  llmProxyApiKey: string;
  reasoningEffort: ReasoningEffort | "";
  llmMaxOutputTokens: number | "";
  llmDisableStreaming: boolean;
  /** `""` clears the row; `0` is an explicit "unlimited" override of a deployment cap. */
  budgetEngagementUsd: number | "";
  budgetPerAgentUsd: number | "";
  budgetSoftWarnAtPct: number | "";
  hitlEnabled: boolean;
}>;

/** Reject result shared by the validation helpers; mirrors the API 400 body. */
export interface SettingsRejection {
  ok: false;
  error: string;
  fields?: Record<string, string>;
}

export type SettingsPatchResult = { ok: true; patch: SettingsPatch } | SettingsRejection;

/** A row as stored in `SystemSetting`. */
export interface SettingRow {
  key: string;
  value: string;
}

/** Deployment-derived values that are reported but never stored. */
export interface SettingsEnvironment {
  workspacePath: string;
  langGraphBrowserUrl: string;
  terminalBrowserUrl: string;
  language: string;
  modelProfile: string;
  /** Deployment LLM timeout/retry defaults, read by the agent core at startup. */
  llmTimeoutSeconds: number;
  llmMaxRetries: number;
  authMode: AuthMode;
  databaseConfigured: boolean;
  deploymentWebPort: string;
  /** Deployment fallbacks for the hot-updatable LLM/guardrail knobs. */
  reasoningEffort: ReasoningEffort;
  llmMaxOutputTokens: number;
  llmDisableStreaming: boolean;
  /** Header NAMES only — a value never leaves the server or the agent process. */
  llmExtraHeaderNames: string[];
  budgetEngagementUsd: number | null;
  budgetPerAgentUsd: number | null;
  budgetSoftWarnAtPct: number;
  hitlEnabled: boolean;
  /** Startup-scoped: reported, never stored. */
  telemetryMode: TelemetryMode;
  authPriority: AuthMethodName[];
  skillogyEmbedModel: string;
}

export type SettingsEnv = Record<string, string | undefined>;

/**
 * When a saved value actually reaches the agent, per field. The UI must render
 * this instead of claiming every card is live: a settings store that looks
 * instant but is not is how an operator concludes a knob is broken.
 *
 * - `next-session`: read when the value is next consumed — a NEW terminal
 *   session for the run/LLM knobs, the next page request for the browser
 *   defaults and the language default. An already-running PTY keeps the policy
 *   it started with.
 * - `read-only`: not storable at all — reported by `/api/settings` from the
 *   deployment environment, rejected by a PUT.
 *
 * There is deliberately no `stored` category left: a value that nothing in this
 * stack reads is not a setting, and the fields that used to be one
 * (`modelProfile`, `llmTimeoutSeconds`, `llmMaxRetries`, `llmExtraHeaders`) are
 * now reported from the deployment environment alongside the other startup
 * facts.
 */
export type SettingsEffect = "next-session" | "read-only";

export const SETTINGS_EFFECT: Record<keyof SettingsSnapshot | keyof typeof SETTING_KEYS, SettingsEffect> = {
  globalModelOverride: "next-session",
  modelOverrides: "next-session",
  reasoningEffort: "next-session",
  llmMaxOutputTokens: "next-session",
  llmDisableStreaming: "next-session",
  budgetEngagementUsd: "next-session",
  budgetPerAgentUsd: "next-session",
  budgetSoftWarnAtPct: "next-session",
  hitlEnabled: "next-session",
  language: "next-session",
  langGraphBrowserUrl: "next-session",
  terminalBrowserUrl: "next-session",
  llmProxyApiKey: "next-session",
  // Startup-scoped agent knobs and deployment facts: the agent process takes its
  // own environment instead, and the settings table is not on that path. A
  // stored row for any of them would be a settings control with no consumer.
  modelProfile: "read-only",
  llmTimeoutSeconds: "read-only",
  llmMaxRetries: "read-only",
  // A legacy STORE key with no counterpart in the snapshot: the row is never read,
  // and the entry stays so the badge for it can never render as "unknown".
  llmExtraHeaders: "read-only",
  llmExtraHeaderNames: "read-only",
  llmProxyApiKeySet: "read-only",
  authMode: "read-only",
  databaseConfigured: "read-only",
  deploymentWebPort: "read-only",
  telemetryMode: "read-only",
  authPriority: "read-only",
  skillogyEmbedModel: "read-only",
  // Reported from the deployment environment like the rest of the startup set: a
  // legacy `workspace_path` row is ignored, since the PTY, engagement creation
  // and the file APIs resolve the root from `WORKSPACE_PATH`.
  workspacePath: "read-only",
};

/** Env var names shared with the Python consumers (kept in one place). */
export const LLM_MAX_TOKENS_ENV = "DECEPTICON_LLM_MAX_TOKENS";
export const LLM_DISABLE_STREAMING_ENV = "DECEPTICON_LLM_DISABLE_STREAMING";
export const LLM_EXTRA_HEADERS_ENV = "DECEPTICON_LLM_EXTRA_HEADERS";
/** Deployment knob for reasoning effort; the run-input twin is `DECEPTICON_RUN_REASONING_EFFORT`. */
export const LLM_REASONING_EFFORT_ENV = "DECEPTICON_LLM_REASONING_EFFORT";
export const BUDGET_ENGAGEMENT_USD_ENV = "DECEPTICON_BUDGET__ENGAGEMENT_USD";
export const BUDGET_PER_AGENT_USD_ENV = "DECEPTICON_BUDGET__PER_AGENT_USD";
export const BUDGET_SOFT_WARN_AT_PCT_ENV = "DECEPTICON_BUDGET__SOFT_WARN_AT_PCT";
export const HITL_ENABLED_ENV = "DECEPTICON_HITL__ENABLED";
export const DECEPTICON_TELEMETRY_ENV = "DECEPTICON_TELEMETRY";
export const DECEPTICON_AUTH_PRIORITY_ENV = "DECEPTICON_AUTH_PRIORITY";
export const DECEPTICON_SKILLOGY_EMBED_MODEL_ENV = "DECEPTICON_SKILLOGY_EMBED_MODEL";
export const DO_NOT_TRACK_ENV = "DO_NOT_TRACK";
/** The published names for the two stored-only runtime rows (see `settingsEnvironment`). */
export const LLM_TIMEOUT_ENV = "DECEPTICON_LLM__TIMEOUT";
export const LLM_MAX_RETRIES_ENV = "DECEPTICON_LLM__MAX_RETRIES";

/**
 * The env var that actually governs a read-only field, so the UI can name it
 * instead of leaving the operator guessing why a save did nothing.
 */
export const SETTINGS_ENV_SOURCE: Partial<Record<keyof SettingsSnapshot | WritableSettingField, string>> = {
  modelProfile: "DECEPTICON_MODEL_PROFILE",
  llmTimeoutSeconds: LLM_TIMEOUT_ENV,
  llmMaxRetries: LLM_MAX_RETRIES_ENV,
  llmExtraHeaderNames: LLM_EXTRA_HEADERS_ENV,
  workspacePath: "WORKSPACE_PATH",
  telemetryMode: DECEPTICON_TELEMETRY_ENV,
  authPriority: DECEPTICON_AUTH_PRIORITY_ENV,
  skillogyEmbedModel: DECEPTICON_SKILLOGY_EMBED_MODEL_ENV,
};

/** Mirrors `decepticon.skillogy.embeddings.DEFAULT_EMBED_MODEL`. */
export const DEFAULT_SKILLOGY_EMBED_MODEL = "openai/text-embedding-3-small";

/**
 * Spellings the Python core treats as truthy (`telemetry.config._TRUTHY`,
 * `middleware/hitl.py::_HITL_TRUTHY` and the LLM resolvers) and falsy (the same
 * resolvers' explicit-off spellings).
 */
export const TRUTHY: Record<string, true> = { "1": true, true: true, yes: true, on: true };
export const FALSY: Record<string, true> = { "0": true, false: true, no: true, off: true };

// ── Deployment defaults ──────────────────────────────────────────────

/** Defaults that must match the existing behaviour of the stack (core `LLMConfig`). */
export const DEFAULT_SETTINGS: SettingsDefaults = {
  modelProfile: "eco",
  globalModelOverride: "",
  modelOverrides: {},
  language: "en",
  llmTimeoutSeconds: 120,
  llmMaxRetries: 2,
  // Reported, never written: the effective value is always
  // `settingsEnvironment().workspacePath`, because the PTY and the file APIs
  // resolve `WORKSPACE_PATH` themselves.
  workspacePath: "",
  // Display defaults mirror `@/lib/browser-config` (same env vars, same
  // fallbacks) so an unset setting never diverges from what the page reports.
  langGraphBrowserUrl: "http://localhost:2024",
  terminalBrowserUrl: "ws://localhost:3003",
  // LLM request knobs. `none` means "send no reasoning_effort at all", which is
  // the only safe default for the mixed model fleet.
  reasoningEffort: "none",
  llmMaxOutputTokens: 64000,
  llmDisableStreaming: false,
  // Deployments that set `DECEPTICON_LLM_EXTRA_HEADERS` report their header
  // NAMES here; the values stay in the agent process, and the run input never
  // carries them.
  llmExtraHeaderNames: [],
  // No cap unless the deployment (or the operator) asks for one.
  budgetEngagementUsd: null,
  budgetPerAgentUsd: null,
  budgetSoftWarnAtPct: 70,
  hitlEnabled: false,
};

// ── Primitive parsers ────────────────────────────────────────────────

export const HTTP_PROTOCOLS = ["http:", "https:"] as const;
export const WS_PROTOCOLS = ["ws:", "wss:"] as const;

export const MODEL_ID_ERROR = `must be a single model id (at most ${SETTINGS_LIMITS.modelIdLength} characters)`;

/** Trim and match against an enum, or null. Used for stored rows AND patch input. */
export function fromEnum<T extends string>(value: string | null | undefined, options: readonly T[]): T | null {
  const candidate = value?.trim() ?? "";
  return (options as readonly string[]).includes(candidate) ? (candidate as T) : null;
}

/** `{<agent id>: <model id>}`; returns the error message when malformed. */
export function parseModelOverrides(value: unknown): Record<string, string> | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "must be an object of agent id → model id";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SETTINGS_LIMITS.modelOverridesMaxEntries) {
    return `must have at most ${SETTINGS_LIMITS.modelOverridesMaxEntries} entries`;
  }
  const overrides: Record<string, string> = {};
  for (const [role, raw] of entries) {
    if (!MODEL_ROLE_IDS.includes(role)) return `unknown agent role "${role}"`;
    if (typeof raw !== "string") return `model for "${role}" must be a string`;
    const model = raw.trim();
    if (model.length > SETTINGS_LIMITS.modelIdLength) return `model for "${role}" is too long`;
    if (/\s/.test(model)) return `model for "${role}" must be a single model id`;
    // Empty value = "no override for this role" — dropped, not stored.
    if (model) overrides[role] = model;
  }
  return overrides;
}

/**
 * A `0` that means "keep the deployment value" rather than a value to store.
 * `null` and `""` are NOT zero: the first is a type error, the second is the
 * documented clear.
 */
export function isZero(value: unknown): boolean {
  if (value === 0) return true;
  return typeof value === "string" && value.trim() !== "" && Number(value) === 0;
}

/** An integer inside `bounds`, or the range wording for the field error. */
export function parseInteger(value: unknown, bounds: { min: number; max: number }): number | string {
  const range = `must be an integer between ${bounds.min} and ${bounds.max}`;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < bounds.min || numeric > bounds.max) return range;
  return numeric;
}

/** A finite number inside `bounds` (fractions allowed), or the range wording. */
export function parseNumber(value: unknown, bounds: { min: number; max: number }): number | string {
  const range = `must be a number between ${bounds.min} and ${bounds.max}`;
  const numeric =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < bounds.min || numeric > bounds.max) return range;
  return numeric;
}

export function validBrowserUrl(value: string, protocols: readonly string[]): boolean {
  if (value === "") return true; // clear → deployment default
  if (value.length > SETTINGS_LIMITS.browserUrlLength) return false;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.host !== "";
  } catch {
    return false;
  }
}
