import { expect, test } from "vitest";
import {
  MAX_MODEL_LENGTH,
  RUN_BUDGET_ENGAGEMENT_USD_ENV,
  RUN_BUDGET_PER_AGENT_USD_ENV,
  RUN_BUDGET_SOFT_WARN_AT_PCT_ENV,
  RUN_HITL_ENABLED_ENV,
  RUN_LLM_DISABLE_STREAMING_ENV,
  RUN_LLM_MAX_OUTPUT_TOKENS_ENV,
  RUN_MODEL_OVERRIDE_ENV,
  RUN_MODEL_OVERRIDES_ENV,
  RUN_REASONING_EFFORT_ENV,
  getRunModelOverride,
  getRunOverrides,
} from "./runOverrides";
import { setModelOverride } from "./modelOverride";

const ROLE_ENV = "DECEPTICON_RUN_MODEL_OVERRIDES";

test("no saved policy yields no run fields", () => {
  expect(getRunOverrides({})).toEqual({});
  expect(getRunOverrides({ DECEPTICON_RUN_MODEL_OVERRIDE: "   " })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: "   " })).toEqual({});
  expect(getRunModelOverride({})).toBe("");
});

test("malformed role maps are dropped instead of reaching the run input", () => {
  expect(getRunOverrides({ [ROLE_ENV]: "not json" })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: '["auth/x"]' })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: '"auth/x"' })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: "42" })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: "null" })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: JSON.stringify({ soundwave: "  " }) })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: JSON.stringify({ "": "auth/x" }) })).toEqual({});
  expect(getRunOverrides({ [ROLE_ENV]: JSON.stringify({ soundwave: 42 }) })).toEqual({});
});

test("the global override travels as one model id", () => {
  expect(getRunOverrides({ DECEPTICON_RUN_MODEL_OVERRIDE: " openai/gpt-5.5 " })).toEqual({
    model_override: "openai/gpt-5.5",
  });
});

test("role overrides are forwarded one model id per agent", () => {
  const overrides = getRunOverrides({
    DECEPTICON_RUN_MODEL_OVERRIDE: "openai/gpt-5.5",
    [ROLE_ENV]: JSON.stringify({ soundwave: "auth/claude-sonnet-5", "  exploit  ": " groq/llama " }),
  });
  expect(overrides).toEqual({
    model_override: "openai/gpt-5.5",
    model_overrides: { soundwave: "auth/claude-sonnet-5", exploit: "groq/llama" },
  });
});

test("oversized models and role maps are rejected as corruption", () => {
  const longId = "x".repeat(MAX_MODEL_LENGTH + 1);
  expect(getRunOverrides({ DECEPTICON_RUN_MODEL_OVERRIDE: longId })).toEqual({});
  expect(getRunModelOverride({ DECEPTICON_RUN_MODEL_OVERRIDE: longId })).toBe("");

  const roles: Record<string, string> = {};
  for (let index = 0; index < 100; index += 1) roles[`agent-${index}`] = "auth/x";
  const capped = getRunOverrides({ [ROLE_ENV]: JSON.stringify(roles) });
  expect(Object.keys(capped.model_overrides ?? {}).length).toBe(64);
});

test("the in-session /model choice wins over the saved policy", () => {
  const env = {
    DECEPTICON_RUN_MODEL_OVERRIDE: "openai/gpt-5.5",
    [ROLE_ENV]: JSON.stringify({ soundwave: "auth/gpt-6-luna" }),
  };
  setModelOverride("groq/llama-3.3-70b-versatile");
  try {
    expect(getRunOverrides(env)).toEqual({
      model_override: "groq/llama-3.3-70b-versatile",
      model_overrides: { soundwave: "auth/gpt-6-luna" },
    });
    expect(getRunModelOverride(env)).toBe("groq/llama-3.3-70b-versatile");
  } finally {
    setModelOverride("");
  }
});

