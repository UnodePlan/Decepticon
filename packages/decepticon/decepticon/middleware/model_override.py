"""Runtime model override — power for the CLI ``/model`` command.

Reads ``model_override`` from runtime context or the declared graph state
channel (set by CLI run input or resume updates) and rebinds the LLM
for the wrapped invocation. The override is per-call, not per-process,
so flipping the model in the REPL takes effect on the next ``submit()``
without restarting the agent or rebuilding the langgraph stack.

Resolution order, in priority:

  1. ``request.runtime.context.model_override`` (set by Runtime context)
  2. ``request.state["model_override"]`` (set by input state field)

When neither is set, the wrapped handler is called with the original
LLM untouched (the ``factory.get_model("decepticon")`` baked in at
agent construction).

Paired with :class:`OverrideRespectingModelFallbackMiddleware` (exported from
this module and installed in the MODEL_FALLBACK slot): while this run pins an
override, that fallback middleware skips its chain so the override's provider
failure is reported instead of retried against a vendor the operator never
configured. See the class docstring for the failure matrix.

The override value can be:
  - A LiteLLM model id like ``anthropic/claude-opus-4-7`` or
    ``groq/llama-3.3-70b-versatile`` — gets routed through the same
    LiteLLM proxy the rest of the stack uses.
  - An empty string or None — equivalent to no override.

The same middleware also applies the LLM/runtime run policy saved beside the
model policy (``reasoning_effort``, ``llm_max_output_tokens``,
``llm_disable_streaming``, ``budget_*``, ``hitl_enabled``). Those are
constructor-level knobs of the bound chat model, so they cannot ride
``request.model_settings`` (which only binds invocation kwargs — ``streaming``
placed there would be ignored). They are applied to the effective model with
``model_copy`` instead; see ``_apply_run_llm_params``.

Provider extra headers are deliberately absent from the run state: they are a
startup-only deployment value that ``llm/factory.py::_resolve_extra_headers()``
resolves from the agent process environment when the model is constructed, and
a header value must never be persisted into the LangGraph checkpoint.

Failure modes:
  - Unknown / malformed model id surfaces at the next provider call
    as a 404 wrapped through ``_reraise_with_actionable_message``;
    middleware does not pre-validate (kept dumb so the operator can
    experiment with brand-new model ids without a release).
  - An override that cannot be BOUND at all raises
    :class:`ModelOverrideUnavailableError` instead of running the call on
    the leftover baseline model. Silent substitution is the bug, not the
    safety net: with a placeholder Ollama Cloud key in ``.env`` the
    baseline is ``ollama_cloud/llama3.2``, so a fallthrough quietly ran
    every "custom channel" run against the wrong provider.
  - A bound override whose PROVIDER CALL fails does not continue on another
    vendor either: :class:`OverrideRespectingModelFallbackMiddleware` skips
    the fallback chain while a run override is pinned, so the provider's own
    (already actionable) error propagates. An operator who only wired one
    channel must never receive an answer produced by a different provider.
  - A run knob outside its wire bound is dropped rather than forwarded
    (``_read_run_llm_params``); a malformed knob must never widen what
    the agent sends upstream.
"""

from __future__ import annotations

import math
import re
from typing import Any

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware, ModelFallbackMiddleware
from langchain.agents.middleware.types import ModelRequest
from langchain_core.language_models import BaseChatModel
from typing_extensions import Annotated, NotRequired, override

from decepticon.llm.factory import (
    LLMFactory,
    _model_accepts_reasoning_effort,
    _redact_secrets,
)
from decepticon.middleware.state_reducers import reduce_converging_value
from decepticon_core.types.llm import LLMModelMapping
from decepticon_core.utils.logging import get_logger

log = get_logger("middleware.model_override")

# Wire bounds for the run policy. Duplicated from the web/CLI emitters on
# purpose: the value crossed a process boundary and a wrapper script can set
# the same environment variable, so the agent core re-validates instead of
# trusting the payload. Mirrors ``clients/web/src/lib/run-settings.ts`` and
# ``clients/cli/src/commands/runOverrides.ts``.
#
# Every accepted level travels VERBATIM to the provider request: the run input
# never remaps ``xhigh``/``max`` onto a lower tier, so a family that does not
# support the chosen level fails loudly at the provider instead of silently
# running at a different depth. ``none`` means "send no parameter" and is not a
# member here — the emitter strips it before the value reaches the run input.
_REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_MIN_LLM_MAX_OUTPUT_TOKENS = 256
_MAX_LLM_MAX_OUTPUT_TOKENS = 128000
_MAX_BUDGET_USD = 1_000_000.0

