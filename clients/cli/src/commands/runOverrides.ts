/**
 * Run-scoped model policy handed to this CLI by the web terminal.
 *
 * The dashboard persists model policy in its own settings store; the terminal
 * server (`clients/web/server/terminal-server.ts` → `src/lib/run-settings.ts`)
 * reads the snapshot and forwards the model part into the PTY environment. This
 * module reads those values back and shapes them into the LangGraph run fields
 * the agent's `ModelOverrideMiddleware` consumes:
 *
 *   - `model_override`  — one model id for every agent (global)
 *   - `model_overrides` — `{<agent id>: <model id>}`; the role entry wins over
 *     the global for that agent
 *
 * The same handoff carries the LLM/runtime knobs saved beside the model policy:
 * `reasoning_effort`, `llm_max_output_tokens`, `llm_disable_streaming`,
 * `budget_engagement_usd`, `budget_per_agent_usd`, `budget_soft_warn_at_pct`
 * (a FRACTION, not a percent) and `hitl_enabled`.
 * They are kickoff-only: the CLI sets them once on the run input, the Platform
 * persists the declared channels into the checkpoint, and the middleware
 * re-reads state on every model call — so a resume / `answerQuestion` update
 * keeps sending only `model_override` and the whole policy stays in force for
 * the thread. Changing it means starting a new terminal session.
 *
 * Provider extra headers are NOT part of this wire: they are a startup-only
 * deployment value the agent reads from its own environment
 * (`DECEPTICON_LLM_EXTRA_HEADERS`), so no header ever travels on the run input.
 *
 * Priority: an explicit in-session `/model` choice beats the saved policy, and
 * none of the run fields built here ever overrides an explicit per-run argument
 * — a caller that passes its own run input is the last word.
 *
 * The env var names and length caps are duplicated from the web helper on
 * purpose: this package builds and runs standalone (`tsc`, no bundler alias into
 * the web workspace), so the wire contract is written twice rather than
 * imported. `runOverrides.test.ts` and `clients/web/src/lib/run-settings.test.ts`
 * pin the same boundaries.
 *
 * The `/model` slash command keeps working unchanged: it writes the in-process
 * override, which wins over the saved policy — an explicit action typed in this
 * terminal is the more recent intent.
 */

import { getModelOverride } from "./modelOverride.js";

export const RUN_MODEL_OVERRIDE_ENV = "DECEPTICON_RUN_MODEL_OVERRIDE";
export const RUN_MODEL_OVERRIDES_ENV = "DECEPTICON_RUN_MODEL_OVERRIDES";
export const RUN_REASONING_EFFORT_ENV = "DECEPTICON_RUN_REASONING_EFFORT";
export const RUN_LLM_MAX_OUTPUT_TOKENS_ENV = "DECEPTICON_RUN_LLM_MAX_OUTPUT_TOKENS";
export const RUN_LLM_DISABLE_STREAMING_ENV = "DECEPTICON_RUN_LLM_DISABLE_STREAMING";
export const RUN_BUDGET_ENGAGEMENT_USD_ENV = "DECEPTICON_RUN_BUDGET_ENGAGEMENT_USD";
export const RUN_BUDGET_PER_AGENT_USD_ENV = "DECEPTICON_RUN_BUDGET_PER_AGENT_USD";
export const RUN_BUDGET_SOFT_WARN_AT_PCT_ENV = "DECEPTICON_RUN_BUDGET_SOFT_WARN_AT_PCT";
export const RUN_HITL_ENABLED_ENV = "DECEPTICON_RUN_HITL_ENABLED";

/** Must match `clients/web/src/lib/run-settings.ts`. */
const MAX_ROLES = 64;
const MAX_ROLE_LENGTH = 64;
export const MAX_MODEL_LENGTH = 256;

/** Caps shared with the web helper that emits the run knobs. */
const MAX_OUTPUT_TOKENS = { min: 256, max: 128000 };
const MAX_BUDGET_USD = 1000000;
const MAX_SOFT_WARN_PCT = 1;

/**
 * Levels the run input forwards VERBATIM, mirroring `REASONING_EFFORTS` minus
 * `none`. `none` is the deployment "send no parameter" value and unknown text
 * is store corruption, so neither reaches the agent. The value itself is never
 * mapped or clamped per model: a family that rejects the level fails loudly at
 * the provider instead of silently running at a different depth.
 */
const FORWARDED_REASONING_EFFORTS: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/**
 * The core's truthy spellings (`telemetry.config._TRUTHY`); every other value,
 * including an unset variable, means "run field absent" — the fields they gate
 * are opt-in, so an unknown spelling must not enable them.
 */
const TRUTHY: Record<string, true> = { "1": true, true: true, yes: true, on: true };

type Env = Record<string, string | undefined>;

/** Run input fields consumed by the agent's model-override middleware. */
export interface RunOverrides {
  model_override?: string;
  model_overrides?: Record<string, string>;
  /** Must be one of "low" | "medium" | "high" | "xhigh" | "max". */
  reasoning_effort?: string;
  llm_max_output_tokens?: number;
  llm_disable_streaming?: boolean;
  budget_engagement_usd?: number;
  budget_per_agent_usd?: number;
  /** A FRACTION in (0, 1]; the UI edits percent and converts before emitting. */
  budget_soft_warn_at_pct?: number;
  hitl_enabled?: boolean;
}