test("without an in-session choice the saved global is the fallback", () => {
  expect(getRunOverrides({ DECEPTICON_RUN_MODEL_OVERRIDE: "openai/gpt-5.5" })).toEqual({
    model_override: "openai/gpt-5.5",
  });
  expect(getRunModelOverride({ DECEPTICON_RUN_MODEL_OVERRIDE: "openai/gpt-5.5" })).toBe("openai/gpt-5.5");
  expect(getRunModelOverride({ DECEPTICON_RUN_MODEL_OVERRIDE: "   " })).toBe("");
});

// ── LLM / runtime knobs ───────────────────────────────────────────────

test("the run env var names are the frozen wire contract", () => {
  expect(RUN_MODEL_OVERRIDE_ENV).toBe("DECEPTICON_RUN_MODEL_OVERRIDE");
  expect(RUN_MODEL_OVERRIDES_ENV).toBe("DECEPTICON_RUN_MODEL_OVERRIDES");
  expect(RUN_REASONING_EFFORT_ENV).toBe("DECEPTICON_RUN_REASONING_EFFORT");
  expect(RUN_LLM_MAX_OUTPUT_TOKENS_ENV).toBe("DECEPTICON_RUN_LLM_MAX_OUTPUT_TOKENS");
  expect(RUN_LLM_DISABLE_STREAMING_ENV).toBe("DECEPTICON_RUN_LLM_DISABLE_STREAMING");
  expect(RUN_BUDGET_ENGAGEMENT_USD_ENV).toBe("DECEPTICON_RUN_BUDGET_ENGAGEMENT_USD");
  expect(RUN_BUDGET_PER_AGENT_USD_ENV).toBe("DECEPTICON_RUN_BUDGET_PER_AGENT_USD");
  expect(RUN_BUDGET_SOFT_WARN_AT_PCT_ENV).toBe("DECEPTICON_RUN_BUDGET_SOFT_WARN_AT_PCT");
  expect(RUN_HITL_ENABLED_ENV).toBe("DECEPTICON_RUN_HITL_ENABLED");
});

test("an untouched environment omits every run field", () => {
  const overrides = getRunOverrides({});
  expect(overrides).toEqual({});
  for (const key of [
    "model_override",
    "model_overrides",
    "reasoning_effort",
    "llm_max_output_tokens",
    "llm_disable_streaming",
    "budget_engagement_usd",
    "budget_per_agent_usd",
    "budget_soft_warn_at_pct",
    "hitl_enabled",
  ]) {
    expect(key in overrides).toBe(false);
  }
});

