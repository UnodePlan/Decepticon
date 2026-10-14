/** Run-scoped settings handoff — the env mapping the PTY/CLI wire contract depends on. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_OVERRIDE_ROLES,
  RUN_BUDGET_ENGAGEMENT_USD_ENV,
  RUN_BUDGET_PER_AGENT_USD_ENV,
  RUN_BUDGET_SOFT_WARN_AT_PCT_ENV,
  RUN_HITL_ENABLED_ENV,
  RUN_LLM_DISABLE_STREAMING_ENV,
  RUN_LLM_MAX_OUTPUT_TOKENS_ENV,
  RUN_MODEL_OVERRIDE_ENV,
  RUN_MODEL_OVERRIDES_ENV,
  RUN_REASONING_EFFORT_ENV,
  runSettingsEnv,
} from "./run-settings";

/** A deployment with no LLM/budget baseline; every default lives in the code. */
const NO_ENV: Record<string, string | undefined> = {};

test("empty policy forwards no env at all", () => {
  assert.deepEqual(runSettingsEnv(undefined), {});
  assert.deepEqual(runSettingsEnv(null), {});
  assert.deepEqual(runSettingsEnv({}), {});
  assert.deepEqual(runSettingsEnv({ globalModelOverride: "   ", modelOverrides: {} }), {});
  assert.deepEqual(runSettingsEnv({ globalModelOverride: null, modelOverrides: null }), {});
});

test("global override is forwarded alone when no role map exists", () => {
  const env = runSettingsEnv({ globalModelOverride: " openai/gpt-5.5 " });
  assert.deepEqual(env, { [RUN_MODEL_OVERRIDE_ENV]: "openai/gpt-5.5" });
  assert.equal(RUN_MODEL_OVERRIDES_ENV in env, false, "no empty role map is forwarded");
});

test("role map is JSON-encoded alongside the global fallback", () => {
  const env = runSettingsEnv({
    globalModelOverride: "openai/gpt-5.5",
    modelOverrides: { soundwave: "auth/claude-sonnet-5", exploit: "auth/claude-opus-4-8" },
  });
  assert.equal(env[RUN_MODEL_OVERRIDE_ENV], "openai/gpt-5.5");
  assert.deepEqual(JSON.parse(env[RUN_MODEL_OVERRIDES_ENV]), {
    soundwave: "auth/claude-sonnet-5",
    exploit: "auth/claude-opus-4-8",
  });
});

test("malformed entries are dropped, never forwarded as partial policy", () => {
  const env = runSettingsEnv({
    globalModelOverride: 42 as unknown as string,
    modelOverrides: {
      "  ": "auth/x",
      soundwave: "   ",
      exploit: 7 as unknown as string,
      recon: "a".repeat(257),
      scanner: "openai/gpt-5.5",
    },
  });
  assert.equal(RUN_MODEL_OVERRIDE_ENV in env, false);
  assert.deepEqual(JSON.parse(env[RUN_MODEL_OVERRIDES_ENV]), { scanner: "openai/gpt-5.5" });
});

test("role map is capped so a corrupt store cannot bloat the PTY environment", () => {
  const source: Record<string, string> = {};
  for (let index = 0; index <= MAX_OVERRIDE_ROLES + 5; index += 1) {
    source[`role_${index}`] = `openai/model-${index}`;
  }
  const env = runSettingsEnv({ modelOverrides: source });
  const roles = JSON.parse(env[RUN_MODEL_OVERRIDES_ENV]) as Record<string, string>;
  assert.equal(Object.keys(roles).length, MAX_OVERRIDE_ROLES);
  assert.equal(roles.role_0, "openai/model-0");
  assert.equal("role_64" in roles, false);
});

test("every absent and defaulted setting is omitted, so an old payload stays byte-identical", () => {
  assert.deepEqual(
    runSettingsEnv(
      {
        globalModelOverride: "",
        modelOverrides: {},
        reasoningEffort: "none",
        llmMaxOutputTokens: 64000,
        llmDisableStreaming: false,
        budgetEngagementUsd: null,
        budgetPerAgentUsd: null,
        budgetSoftWarnAtPct: 70,
        hitlEnabled: false,
      },
      NO_ENV,
    ),
    {},
  );
  assert.deepEqual(runSettingsEnv({}, NO_ENV), {});
});