# The run-policy keys THIS middleware binds to the model. ``budget_*`` and
# ``hitl_enabled`` ride the same state channels but are read by their own
# middleware, so logging them as an LLM setting here would misattribute them.
_BOUND_PARAM_KEYS = frozenset(
    {
        "reasoning_effort",
        "llm_max_output_tokens",
        "llm_disable_streaming",
    }
)


class ModelOverrideUnavailableError(RuntimeError):
    """Raised when a run asked for a model override that could not be bound.

    The middleware refuses to run the call on the leftover baseline model:
    the operator explicitly selected another model, and a silent fallback
    would answer from a provider they never chose (issue: a placeholder
    ``OLLAMA_CLOUD_API_KEY`` in ``.env`` made ``ollama_cloud/llama3.2`` the
    baseline of every agent). The message names the override and the
    baseline so the cause is actionable; credentials in the underlying
    exception text are redacted.
    """


def _read_override(request: Any, role: str | None = None) -> str:
    """Pull the override id out of runtime context or input state.

    Two shapes are honoured, in priority order:

      1. ``model_overrides`` — a ``{role: model_id}`` MAP. When ``role`` is
         present in the map, that per-agent model wins. This is the
         PER-AGENT policy surface — a multi-tenant host (e.g. the SaaS)
         threads one map per run so ``soundwave`` and ``exploit`` can run
         a different model than the rest WITHOUT an OSS release. Set once
         on the run (Runtime context or the ``model_overrides`` state
         channel, which propagates to sub-agents like ``proxy_api_key``).
      2. ``model_override`` — a single model id applied to EVERY agent
         (the CLI ``/model`` command). Fallback when the map has no entry
         for this role.

    Returns the empty string when nothing is set so the caller can
    short-circuit with a single truthiness check.
    """

    def _pick(container: Any) -> str:
        if not isinstance(container, dict):
            return ""
        if role:
            overrides = container.get("model_overrides")
            if isinstance(overrides, dict):
                value = overrides.get(role, "")
                if isinstance(value, str) and value.strip():
                    return value.strip()
        value = container.get("model_override", "")
        return value.strip() if isinstance(value, str) and value.strip() else ""

    runtime = getattr(request, "runtime", None)
    if runtime is not None:
        ctx = getattr(runtime, "context", None) or {}
        picked = _pick(ctx if isinstance(ctx, dict) else {})
        if picked:
            return picked
    state = getattr(request, "state", None) or {}
    if hasattr(state, "get"):
        picked = _pick(
            {
                "model_overrides": state.get("model_overrides"),
                "model_override": state.get("model_override", ""),
            }
        )
        if picked:
            return picked
    return ""


def _build_proxied_llm(model_id: str, original: BaseChatModel) -> BaseChatModel:
    """Use the factory's protocol and streaming settings for runtime overrides."""
    factory = LLMFactory(mapping=LLMModelMapping())
    return factory._create_chat_model(model_id, getattr(original, "temperature", None))


def _coerce_float(value: Any) -> float | None:
    """Best-effort finite float for a run-policy value.

    ``None`` for anything that is not a finite number. ``bool`` is rejected
    explicitly — it is an ``int`` subclass, so ``True`` would otherwise read
    as a budget of one dollar.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _coerce_int(value: Any) -> int | None:
    """Best-effort integer for a run-policy value.

    Accepts the int the run input carries and the decimal string a wrapper
    script may emit; rejects bools, floats with a fraction, and junk. A
    float like ``4096.0`` is accepted because JSON round-trips an integral
    number through either Python type.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    if isinstance(value, str):
        text = value.strip()
        return int(text) if re.fullmatch(r"[0-9]+", text) else None
    return None


