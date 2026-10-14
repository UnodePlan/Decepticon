/**
 * Run-scoped settings handoff — dashboard → terminal PTY → CLI → LangGraph run.
 *
 * The dashboard persists operator settings in the `SystemSetting` table
 * (`@/lib/system-settings`). When the terminal server spawns a PTY it asks its
 * own API for the snapshot and forwards the settings below through the
 * `DECEPTICON_RUN_*` env vars; the CLI reads them back
 * (`clients/cli/src/commands/runOverrides.ts`, which spells the same names and
 * caps — they are a cross-package wire contract) and injects them into the
 * LangGraph run input, the one surface the agent's `ModelOverrideMiddleware`
 * consumes:
 *
 *   - `DECEPTICON_RUN_MODEL_OVERRIDE`           → `model_override` (global)
 *   - `DECEPTICON_RUN_MODEL_OVERRIDES`         → `model_overrides`, wins over the global
 *   - `DECEPTICON_RUN_REASONING_EFFORT`        → `reasoning_effort`
 *   - `DECEPTICON_RUN_LLM_MAX_OUTPUT_TOKENS`   → `llm_max_output_tokens`
 *   - `DECEPTICON_RUN_LLM_DISABLE_STREAMING`   → `llm_disable_streaming`
 *   - `DECEPTICON_RUN_BUDGET_ENGAGEMENT_USD`   → `budget_engagement_usd`
 *   - `DECEPTICON_RUN_BUDGET_PER_AGENT_USD`    → `budget_per_agent_usd`
 *   - `DECEPTICON_RUN_BUDGET_SOFT_WARN_AT_PCT` → `budget_soft_warn_at_pct` (fraction)
 *   - `DECEPTICON_RUN_HITL_ENABLED`            → `hitl_enabled`
 *
 * Effect boundary: the values reach the agent through the run input of the
 * NEXT terminal session. A PTY keeps the policy it started with, so a save in
 * the UI takes effect on the next terminal session and never mutates a running
 * one. Two knobs are relative to a deployment default rather than absolute:
 * the max-output ceiling is omitted when it equals the value the agent process
 * would resolve itself (`DECEPTICON_LLM_MAX_TOKENS`, a positive integer, else
 * 64000), and the soft-warn threshold is omitted when the stored percent / 100
 * equals `DECEPTICON_BUDGET__SOFT_WARN_AT_PCT` (fraction in `(0, 1]`, else 0.7)
 * — an omitted value leaves the deployment default in place instead of
 * duplicating it into the run input.
 *
 * Deliberately NOT forwarded:
 *   - `modelProfile` — `DECEPTICON_MODEL_PROFILE` is read by the LangGraph
 *     process at startup, so a PTY cannot change it; the settings page shows it
 *     with its real effective boundary instead.
 *   - `llmTimeoutSeconds` / `llmMaxRetries` / the proxy key — consumed by the
 *     agent process from its own environment, not by run input.
 *
 * Extra provider headers have no run-input channel at all. The values are
 * credentials-adjacent, the run input round-trips through the LangGraph
 * checkpoint, and the agent core resolves them from
 * `DECEPTICON_LLM_EXTRA_HEADERS` in its own environment at model construction
 * (`llm/factory.py::_resolve_extra_headers`). They are therefore a startup-scoped
 * deployment value, and the settings page reports the header NAMES only.
 */

export const RUN_MODEL_OVERRIDE_ENV = "DECEPTICON_RUN_MODEL_OVERRIDE";
export const RUN_MODEL_OVERRIDES_ENV = "DECEPTICON_RUN_MODEL_OVERRIDES";
export const RUN_REASONING_EFFORT_ENV = "DECEPTICON_RUN_REASONING_EFFORT";
export const RUN_LLM_MAX_OUTPUT_TOKENS_ENV = "DECEPTICON_RUN_LLM_MAX_OUTPUT_TOKENS";
export const RUN_LLM_DISABLE_STREAMING_ENV = "DECEPTICON_RUN_LLM_DISABLE_STREAMING";
export const RUN_BUDGET_ENGAGEMENT_USD_ENV = "DECEPTICON_RUN_BUDGET_ENGAGEMENT_USD";
export const RUN_BUDGET_PER_AGENT_USD_ENV = "DECEPTICON_RUN_BUDGET_PER_AGENT_USD";
export const RUN_BUDGET_SOFT_WARN_AT_PCT_ENV = "DECEPTICON_RUN_BUDGET_SOFT_WARN_AT_PCT";
export const RUN_HITL_ENABLED_ENV = "DECEPTICON_RUN_HITL_ENABLED";

/** Caps shared with the CLI reader; the settings store validates far below. */
export const MAX_OVERRIDE_ROLES = 64;
const MAX_ROLE_LENGTH = 64;
const MAX_MODEL_LENGTH = 256;

/** Bounds shared with the CLI reader and `@/lib/system-settings`. */
const MIN_LLM_MAX_OUTPUT_TOKENS = 256;
const MAX_LLM_MAX_OUTPUT_TOKENS = 128_000;
const MAX_BUDGET_USD = 1_000_000;

/** Deployment env the snapshot's value is compared against, mirroring `@/lib/system-settings`. */
const LLM_MAX_TOKENS_ENV = "DECEPTICON_LLM_MAX_TOKENS";
const BUDGET_SOFT_WARN_AT_PCT_ENV = "DECEPTICON_BUDGET__SOFT_WARN_AT_PCT";
/** `DEFAULT_SETTINGS.llmMaxOutputTokens` / `DEFAULT_SETTINGS.budgetSoftWarnAtPct`. */
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const DEFAULT_SOFT_WARN_FRACTION = 0.7;