test("a full policy maps one env var per run field", () => {
  expect(
    getRunOverrides({
      [RUN_MODEL_OVERRIDE_ENV]: "openai/gpt-5.5",
      [ROLE_ENV]: JSON.stringify({ soundwave: "auth/claude-sonnet-5" }),
      [RUN_REASONING_EFFORT_ENV]: "high",
      [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: "32000",
      [RUN_LLM_DISABLE_STREAMING_ENV]: "1",
      [RUN_BUDGET_ENGAGEMENT_USD_ENV]: "250.5",
      [RUN_BUDGET_PER_AGENT_USD_ENV]: "12",
      [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: "0.7",
      [RUN_HITL_ENABLED_ENV]: "true",
    }),
  ).toEqual({
    model_override: "openai/gpt-5.5",
    model_overrides: { soundwave: "auth/claude-sonnet-5" },
    reasoning_effort: "high",
    llm_max_output_tokens: 32000,
    llm_disable_streaming: true,
    budget_engagement_usd: 250.5,
    budget_per_agent_usd: 12,
    budget_soft_warn_at_pct: 0.7,
    hitl_enabled: true,
  });
});

test("reasoning effort forwards the five known levels verbatim", () => {
  // Whitespace is trimmed like every other value on this wire; the level itself
  // is matched exactly and never remapped per model, so `xhigh`/`max` travel
  // as-is and `none` (the deployment "send no parameter") stays out.
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    expect(getRunOverrides({ [RUN_REASONING_EFFORT_ENV]: ` ${level} ` })).toEqual({
      reasoning_effort: level,
    });
  }

  for (const raw of ["HIGH", "XHIGH", "extreme", "ultra", "minimal", "none", "true", "1", "", "  "]) {
    const overrides = getRunOverrides({ [RUN_REASONING_EFFORT_ENV]: raw });
    expect(overrides, `"${raw}" must be dropped`).toEqual({});
    expect("reasoning_effort" in overrides).toBe(false);
  }
});

test("max output tokens keeps the 256..128000 integer window", () => {
  expect(getRunOverrides({ [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: "256" })).toEqual({
    llm_max_output_tokens: 256,
  });
  expect(getRunOverrides({ [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: "128000" })).toEqual({
    llm_max_output_tokens: 128000,
  });

  for (const raw of ["255", "128001", "0", "-1", "256.5", "1e3", "abc", "", "  "]) {
    const overrides = getRunOverrides({ [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: raw });
    expect(overrides, `"${raw}" must be dropped`).toEqual({});
    expect("llm_max_output_tokens" in overrides).toBe(false);
  }
});

test("disable streaming is opt-in on the core's truthy spellings", () => {
  for (const raw of ["1", "true", "yes", "on", " TRUE ", "On"]) {
    expect(getRunOverrides({ [RUN_LLM_DISABLE_STREAMING_ENV]: raw })).toEqual({
      llm_disable_streaming: true,
    });
    expect(getRunOverrides({ [RUN_HITL_ENABLED_ENV]: raw })).toEqual({ hitl_enabled: true });
  }

  for (const raw of ["0", "false", "no", "off", "2", "enabled", "", "  "]) {
    const overrides = getRunOverrides({
      [RUN_LLM_DISABLE_STREAMING_ENV]: raw,
      [RUN_HITL_ENABLED_ENV]: raw,
    });
    expect(overrides, `"${raw}" must stay off`).toEqual({});
    expect("llm_disable_streaming" in overrides).toBe(false);
    expect("hitl_enabled" in overrides).toBe(false);
  }
});

test("the removed header env var never becomes a run field", () => {
  // Provider extra headers are a startup-only deployment value the agent reads
  // from its own environment; the run-input channel was deleted, so a value
  // left in the environment must not leak into a run override.
  const overrides = getRunOverrides({
    DECEPTICON_RUN_LLM_EXTRA_HEADERS: JSON.stringify({ "x-trace-id": "abc", Authorization: "nope" }),
  });
  expect(overrides).toEqual({});
  expect(JSON.stringify(overrides)).not.toContain("x-trace-id");
});

test("budgets must be positive numbers within the cap", () => {
  expect(getRunOverrides({ [RUN_BUDGET_ENGAGEMENT_USD_ENV]: "0.01" })).toEqual({
    budget_engagement_usd: 0.01,
  });
  expect(getRunOverrides({ [RUN_BUDGET_PER_AGENT_USD_ENV]: "1000000" })).toEqual({
    budget_per_agent_usd: 1000000,
  });

  for (const raw of ["0", "0.0", "1000000.01", "1000001", "-5", "abc", "Infinity", "", "  "]) {
    const overrides = getRunOverrides({
      [RUN_BUDGET_ENGAGEMENT_USD_ENV]: raw,
      [RUN_BUDGET_PER_AGENT_USD_ENV]: raw,
    });
    expect(overrides, `"${raw}" must be dropped`).toEqual({});
    expect("budget_engagement_usd" in overrides).toBe(false);
    expect("budget_per_agent_usd" in overrides).toBe(false);
  }
});

test("the soft-warn threshold is a FRACTION in (0, 1]", () => {
  expect(getRunOverrides({ [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: "0.5" })).toEqual({
    budget_soft_warn_at_pct: 0.5,
  });
  expect(getRunOverrides({ [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: "1" })).toEqual({
    budget_soft_warn_at_pct: 1,
  });

  // `0` would warn after the first dollar; `1.5`/`70` are percent values that
  // were not converted — both are dropped rather than reinterpreted.
  for (const raw of ["0", "1.5", "70", "-0.5", "abc", "", "  "]) {
    const overrides = getRunOverrides({ [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: raw });
    expect(overrides, `"${raw}" must be dropped`).toEqual({});
    expect("budget_soft_warn_at_pct" in overrides).toBe(false);
  }
});