def _read_run_llm_params(request: Any) -> dict[str, Any]:
    """Pull the run's LLM/runtime policy out of runtime context or input state.

    Same resolution order and container handling as :func:`_read_override`:
    ``request.runtime.context`` first, then ``request.state``. The values are
    re-validated here rather than trusted — they crossed a process boundary
    (web terminal → PTY env → CLI → run ``input``) and a wrapper script can
    set the same environment variables. A value outside its wire bound is
    DROPPED, not clamped: a malformed knob must not silently widen what the
    agent sends upstream.

    Only usable keys are returned, so an absent setting stays absent and a
    run that configures nothing produces an empty dict — the caller uses that
    for a byte-identical pass-through.
    """
    containers: list[Any] = []
    runtime = getattr(request, "runtime", None)
    if runtime is not None:
        ctx = getattr(runtime, "context", None)
        if isinstance(ctx, dict):
            containers.append(ctx)
    state = getattr(request, "state", None) or {}
    if hasattr(state, "get"):
        containers.append(state)

    def _raw(key: str) -> Any:
        for container in containers:
            value = container.get(key)
            if value is not None:
                return value
        return None

    params: dict[str, Any] = {}

    effort = _raw("reasoning_effort")
    if isinstance(effort, str) and effort.strip().lower() in _REASONING_EFFORTS:
        params["reasoning_effort"] = effort.strip().lower()

    max_output = _coerce_int(_raw("llm_max_output_tokens"))
    if (
        max_output is not None
        and _MIN_LLM_MAX_OUTPUT_TOKENS <= max_output <= _MAX_LLM_MAX_OUTPUT_TOKENS
    ):
        params["llm_max_output_tokens"] = max_output

    # The wire only ever sends the opt-in spellings (``"1"``), so a value that
    # is not exactly True means "unset" rather than "force streaming on".
    if _raw("llm_disable_streaming") is True:
        params["llm_disable_streaming"] = True

    for key in ("budget_engagement_usd", "budget_per_agent_usd"):
        cap = _coerce_float(_raw(key))
        if cap is not None and 0 < cap <= _MAX_BUDGET_USD:
            params[key] = cap

    # A FRACTION, matching ``DECEPTICON_BUDGET__SOFT_WARN_AT_PCT`` and
    # ``BudgetEnforcementMiddleware(soft_warn_at_pct=0.7)`` — the UI edits
    # percent and converts before emitting.
    soft_warn = _coerce_float(_raw("budget_soft_warn_at_pct"))
    if soft_warn is not None and 0 < soft_warn <= 1:
        params["budget_soft_warn_at_pct"] = soft_warn

    if _raw("hitl_enabled") is True:
        params["hitl_enabled"] = True

    return params


def _model_id_of(model: Any) -> str:
    """Best-effort model id for a bound chat model (``model_name`` then ``model``)."""
    return str(getattr(model, "model_name", "") or getattr(model, "model", "") or "")


def _apply_run_llm_params(
    model: BaseChatModel, params: dict[str, Any], model_id: str
) -> BaseChatModel:
    """Return a new model with the run's LLM knobs applied.

    ``model_copy`` rather than ``request.model_settings``: these are
    constructor-level knobs of the chat model, and ``model_settings`` only
    binds invocation kwargs — ``streaming`` placed there is ignored, because
    ``ChatOpenAI`` builds each request payload from its own fields
    (``_default_params``) plus the per-call kwargs.

    ``reasoning_effort`` is attached only for the families whose LiteLLM
    handler maps it (``_model_accepts_reasoning_effort``); every other
    provider 400s on the unknown body param. Returns ``model`` itself when
    nothing applies, so a run whose knobs are all inapplicable keeps the
    original object.
    """
    update: dict[str, Any] = {}
    if "llm_max_output_tokens" in params:
        update["max_tokens"] = params["llm_max_output_tokens"]
    if params.get("llm_disable_streaming"):
        # ``stream_usage`` rides the same switch: streaming responses omit
        # usage unless requested, so asking for usage on a non-streaming call
        # would add a ``stream_options`` the call cannot use.
        update["streaming"] = False
        update["stream_usage"] = False
    if "reasoning_effort" in params and _model_accepts_reasoning_effort(model_id):
        update["reasoning_effort"] = params["reasoning_effort"]
    if not update:
        return model
    return model.model_copy(update=update)