/** A model id is a single non-empty token; anything longer is store corruption. */
function usableModelId(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  return trimmed.length > 0 && trimmed.length <= MAX_MODEL_LENGTH ? trimmed : "";
}

/**
 * Parse the role→model map the terminal server forwarded.
 *
 * Values are re-sanitised here rather than trusted: the payload crossed a
 * process boundary and is read from an environment variable a wrapper script
 * can also set. Malformed entries are dropped instead of forwarded — a partial
 * map must never silently become "this agent has no model".
 */
function parseRoleOverrides(raw: string | undefined): Record<string, string> {
  const text = raw?.trim();
  if (!text) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const roles: Record<string, string> = {};
  for (const [role, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Object.keys(roles).length >= MAX_ROLES) break;
    const name = role.trim();
    const modelId = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > MAX_ROLE_LENGTH) continue;
    if (!modelId || modelId.length > MAX_MODEL_LENGTH) continue;
    roles[name] = modelId;
  }
  return roles;
}

/**
 * A whole integer inside `[min, max]`. `Number()` alone is too permissive — it
 * accepts `0x10`, `1e3` and `Infinity`, none of which the settings store emits —
 * so the digits are checked first. Returns `null` for absent and malformed
 * alike: both mean "omit the field".
 */
function parseBoundedInteger(raw: string | undefined, min: number, max: number): number | null {
  const text = raw?.trim() ?? "";
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/**
 * A decimal above zero and at most `max`; `null` means "omit the field". The
 * contract says "finite number", so any spelling `Number()` reads finitely is
 * taken — the only rejections are non-numeric text, `Infinity`/`NaN` and values
 * outside the window, none of which can be a saved policy.
 */
function parseBoundedDecimal(raw: string | undefined, max: number): number | null {
  const text = raw?.trim() ?? "";
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

/**
 * The run input fields for a KICKOFF run.
 *
 * Every value is re-validated here, never trusted: the payload crossed a
 * process boundary and a wrapper script can set the same variables. A value
 * that fails its rule is dropped — malformed input must never forward a partial
 * policy — and omitted fields are ABSENT from the result rather than present as
 * `undefined`, so an untouched run payload stays byte-identical to a deployment
 * with nothing configured, which is what "no override" means.
 */
export function getRunOverrides(env: Env = process.env): RunOverrides {
  const overrides: RunOverrides = {};

  // In-session `/model` beats the saved policy; the saved global is the fallback.
  const global = getModelOverride().trim() || usableModelId(env[RUN_MODEL_OVERRIDE_ENV]);
  if (global) overrides.model_override = global;

  const roles = parseRoleOverrides(env[RUN_MODEL_OVERRIDES_ENV]);
  if (Object.keys(roles).length > 0) overrides.model_overrides = roles;

  const reasoningEffort = env[RUN_REASONING_EFFORT_ENV]?.trim() ?? "";
  if (Object.hasOwn(FORWARDED_REASONING_EFFORTS, reasoningEffort)) {
    overrides.reasoning_effort = reasoningEffort;
  }

  const maxOutputTokens = parseBoundedInteger(
    env[RUN_LLM_MAX_OUTPUT_TOKENS_ENV],
    MAX_OUTPUT_TOKENS.min,
    MAX_OUTPUT_TOKENS.max,
  );
  if (maxOutputTokens !== null) overrides.llm_max_output_tokens = maxOutputTokens;

  if (Object.hasOwn(TRUTHY, env[RUN_LLM_DISABLE_STREAMING_ENV]?.trim().toLowerCase() ?? "")) {
    overrides.llm_disable_streaming = true;
  }

  const engagementUsd = parseBoundedDecimal(env[RUN_BUDGET_ENGAGEMENT_USD_ENV], MAX_BUDGET_USD);
  if (engagementUsd !== null) overrides.budget_engagement_usd = engagementUsd;

  const perAgentUsd = parseBoundedDecimal(env[RUN_BUDGET_PER_AGENT_USD_ENV], MAX_BUDGET_USD);
  if (perAgentUsd !== null) overrides.budget_per_agent_usd = perAgentUsd;

  const softWarnPct = parseBoundedDecimal(env[RUN_BUDGET_SOFT_WARN_AT_PCT_ENV], MAX_SOFT_WARN_PCT);
  if (softWarnPct !== null) overrides.budget_soft_warn_at_pct = softWarnPct;

  if (Object.hasOwn(TRUTHY, env[RUN_HITL_ENABLED_ENV]?.trim().toLowerCase() ?? "")) {
    overrides.hitl_enabled = true;
  }

  return overrides;
}

/**
 * Global override value for a resume / answer update.
 *
 * Explicit even when empty: a resume update writes the value back into the
 * checkpointed `model_override` channel, so `""` is how a cleared override
 * stops applying to the thread. The other run fields are kickoff-only and stay
 * in the checkpoint, so an update sends just this one. Priority: in-session
 * `/model` → saved policy → cleared.
 */
export function getRunModelOverride(env: Env = process.env): string {
  return getModelOverride().trim() || usableModelId(env[RUN_MODEL_OVERRIDE_ENV]);
}
