/**
 * Per-process model override store.
 *
 * The /model slash command writes here; `commands/runOverrides.ts` reads here
 * when building the LangGraph run input, so each submit() carries the current
 * override in the `model_override` field the agent's ModelOverrideMiddleware
 * consumes — it rebinds the LLM for the call without restarting anything. The
 * dashboard's saved policy sits UNDER this value: it is the fallback when the
 * operator has not typed `/model` in this terminal.
 *
 * Empty string == no override.
 */

let _override = "";

export function setModelOverride(id: string): void {
  _override = id.trim();
}

export function getModelOverride(): string {
  return _override;
}