test("reasoning effort is forwarded verbatim for every accepted enum value", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(runSettingsEnv({ reasoningEffort: effort }, NO_ENV), {
      [RUN_REASONING_EFFORT_ENV]: effort,
    });
  }
  for (const rejected of [
    "none",
    "NONE",
    "High",
    "minimal",
    "maximal",
    "very-high",
    "",
    "   ",
    3 as unknown as string,
    null,
    undefined,
  ]) {
    const env = runSettingsEnv({ reasoningEffort: rejected as string }, NO_ENV);
    assert.equal(RUN_REASONING_EFFORT_ENV in env, false, `${String(rejected)} must not be forwarded`);
  }
  // Surrounding whitespace is trimmed like every other stored enum value.
  assert.deepEqual(runSettingsEnv({ reasoningEffort: " high " }, NO_ENV), { [RUN_REASONING_EFFORT_ENV]: "high" });
  assert.deepEqual(runSettingsEnv({ reasoningEffort: " xhigh " }, NO_ENV), { [RUN_REASONING_EFFORT_ENV]: "xhigh" });
});

test("max output tokens are forwarded only as an in-range integer", () => {
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 256 }, NO_ENV), {
    [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: "256",
  });
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 128000 }, NO_ENV), {
    [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: "128000",
  });
  for (const rejected of [255, 128001, 1024.5, Number.NaN, Number.POSITIVE_INFINITY, "8000", null, undefined]) {
    const env = runSettingsEnv({ llmMaxOutputTokens: rejected as number }, NO_ENV);
    assert.equal(RUN_LLM_MAX_OUTPUT_TOKENS_ENV in env, false, `${String(rejected)} must not be forwarded`);
  }
});

test("the deployment max-output default is omitted, not duplicated into the run input", () => {
  // No `DECEPTICON_LLM_MAX_TOKENS`: the agent process resolves 64000 itself.
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 64000 }, NO_ENV), {});
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 64000 }, { DECEPTICON_LLM_MAX_TOKENS: "  " }), {});
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 64000 }, { DECEPTICON_LLM_MAX_TOKENS: "0" }), {});
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 64000 }, { DECEPTICON_LLM_MAX_TOKENS: "junk" }), {});
  // An operator-set ceiling moves the default, so the same value is now forwarded.
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 64000 }, { DECEPTICON_LLM_MAX_TOKENS: "32000" }), {
    [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: "64000",
  });
  assert.deepEqual(runSettingsEnv({ llmMaxOutputTokens: 32000 }, { DECEPTICON_LLM_MAX_TOKENS: "32000" }), {});
});

test("disable-streaming is forwarded only when strictly true", () => {
  assert.deepEqual(runSettingsEnv({ llmDisableStreaming: true }, NO_ENV), {
    [RUN_LLM_DISABLE_STREAMING_ENV]: "1",
  });
  for (const rejected of [false, "true", 1, null, undefined]) {
    const env = runSettingsEnv({ llmDisableStreaming: rejected as boolean }, NO_ENV);
    assert.equal(RUN_LLM_DISABLE_STREAMING_ENV in env, false, `${String(rejected)} must not be forwarded`);
  }
});

test("no provider header value can enter the PTY environment", () => {
  // Extra headers are a startup-scoped deployment value: the agent process reads
  // `DECEPTICON_LLM_EXTRA_HEADERS` itself, and the run input must never carry a
  // value that would land in the LangGraph checkpoint.
  const env = runSettingsEnv(
    { llmExtraHeaders: { "X-Trace": "abc" } } as unknown as Parameters<typeof runSettingsEnv>[0],
    NO_ENV,
  );
  assert.deepEqual(env, {});
  assert.equal(
    Object.keys(env).some((name) => name.includes("HEADER")),
    false,
  );
});