class ModelOverridesState(AgentState):
    """Declares global and per-role model channels on the orchestrator graph.

    Mirrors ``ProxyKeyState`` (see ``proxy_key_override``). The Platform
    DROPS an undeclared key from run ``input``, so without this channel a
    SaaS caller threading a per-role model map via run ``input`` could
    never reach ``request.state`` (the middleware's reachable read path;
    ``runtime.context`` needs a top-level ``context`` field the Platform
    forbids alongside ``config.configurable``). Set once on the kickoff
    run, persisted to the checkpoint, read on every model call.

    Reducer — ``reduce_converging_value`` (NOT the default LastValue):
    the orchestrator dispatches sub-agents in the SAME super-step and
    deepagents copies parent state (incl. ``model_overrides``) into each,
    so every sub-agent writes the map back to the parent in one tick. A
    LastValue channel rejects >1 write per step; a converging reducer
    keeps the (identical) non-None write. Same treatment ``proxy_api_key``
    and the launcher-set context channels already use.

    The run's LLM/runtime policy rides the same declaration for the same
    reason — the CLI sets each field once on the kickoff run and every
    sub-agent copies it back in one super-step:

      * ``reasoning_effort`` / ``llm_max_output_tokens`` /
        ``llm_disable_streaming`` — read by this middleware and applied to
        the bound model per call.
      * ``budget_engagement_usd`` / ``budget_per_agent_usd`` /
        ``budget_soft_warn_at_pct`` (a FRACTION in ``(0, 1]``) — read by
        ``BudgetEnforcementMiddleware``.
      * ``hitl_enabled`` — read by ``HITLApprovalMiddleware``.
    """

    model_overrides: NotRequired[Annotated[dict, reduce_converging_value]]
    model_override: NotRequired[Annotated[str, reduce_converging_value]]
    reasoning_effort: NotRequired[Annotated[str, reduce_converging_value]]
    llm_max_output_tokens: NotRequired[Annotated[int, reduce_converging_value]]
    llm_disable_streaming: NotRequired[Annotated[bool, reduce_converging_value]]
    budget_engagement_usd: NotRequired[Annotated[float, reduce_converging_value]]
    budget_per_agent_usd: NotRequired[Annotated[float, reduce_converging_value]]
    budget_soft_warn_at_pct: NotRequired[Annotated[float, reduce_converging_value]]
    hitl_enabled: NotRequired[Annotated[bool, reduce_converging_value]]


class OverrideRespectingModelFallbackMiddleware(ModelFallbackMiddleware):
    """``ModelFallbackMiddleware`` that yields to an explicit run override.

    The fallback chain is built from the *baseline* credentials inventory
    (e.g. ``anthropic/…`` → ``openai/…`` → local Ollama) and exists so a
    transient provider failure on the vetted default still gets an answer.
    That reasoning does not transfer to an override: ``/model``, a per-role
    ``model_overrides`` entry, or a saved custom channel is the operator's
    explicit provider choice, so continuing on a fallback model would answer
    from a vendor they never selected — with their own master proxy key, for a
    deployment that wired exactly one channel.

    Behaviour:

      * No override pinned for this run → identical to the parent class
        (baseline chain walked on failure).
      * Override pinned, provider call fails → the chain is skipped and the
        original error propagates, wrapped by
        ``_reraise_with_actionable_message`` exactly as without a fallback
        chain. A bad-but-valid model id keeps failing loudly at the provider.

    The check reuses the very reader the override middleware binds with
    (:func:`_read_override`) and the middleware's ``role``, so a per-role map
    and the global override are treated identically, and the two middlewares
    cannot disagree about whether an override is active.
    """

    def __init__(
        self,
        first_model: str | BaseChatModel,
        *additional_models: str | BaseChatModel,
        role: str | None = None,
    ) -> None:
        super().__init__(first_model, *additional_models)
        self._role = role

    def _override_pinned(self, request: ModelRequest[Any]) -> str:
        return _read_override(request, self._role)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Any,
    ) -> Any:
        if self._override_pinned(request):
            return handler(request)
        return super().wrap_model_call(request, handler)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Any,
    ) -> Any:
        if self._override_pinned(request):
            return await handler(request)
        return await super().awrap_model_call(request, handler)