/**
 * Reasoning efforts the run input accepts — every tier but `none`, which means
 * "send nothing" and is therefore never forwarded. Each tier travels verbatim:
 * the run input does not remap `xhigh`/`max` onto a lower tier, so a model that
 * does not support one reports it instead of silently receiving another.
 */
const FORWARDED_REASONING_EFFORTS: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/** The settings snapshot's fields this module reads; anything else on it is ignored. */
export interface RunSettingsSnapshot {
  globalModelOverride?: string | null;
  modelOverrides?: Record<string, string> | null;
  reasoningEffort?: string | null;
  llmMaxOutputTokens?: number | null;
  llmDisableStreaming?: boolean | null;
  budgetEngagementUsd?: number | null;
  budgetPerAgentUsd?: number | null;
  /** Stored PERCENT (0..100); the wire carries the fraction. */
  budgetSoftWarnAtPct?: number | null;
  hitlEnabled?: boolean | null;
}

/**
 * Map the persisted settings snapshot onto PTY environment variables.
 *
 * Absent, empty, default, malformed or oversized values are dropped rather than
 * forwarded: an empty global would otherwise be indistinguishable from "no
 * policy" once the CLI reads it back, a 4 KB model id is store corruption, and a
 * value equal to the deployment default would only duplicate what the agent
 * process already resolves from its own environment. Returns an empty (not
 * undefined) object when there is nothing to forward, so callers can spread it
 * unconditionally — an operator-set env baseline then survives untouched.
 */
export function runSettingsEnv(
  policy: RunSettingsSnapshot | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!policy || typeof policy !== "object") return result;

  const global = typeof policy.globalModelOverride === "string" ? policy.globalModelOverride.trim() : "";
  if (global && global.length <= MAX_MODEL_LENGTH) result[RUN_MODEL_OVERRIDE_ENV] = global;

  const roles: Record<string, string> = {};
  const source = policy.modelOverrides;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [role, value] of Object.entries(source)) {
      if (Object.keys(roles).length >= MAX_OVERRIDE_ROLES) break;
      const name = role.trim();
      const modelId = typeof value === "string" ? value.trim() : "";
      if (!name || name.length > MAX_ROLE_LENGTH) continue;
      if (!modelId || modelId.length > MAX_MODEL_LENGTH) continue;
      roles[name] = modelId;
    }
  }
  if (Object.keys(roles).length > 0) {
    result[RUN_MODEL_OVERRIDES_ENV] = JSON.stringify(roles);
  }

  const effort = typeof policy.reasoningEffort === "string" ? policy.reasoningEffort.trim() : "";
  if (Object.hasOwn(FORWARDED_REASONING_EFFORTS, effort)) {
    result[RUN_REASONING_EFFORT_ENV] = effort;
  }

  const maxOutput = policy.llmMaxOutputTokens;
  if (
    typeof maxOutput === "number" &&
    Number.isInteger(maxOutput) &&
    maxOutput >= MIN_LLM_MAX_OUTPUT_TOKENS &&
    maxOutput <= MAX_LLM_MAX_OUTPUT_TOKENS &&
    maxOutput !== deploymentMaxOutputTokens(env)
  ) {
    result[RUN_LLM_MAX_OUTPUT_TOKENS_ENV] = String(maxOutput);
  }

  // Only "on" is ever forwarded: an unset/false value leaves the agent process
  // env (`DECEPTICON_LLM_DISABLE_STREAMING`) in charge.
  if (policy.llmDisableStreaming === true) {
    result[RUN_LLM_DISABLE_STREAMING_ENV] = "1";
  }

  const engagement = usableBudgetUsd(policy.budgetEngagementUsd);
  if (engagement !== null) result[RUN_BUDGET_ENGAGEMENT_USD_ENV] = String(engagement);

  const perAgent = usableBudgetUsd(policy.budgetPerAgentUsd);
  if (perAgent !== null) result[RUN_BUDGET_PER_AGENT_USD_ENV] = String(perAgent);

  const pct = policy.budgetSoftWarnAtPct;
  if (typeof pct === "number" && Number.isFinite(pct) && pct > 0 && pct <= 100) {
    const fraction = pct / 100;
    if (fraction !== deploymentSoftWarnFraction(env)) {
      result[RUN_BUDGET_SOFT_WARN_AT_PCT_ENV] = String(fraction);
    }
  }

  if (policy.hitlEnabled === true) {
    result[RUN_HITL_ENABLED_ENV] = "1";
  }

  return result;
}

/**
 * The ceiling the agent process would resolve on its own: a positive integer
 * `DECEPTICON_LLM_MAX_TOKENS`, else 64000. Malformed deployment values fall back
 * exactly like `settingsEnvironment()` does.
 */
function deploymentMaxOutputTokens(env: Record<string, string | undefined>): number {
  const raw = env[LLM_MAX_TOKENS_ENV]?.trim() ?? "";
  const value = Number(raw);
  if (raw === "" || !Number.isInteger(value) || value <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
  return value;
}

/**
 * The soft-warn threshold the agent process would resolve on its own:
 * `DECEPTICON_BUDGET__SOFT_WARN_AT_PCT` is a fraction (0.7) in Python, so only a
 * value in `(0, 1]` counts; anything else falls back to 0.7.
 */
function deploymentSoftWarnFraction(env: Record<string, string | undefined>): number {
  const raw = env[BUDGET_SOFT_WARN_AT_PCT_ENV]?.trim() ?? "";
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value) || value <= 0 || value > 1) return DEFAULT_SOFT_WARN_FRACTION;
  return value;
}

/** A USD cap: finite, `> 0` (0 means "no cap"), at most 1000000; anything else is unusable. */
function usableBudgetUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 && value <= MAX_BUDGET_USD ? value : null;
}