test("budget caps are forwarded only when finite, positive and within the ceiling", () => {
  assert.deepEqual(
    runSettingsEnv({ budgetEngagementUsd: 25.5, budgetPerAgentUsd: 1 }, NO_ENV),
    {
      [RUN_BUDGET_ENGAGEMENT_USD_ENV]: "25.5",
      [RUN_BUDGET_PER_AGENT_USD_ENV]: "1",
    },
  );
  assert.deepEqual(runSettingsEnv({ budgetEngagementUsd: 1_000_000 }, NO_ENV), {
    [RUN_BUDGET_ENGAGEMENT_USD_ENV]: "1000000",
  });
  for (const rejected of [0, -1, 1_000_001, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
    const env = runSettingsEnv(
      { budgetEngagementUsd: rejected as number, budgetPerAgentUsd: rejected as number },
      NO_ENV,
    );
    assert.equal(RUN_BUDGET_ENGAGEMENT_USD_ENV in env, false, `${String(rejected)} must not be forwarded`);
    assert.equal(RUN_BUDGET_PER_AGENT_USD_ENV in env, false, `${String(rejected)} must not be forwarded`);
  }
});

test("soft-warn percent is converted to a fraction and the deployment default is omitted", () => {
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 50 }, NO_ENV), {
    [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: "0.5",
  });
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 100 }, NO_ENV), {
    [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: "1",
  });
  // 70% is the deployment default when the env var is unset or malformed.
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 70 }, NO_ENV), {});
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 70 }, { DECEPTICON_BUDGET__SOFT_WARN_AT_PCT: "nope" }), {});
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 70 }, { DECEPTICON_BUDGET__SOFT_WARN_AT_PCT: "0" }), {});
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 70 }, { DECEPTICON_BUDGET__SOFT_WARN_AT_PCT: "1.5" }), {});
  // A deployment baseline of 0.5 makes 50% the new omitted default.
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 50 }, { DECEPTICON_BUDGET__SOFT_WARN_AT_PCT: "0.5" }), {});
  assert.deepEqual(runSettingsEnv({ budgetSoftWarnAtPct: 70 }, { DECEPTICON_BUDGET__SOFT_WARN_AT_PCT: "0.5" }), {
    [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: "0.7",
  });
  for (const rejected of [0, -5, 101, Number.NaN, Number.POSITIVE_INFINITY, "50", null, undefined]) {
    const env = runSettingsEnv({ budgetSoftWarnAtPct: rejected as number }, NO_ENV);
    assert.equal(RUN_BUDGET_SOFT_WARN_AT_PCT_ENV in env, false, `${String(rejected)} must not be forwarded`);
  }
});

test("hitl is forwarded only when strictly true", () => {
  assert.deepEqual(runSettingsEnv({ hitlEnabled: true }, NO_ENV), { [RUN_HITL_ENABLED_ENV]: "1" });
  for (const rejected of [false, "true", 1, null, undefined]) {
    const env = runSettingsEnv({ hitlEnabled: rejected as boolean }, NO_ENV);
    assert.equal(RUN_HITL_ENABLED_ENV in env, false, `${String(rejected)} must not be forwarded`);
  }
});

test("a fully-configured snapshot forwards every channel under its contract name", () => {
  const env = runSettingsEnv(
    {
      globalModelOverride: "openai/gpt-5.5",
      modelOverrides: { soundwave: "auth/claude-sonnet-5" },
      reasoningEffort: "high",
      llmMaxOutputTokens: 32000,
      llmDisableStreaming: true,
      budgetEngagementUsd: 100,
      budgetPerAgentUsd: 10,
      budgetSoftWarnAtPct: 80,
      hitlEnabled: true,
    },
    NO_ENV,
  );
  assert.deepEqual(env, {
    [RUN_MODEL_OVERRIDE_ENV]: "openai/gpt-5.5",
    [RUN_MODEL_OVERRIDES_ENV]: JSON.stringify({ soundwave: "auth/claude-sonnet-5" }),
    [RUN_REASONING_EFFORT_ENV]: "high",
    [RUN_LLM_MAX_OUTPUT_TOKENS_ENV]: "32000",
    [RUN_LLM_DISABLE_STREAMING_ENV]: "1",
    [RUN_BUDGET_ENGAGEMENT_USD_ENV]: "100",
    [RUN_BUDGET_PER_AGENT_USD_ENV]: "10",
    [RUN_BUDGET_SOFT_WARN_AT_PCT_ENV]: "0.8",
    [RUN_HITL_ENABLED_ENV]: "1",
  });
});

test("the model fields of a default snapshot are byte-identical to the pre-change mapping", () => {
  const before = runSettingsEnv({ globalModelOverride: "openai/gpt-5.5", modelOverrides: {} });
  const after = runSettingsEnv(
    {
      globalModelOverride: "openai/gpt-5.5",
      modelOverrides: {},
      reasoningEffort: "",
      llmMaxOutputTokens: 0,
      llmDisableStreaming: false,
      budgetEngagementUsd: 0,
      budgetPerAgentUsd: 0,
      budgetSoftWarnAtPct: 0,
      hitlEnabled: false,
    },
    NO_ENV,
  );
  assert.deepEqual(after, before);
  assert.deepEqual(Object.keys(after), [RUN_MODEL_OVERRIDE_ENV]);
});