class ModelOverrideMiddleware(AgentMiddleware):
    """Per-invocation model swap driven by Runtime context / input state.

    Wired into every agent's middleware stack AHEAD of
    ``OverrideRespectingModelFallbackMiddleware`` so the override picks the new
    primary. That fallback middleware still walks the configured chain for the
    *baseline* model, but deliberately skips the chain while this run has an
    override pinned: the override is the operator's explicit provider choice,
    so a failing override surfaces its own provider error instead of being
    retried against a vendor the user never selected.

    ``role`` is the agent this instance is attached to (the slot factory
    passes it). It lets a per-role ``model_overrides`` map target this
    agent specifically; without it only the global ``model_override``
    (CLI ``/model``) applies.

    The saved LLM/runtime run policy is applied here too (see
    ``_read_run_llm_params`` / ``_apply_run_llm_params``) because this
    middleware owns the effective model for the call: the swap has to happen
    in one place or the knobs would land on the pre-swap model.
    """

    state_schema = ModelOverridesState

    def __init__(self, role: str | None = None) -> None:
        super().__init__()
        self._role = role

    @override
    def wrap_model_call(self, request, handler):
        return handler(self._effective_request(request))

    @override
    async def awrap_model_call(self, request, handler):
        return await handler(self._effective_request(request))

    def _effective_request(self, request: Any) -> Any:
        """Return ``request`` with the run's model + LLM knobs bound.

        Reads BOTH policies (model override and the LLM/runtime run settings)
        and returns the request untouched when neither is set, so a run that
        configures nothing stays byte-identical — same call, same model
        object, no override object allocated.

        The override id picks the model first (``_build_proxied_llm``), then
        the run params are applied to whichever model is now effective, so an
        override target gets the operator's knobs too.

        A bind failure RAISES (:class:`ModelOverrideUnavailableError`) instead
        of falling through to the original handler: the user explicitly asked
        for another model, and running the call on the leftover baseline
        (``ollama_cloud/llama3.2`` in a deployment that only wired its own
        LiteLLM channel) is an invisible substitution — the operator sees a
        plausible answer from the wrong provider. A bogus-but-syntactically
        valid model id still BINDS here and fails at the provider with the
        actionable 404, so experimenting with new ids stays supported; only a
        genuinely unbuildable override (malformed proxy/LLM config, bad extra
        headers) refuses to run. Run params that cannot apply to the effective
        model (``reasoning_effort`` on a family whose LiteLLM route does not
        map it) still leave the request alone.
        """
        override_id = _read_override(request, self._role)
        params = _read_run_llm_params(request)
        if not override_id and not params:
            return request
        model = request.model
        if override_id:
            try:
                model = _build_proxied_llm(override_id, model)
            except Exception as exc:
                baseline_id = _model_id_of(model)
                log.error(
                    "model_override %s failed to bind (%s); refusing to fall back to %s",
                    override_id,
                    type(exc).__name__,
                    baseline_id or "<baseline>",
                )
                raise ModelOverrideUnavailableError(
                    f"model override {override_id!r} could not be applied "
                    f"({type(exc).__name__}: {_redact_secrets(str(exc))}). "
                    f"Refusing to silently fall back to the baseline model "
                    f"{baseline_id or '<unknown>'!r} — fix the override (or clear it with "
                    f"``/model``) and retry."
                ) from exc
            log.info("model_override active: %s", override_id)
        model = _apply_run_llm_params(model, params, _model_id_of(model))
        if model is request.model:
            # Nothing applied (e.g. ``reasoning_effort`` for a family whose
            # route does not map it) — keep the original request.
            return request
        model_id = _model_id_of(model)
        if params:
            bound_keys = [
                key
                for key in sorted(params)
                if key in _BOUND_PARAM_KEYS
                and (key != "reasoning_effort" or _model_accepts_reasoning_effort(model_id))
            ]
            log.info("run llm settings active on %s: %s", model_id, ", ".join(bound_keys))
        return request.override(model=model)


__all__ = [
    "ModelOverrideMiddleware",
    "ModelOverrideUnavailableError",
    "ModelOverridesState",
    "OverrideRespectingModelFallbackMiddleware",
]
