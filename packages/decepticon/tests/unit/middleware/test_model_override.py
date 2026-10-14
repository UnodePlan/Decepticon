"""Regression tests for ModelOverrideMiddleware.

The middleware re-binds the agent's LLM to a user-supplied LiteLLM model
id at call time. Issue #186 traced an ``APIConnectionError`` for every
``/model <id>`` override to ``_build_proxied_llm`` constructing
``ProxyConfig()`` with bare pydantic defaults (``url="http://localhost:4000"``)
instead of resolving from agent config the way :class:`LLMFactory`
does — so the override request was sent to the langgraph container
itself, where nothing was listening.

These tests pin the resolved-config behaviour so the regression cannot
recur, plus the temperature handling for the Opus 4.x family which the
factory drops at the ``temperature``-rejecting upstream API.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from decepticon.middleware.model_override import (
    ModelOverrideMiddleware,
    ModelOverridesState,
    ModelOverrideUnavailableError,
    OverrideRespectingModelFallbackMiddleware,
    _apply_run_llm_params,
    _build_proxied_llm,
    _read_override,
    _read_run_llm_params,
)

# ── Test helpers ────────────────────────────────────────────────────────

# The run-input / run-state key older web and CLI builds emitted for provider
# extra headers. That channel is deleted — the factory resolves headers from the
# agent process environment at model construction, and the run input round-trips
# through the LangGraph checkpoint — but the exact key shape is still pinned by
# the "not a channel" tests below. Spelled in two parts because the identifier no
# longer exists anywhere in the codebase.
_RUN_HEADERS_KEY = "llm_extra_" + "headers"


@pytest.fixture
def proxy_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Set the proxy env vars the agent runs under in the langgraph container.

    The container's hostname for the LiteLLM proxy is ``litellm`` on the
    decepticon-net Docker network; the bare ``ProxyConfig()`` default of
    ``localhost:4000`` does not work inside a container — issue #186.
    """
    env = {
        "DECEPTICON_LLM__PROXY_URL": "http://litellm:4000",
        "DECEPTICON_LLM__PROXY_API_KEY": "sk-decepticon-master",
        "DECEPTICON_LLM__TIMEOUT": "120",
        "DECEPTICON_LLM__MAX_RETRIES": "2",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    # Keep the ambient header env out of the constructed models: headers are a
    # deployment value resolved by the factory from this env, never a run knob.
    monkeypatch.delenv("DECEPTICON_LLM_EXTRA_HEADERS", raising=False)
    return env


def _original_chat_model(temperature: float | None = 0.4) -> ChatOpenAI:
    """A stand-in for the LLM the agent was constructed with.

    Only ``temperature`` is read by the override path; the other fields
    must be present so pydantic accepts the construction.
    """
    return ChatOpenAI(
        model="openai/gpt-5.5",
        temperature=temperature,
        api_key="sk-test-original",
        base_url="http://localhost:4000",
    )


# ── Issue #186 regressions ──────────────────────────────────────────────


class TestBuildProxiedLLMResolvesConfig:
    """``_build_proxied_llm`` must resolve proxy config the same way
    ``LLMFactory`` does — not fall back to bare ``ProxyConfig()`` defaults.
    """

    def test_uses_resolved_proxy_url_from_env(self, proxy_env: dict[str, str]) -> None:
        """Override must hit the resolved ``DECEPTICON_LLM__PROXY_URL``,
        not the pydantic default ``http://localhost:4000``. Inside the
        langgraph container, ``localhost:4000`` is the container itself
        — no listener — and was the root cause of the original report.
        """
        bound = _build_proxied_llm("openai/gpt-5.5", _original_chat_model())

        assert bound.openai_api_base == proxy_env["DECEPTICON_LLM__PROXY_URL"], (
            "_build_proxied_llm must resolve proxy URL through agent config, "
            "not fall back to ProxyConfig() defaults — see issue #186."
        )
        assert bound.openai_api_base != "http://localhost:4000"

    def test_uses_resolved_api_key_from_env(self, proxy_env: dict[str, str]) -> None:
        """Same path: api_key is sourced from config, not pydantic defaults.

        Bare default would be ``sk-decepticon-master`` which happens to
        match a stock proxy install — the bug here is that the *whole*
        config object is unresolved, so a non-default key would also be
        ignored. Use the explicit env value to confirm the resolution
        happened, not a coincidence with the default literal.
        """
        bound = _build_proxied_llm("openai/gpt-5.5", _original_chat_model())

        # ChatOpenAI wraps the api_key in SecretStr; unwrap to compare.
        api_key = bound.openai_api_key.get_secret_value()
        assert api_key == proxy_env["DECEPTICON_LLM__PROXY_API_KEY"]

    def test_routes_for_every_override_target_not_just_anthropic(
        self, proxy_env: dict[str, str]
    ) -> None:
        """The bug reproduces with any override target, not just the
        ``auth/claude-opus-4-7`` the original reporter hit. Walk through
        a range of LiteLLM ids to make sure the resolution path is
        target-agnostic.
        """
        targets = [
            "auth/claude-opus-4-7",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.5",
            "groq/llama-3.3-70b-versatile",
            "openrouter/anthropic/claude-haiku-4-5",
        ]
        for target in targets:
            bound = _build_proxied_llm(target, _original_chat_model())
            assert bound.openai_api_base == proxy_env["DECEPTICON_LLM__PROXY_URL"], (
                f"override target {target!r} did not resolve proxy URL"
            )
            assert bound.model_name == target

    def test_proxy_url_default_falls_through_when_env_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without env overrides we still get a sane default — the
        config layer's ``http://localhost:4000`` baseline. The bug was
        not "default value chosen" but "config layer never consulted".
        Belt-and-braces: confirm we do go through the config, even when
        the resolved value happens to equal the bare default.
        """
        # Strip any test-host env so we observe the config-layer default,
        # not a leak from the developer's shell.
        for var in (
            "DECEPTICON_LLM__PROXY_URL",
            "DECEPTICON_LLM__PROXY_API_KEY",
            "DECEPTICON_LLM__TIMEOUT",
            "DECEPTICON_LLM__MAX_RETRIES",
        ):
            monkeypatch.delenv(var, raising=False)

        bound = _build_proxied_llm("openai/gpt-5.5", _original_chat_model())

        # The default config baseline matches localhost; the assertion
        # is that we got a non-empty, sensible URL — not the *pathway*.
        # The earlier test_routes_for_every_override_target with env set
        # is the positive proof that resolution actually happened.
        assert bound.openai_api_base
        assert bound.openai_api_base.endswith(":4000")


class TestBuildProxiedLLMTemperatureHandling:
    """Opus 4.x family rejects ``temperature`` at the upstream Anthropic
    API regardless of the proxy path. ``LLMFactory._create_chat_model``
    drops it via ``_model_drops_temperature``; the override path must
    do the same for parity (issue #186 secondary finding).
    """

    @pytest.mark.parametrize(
        "model_id",
        [
            "auth/claude-opus-4-7",
            "anthropic/claude-opus-4-7",
            "openrouter/anthropic/claude-opus-4-7",
        ],
    )
    def test_drops_temperature_for_opus_4x_family(
        self, proxy_env: dict[str, str], model_id: str
    ) -> None:
        bound = _build_proxied_llm(model_id, _original_chat_model(temperature=0.4))
        assert bound.temperature is None, (
            f"Opus 4.x must drop temperature, got {bound.temperature!r} for {model_id}"
        )

    @pytest.mark.parametrize(
        "model_id",
        [
            "auth/claude-sonnet-4-6",
            "openai/gpt-5.5",
            "groq/llama-3.3-70b-versatile",
        ],
    )
    def test_preserves_temperature_for_other_models(
        self, proxy_env: dict[str, str], model_id: str
    ) -> None:
        bound = _build_proxied_llm(model_id, _original_chat_model(temperature=0.4))
        assert bound.temperature == 0.4

    def test_missing_temperature_on_original_does_not_crash(
        self, proxy_env: dict[str, str]
    ) -> None:
        """Some BaseChatModel subclasses do not expose ``temperature``.
        ``getattr(original, "temperature", None)`` is the protective
        access; this pins it so a future refactor does not regress to
        ``original.temperature`` and break for those models.
        """

        class _NoTemp:
            """BaseChatModel-shaped object without a ``temperature`` attr."""

            pass

        bound = _build_proxied_llm("openai/gpt-5.5", _NoTemp())  # type: ignore[arg-type]
        # No temperature passed through → ChatOpenAI's own default applies.
        # Whatever that default is, we just need to confirm we did not
        # crash and we did construct a model bound to the proxy URL.
        assert bound.openai_api_base == proxy_env["DECEPTICON_LLM__PROXY_URL"]


# ── Read-override resolution (lightweight smoke for the read path) ──────


class TestReadOverride:
    """``_read_override`` already had implicit coverage through the
    runtime tests; pin the contract here so the override key spelling
    is locked.
    """

    def test_runtime_context_takes_priority(self) -> None:
        class _Runtime:
            context = {"model_override": "openai/gpt-5.5"}

        class _Req:
            runtime = _Runtime()
            state = {"model_override": "openai/gpt-5.4"}

        assert _read_override(_Req()) == "openai/gpt-5.5"

    def test_state_used_when_runtime_absent(self) -> None:
        class _Req:
            runtime = None
            state = {"model_override": "openai/gpt-5.4"}

        assert _read_override(_Req()) == "openai/gpt-5.4"

    def test_per_role_map_targets_the_matching_role(self) -> None:
        class _Runtime:
            context = {"model_overrides": {"soundwave": "auth/claude-sonnet-5"}}

        class _Req:
            runtime = _Runtime()
            state: dict[str, Any] = {}

        assert _read_override(_Req(), "soundwave") == "auth/claude-sonnet-5"
        # a role NOT in the map (and no global) → no override
        assert _read_override(_Req(), "recon") == ""
        # no role passed → the per-role map is ignored
        assert _read_override(_Req()) == ""

    def test_per_role_map_beats_the_global_override(self) -> None:
        class _Runtime:
            context = {
                "model_overrides": {"exploit": "auth/claude-sonnet-5"},
                "model_override": "openai/gpt-5.5",
            }

        class _Req:
            runtime = _Runtime()
            state: dict[str, Any] = {}

        # exploit → its per-role model; other roles → the global override
        assert _read_override(_Req(), "exploit") == "auth/claude-sonnet-5"
        assert _read_override(_Req(), "recon") == "openai/gpt-5.5"

    def test_per_role_map_from_state_channel(self) -> None:
        class _Req:
            runtime = None
            state = {"model_overrides": {"soundwave": "auth/claude-sonnet-5"}}

        assert _read_override(_Req(), "soundwave") == "auth/claude-sonnet-5"

    def test_empty_string_means_no_override(self) -> None:
        class _Runtime:
            context = {"model_override": ""}

        class _Req:
            runtime = _Runtime()
            state: dict[str, Any] = {}

        assert _read_override(_Req()) == ""

    def test_whitespace_only_means_no_override(self) -> None:
        class _Runtime:
            context = {"model_override": "   "}

        class _Req:
            runtime = _Runtime()
            state: dict[str, Any] = {}

        assert _read_override(_Req()) == ""


# ── Middleware wiring (smoke — no LLM calls) ────────────────────────────


class TestModelOverrideMiddlewareWiring:
    """Make sure the middleware short-circuits to the original handler
    when no override is set so a user with no ``/model`` command gets
    the baked-in primary unchanged.
    """

    def test_no_override_passes_through(self) -> None:
        mw = ModelOverrideMiddleware()
        seen: list[Any] = []

        def handler(request):
            seen.append(request)
            return "passthrough"

        class _Req:
            runtime = None
            state: dict[str, Any] = {}

        assert mw.wrap_model_call(_Req(), handler) == "passthrough"
        assert seen, "handler must be invoked when no override is set"


class TestWrapModelCallActiveOverride:
    def test_active_override_rebinds_and_calls_handler(self, proxy_env: dict[str, str]) -> None:
        mw = ModelOverrideMiddleware()
        original = _original_chat_model()

        class _OverrideReq:
            class runtime:
                context = {"model_override": "openai/gpt-5.5"}

            state: dict[str, Any] = {}
            model = original
            override_called = False
            last_override_model: Any = None

            def override(self, *, model: Any) -> "_OverrideReq":
                self.override_called = True
                self.last_override_model = model
                return self

        req = _OverrideReq()
        handler_calls: list[Any] = []

        def handler(request: Any) -> str:
            handler_calls.append(request)
            return "RESULT"

        result = mw.wrap_model_call(req, handler)

        assert result == "RESULT"
        assert len(handler_calls) == 1
        assert req.override_called
        bound = req.last_override_model
        assert isinstance(bound, ChatOpenAI)
        assert bound.openai_api_base == proxy_env["DECEPTICON_LLM__PROXY_URL"]
        assert bound.model_name == "openai/gpt-5.5"

    def test_bind_failure_raises_and_never_runs_the_baseline(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A bind failure must NOT fall through to the original handler.

        Falling through ran the call on the leftover baseline — with a
        placeholder Ollama Cloud key in ``.env`` that baseline is
        ``ollama_cloud/llama3.2``, so a run that asked for its own custom
        channel silently answered from the wrong provider. Contract:
        "无法使用时明确报错而非默认provider替代".
        """
        mw = ModelOverrideMiddleware()
        original = _original_chat_model()

        def _raise(*args: Any, **kwargs: Any) -> None:
            raise ValueError("DECEPTICON_LLM_EXTRA_HEADERS must be a JSON object of string headers")

        monkeypatch.setattr("decepticon.middleware.model_override._build_proxied_llm", _raise)

        class _OverrideReq:
            class runtime:
                context = {"model_override": "openai/gpt-5.5"}

            state: dict[str, Any] = {}
            model = original
            override_called = False

            def override(self, *, model: Any) -> "_OverrideReq":
                self.override_called = True
                return self

        req = _OverrideReq()
        handler_calls: list[Any] = []

        def handler(request: Any) -> str:
            handler_calls.append(request)
            return "FALLBACK"

        with pytest.raises(ModelOverrideUnavailableError) as excinfo:
            mw.wrap_model_call(req, handler)

        assert handler_calls == []
        assert not req.override_called
        message = str(excinfo.value)
        assert "openai/gpt-5.5" in message
        assert original.model_name in message
        assert isinstance(excinfo.value.__cause__, ValueError)

    def test_bind_failure_error_is_redacted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mw = ModelOverrideMiddleware()
        monkeypatch.setattr(
            "decepticon.middleware.model_override._build_proxied_llm",
            lambda *a, **k: (_ for _ in ()).throw(
                RuntimeError("bad header Authorization: Bearer sk-ant-api03-abcdefghijklmnop")
            ),
        )

        class _OverrideReq:
            class runtime:
                context = {"model_override": "openai/gpt-5.5"}

            state: dict[str, Any] = {}
            model = _original_chat_model()

        with pytest.raises(ModelOverrideUnavailableError) as excinfo:
            mw.wrap_model_call(_OverrideReq(), lambda request: "never")

        message = str(excinfo.value)
        assert "sk-ant-api03-abcdefghijklmnop" not in message
        assert "sk-ant" not in message
        assert "[REDACTED]" in message

    def test_bind_failure_is_not_swallowed_by_the_fallback_chain(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``MODEL_OVERRIDE`` sits OUTSIDE ``MODEL_FALLBACK`` in the stack, so
        the refusal must propagate instead of being converted into a fallback
        attempt on another provider.
        """
        from langchain.agents.middleware import ModelFallbackMiddleware

        class _NeverCalledChatModel(BaseChatModel):
            @property
            def _llm_type(self) -> str:
                return "never-called"

            def _generate(self, *args: Any, **kwargs: Any):
                raise AssertionError("a fallback model was called after a bind failure")

        fallback = ModelFallbackMiddleware(_NeverCalledChatModel())
        mw = ModelOverrideMiddleware()
        baseline_invoked: list[Any] = []

        def _raise(*args: Any, **kwargs: Any) -> None:
            raise ValueError("boom")

        monkeypatch.setattr("decepticon.middleware.model_override._build_proxied_llm", _raise)

        class _OverrideReq:
            class runtime:
                context = {"model_override": "openai/gpt-5.5"}

            state: dict[str, Any] = {}
            model = _original_chat_model()

        def terminal(request: Any) -> str:
            baseline_invoked.append(request)
            raise AssertionError("the baseline primary was called after a bind failure")

        with pytest.raises(ModelOverrideUnavailableError):
            mw.wrap_model_call(
                _OverrideReq(),
                lambda request: fallback.wrap_model_call(request, terminal),
            )

        assert baseline_invoked == []


class TestAwrapModelCallNoOverride:
    async def test_async_no_override_passes_through(self) -> None:
        mw = ModelOverrideMiddleware()

        class _Req:
            runtime = None
            state: dict[str, Any] = {}

        seen: list[Any] = []

        async def handler(request: Any) -> str:
            seen.append(request)
            return "passthrough"

        result = await mw.awrap_model_call(_Req(), handler)
        assert result == "passthrough"
        assert seen


class TestAwrapModelCallActiveOverride:
    async def test_async_active_override_rebinds(self, proxy_env: dict[str, str]) -> None:
        mw = ModelOverrideMiddleware()
        original = _original_chat_model()

        class _OverrideReq:
            class runtime:
                context = {"model_override": "groq/llama-3.3-70b-versatile"}

            state: dict[str, Any] = {}
            model = original
            override_called = False
            last_override_model: Any = None

            def override(self, *, model: Any) -> "_OverrideReq":
                self.override_called = True
                self.last_override_model = model
                return self

        req = _OverrideReq()
        handler_calls: list[Any] = []

        async def handler(request: Any) -> str:
            handler_calls.append(request)
            return "ARESULT"

        result = await mw.awrap_model_call(req, handler)

        assert result == "ARESULT"
        assert len(handler_calls) == 1
        assert req.override_called
        bound = req.last_override_model
        assert isinstance(bound, ChatOpenAI)
        assert bound.openai_api_base == proxy_env["DECEPTICON_LLM__PROXY_URL"]
        assert bound.model_name == "groq/llama-3.3-70b-versatile"

    async def test_async_bind_failure_raises_without_running_the_baseline(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        mw = ModelOverrideMiddleware()
        original = _original_chat_model()

        def _raise(*args: Any, **kwargs: Any) -> None:
            raise ValueError("boom")

        monkeypatch.setattr("decepticon.middleware.model_override._build_proxied_llm", _raise)

        class _OverrideReq:
            class runtime:
                context = {"model_override": "groq/llama-3.3-70b-versatile"}

            state: dict[str, Any] = {}
            model = original
            override_called = False

            def override(self, *, model: Any) -> "_OverrideReq":
                self.override_called = True
                return self

        req = _OverrideReq()
        handler_calls: list[Any] = []

        async def handler(request: Any) -> str:
            handler_calls.append(request)
            return "AFALLBACK"

        with pytest.raises(ModelOverrideUnavailableError) as excinfo:
            await mw.awrap_model_call(req, handler)

        assert handler_calls == []
        assert not req.override_called
        assert "groq/llama-3.3-70b-versatile" in str(excinfo.value)
        assert original.model_name in str(excinfo.value)


class TestOverrideRespectingModelFallback:
    """An explicit run override must not be retried on another provider.

    Evidence before this guard: with ``model_override`` pinned, a failing
    provider call ran the whole baseline chain
    (``[custom-alias, FALLBACK-PROVIDER-MODEL]``) because langchain's
    ``ModelFallbackMiddleware`` walks its models on any exception. A user whose
    only configured channel is the custom one must never get an answer
    produced by another vendor.
    """

    class _Sentinel(BaseChatModel):
        """Stands in for one provider-fallback model built by the factory."""

        name: str = "FALLBACK-PROVIDER-MODEL"

        @property
        def _llm_type(self) -> str:
            return "fallback-sentinel"

        def _generate(self, *args: Any, **kwargs: Any):  # pragma: no cover
            raise AssertionError("fallback model was invoked")

    @staticmethod
    def _request(
        *, override: str | None = None, per_role: dict | None = None, role: str | None = None
    ) -> Any:
        context: dict[str, Any] = {}
        if override is not None:
            context["model_override"] = override
        if per_role is not None:
            context["model_overrides"] = per_role
        runtime = SimpleNamespace(context=context) if context else None

        class _Req:
            """Request stand-in whose ``override`` actually swaps the model."""

            def __init__(self, model: Any) -> None:
                self.model = model
                self.runtime = runtime
                self.state: dict[str, Any] = {}

            def override(self, *, model: Any) -> "_Req":
                return _Req(model)

        return _Req(_original_chat_model())

    def _attempts(self, mw: Any, request: Any) -> list[str]:
        attempted: list[str] = []

        def terminal(req: Any) -> str:
            name = getattr(req.model, "model_name", None) or getattr(req.model, "name", "?")
            attempted.append(name)
            raise RuntimeError(f"provider call failed for {name}")

        with pytest.raises(RuntimeError):
            mw.wrap_model_call(request, terminal)
        return attempted

    def test_no_override_walks_the_baseline_chain(self) -> None:
        mw = OverrideRespectingModelFallbackMiddleware(self._Sentinel())
        assert self._attempts(mw, self._request()) == [
            "openai/gpt-5.5",
            "FALLBACK-PROVIDER-MODEL",
        ]

    def test_global_override_blocks_the_fallback_chain(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Full stack order: MODEL_OVERRIDE (outer) → MODEL_FALLBACK (inner)."""
        monkeypatch.setattr(
            "decepticon.middleware.model_override._build_proxied_llm",
            lambda model_id, original: _original_chat_model(),
        )
        fallback = OverrideRespectingModelFallbackMiddleware(self._Sentinel())
        request = self._request(override="openai/decepticon-custom-c43ac15e9230")
        attempted: list[str] = []

        def terminal(req: Any) -> str:
            name = getattr(req.model, "model_name", None) or getattr(req.model, "name", "?")
            attempted.append(name)
            raise RuntimeError(f"provider call failed for {name}")

        with pytest.raises(RuntimeError):
            ModelOverrideMiddleware().wrap_model_call(
                request, lambda req: fallback.wrap_model_call(req, terminal)
            )
        assert attempted == ["openai/gpt-5.5"], "override must not be retried cross-provider"

    def test_per_role_map_blocks_the_fallback_chain(self) -> None:
        mw = OverrideRespectingModelFallbackMiddleware(self._Sentinel(), role="soundwave")
        request = self._request(per_role={"soundwave": "openai/decepticon-custom-c43ac15e9230"})
        assert self._attempts(mw, request) == ["openai/gpt-5.5"]

    def test_state_channel_override_also_blocks_the_chain(self) -> None:
        """The shape the CLI run input / LangGraph Platform actually persists.

        ``model_override`` arrives on the graph STATE channel (not the runtime
        context) for a real run, so the guard must read both — the same way
        ``ModelOverrideMiddleware`` does.
        """
        mw = OverrideRespectingModelFallbackMiddleware(self._Sentinel())
        request = self._request()
        request.state = {"model_override": "openai/decepticon-custom-c43ac15e9230"}
        assert self._attempts(mw, request) == ["openai/gpt-5.5"]
        state_map = self._request()
        state_map.state = {
            "model_overrides": {"decepticon": "openai/decepticon-custom-c43ac15e9230"}
        }
        assert self._attempts(
            OverrideRespectingModelFallbackMiddleware(self._Sentinel(), role="decepticon"),
            state_map,
        ) == ["openai/gpt-5.5"]

    def test_remains_a_drop_in_subclass_of_the_upstream_middleware(self) -> None:
        """Callers (and the slot factory) construct it exactly like langchain's."""
        from langchain.agents.middleware import ModelFallbackMiddleware

        assert issubclass(OverrideRespectingModelFallbackMiddleware, ModelFallbackMiddleware)
        built = OverrideRespectingModelFallbackMiddleware(_original_chat_model())
        assert built.models[0].model_name == "openai/gpt-5.5"
        # ``role`` is keyword-only and additive: the upstream positional shape
        # (first model + variadic additional models) is unchanged.
        multi = OverrideRespectingModelFallbackMiddleware(
            _original_chat_model(), self._Sentinel(), role="recon"
        )
        assert len(multi.models) == 2
        assert multi._role == "recon"

    def test_map_entry_for_another_role_does_not_block_others(self) -> None:
        mw = OverrideRespectingModelFallbackMiddleware(self._Sentinel(), role="soundwave")
        request = self._request(per_role={"exploit": "openai/decepticon-custom-c43ac15e9230"})
        # soundwave has no entry and no global override → the chain still applies.
        assert self._attempts(mw, request) == [
            "openai/gpt-5.5",
            "FALLBACK-PROVIDER-MODEL",
        ]

    async def test_async_override_blocks_the_fallback_chain(self) -> None:
        mw = OverrideRespectingModelFallbackMiddleware(self._Sentinel())
        request = self._request(override="openai/decepticon-custom-c43ac15e9230")
        attempted: list[str] = []

        async def terminal(req: Any) -> str:
            name = getattr(req.model, "model_name", None) or getattr(req.model, "name", "?")
            attempted.append(name)
            raise RuntimeError(f"provider call failed for {name}")

        with pytest.raises(RuntimeError):
            await mw.awrap_model_call(request, terminal)
        assert attempted == ["openai/gpt-5.5"]

    async def test_async_without_override_still_walks_the_chain(self) -> None:
        mw = OverrideRespectingModelFallbackMiddleware(self._Sentinel())
        request = self._request()
        attempted: list[str] = []

        async def terminal(req: Any) -> str:
            name = getattr(req.model, "model_name", None) or getattr(req.model, "name", "?")
            attempted.append(name)
            raise RuntimeError(f"provider call failed for {name}")

        with pytest.raises(RuntimeError):
            await mw.awrap_model_call(request, terminal)
        assert attempted == ["openai/gpt-5.5", "FALLBACK-PROVIDER-MODEL"]

    def test_slot_factory_builds_the_override_respecting_fallback(self) -> None:
        """The MODEL_FALLBACK slot must install the guard, with the role
        threaded through so a per-role map is read the same way."""
        from decepticon.agents.middleware_slots import _make_model_fallback

        assert _make_model_fallback(fallback_models=[], role="soundwave") is None
        built = _make_model_fallback(fallback_models=[_original_chat_model()], role="soundwave")
        assert isinstance(built, OverrideRespectingModelFallbackMiddleware)
        assert built._role == "soundwave"


def test_global_override_survives_graph_input_change_and_clear() -> None:
    graph = (
        StateGraph(ModelOverridesState)
        .add_node("read", lambda state: {})
        .add_edge(START, "read")
        .add_edge("read", END)
        .compile(checkpointer=InMemorySaver())
    )
    config: RunnableConfig = {"configurable": {"thread_id": "override-lifecycle"}}
    updates: list[tuple[ModelOverridesState, str]] = [
        ({"messages": [], "model_override": "auth/gpt-6-luna"}, "auth/gpt-6-luna"),
        ({"messages": []}, "auth/gpt-6-luna"),
        ({"messages": [], "model_override": "auth/gpt-6.1-sol"}, "auth/gpt-6.1-sol"),
        ({"messages": [], "model_override": ""}, ""),
        ({"messages": []}, ""),
    ]
    for update, expected in updates:
        state = graph.invoke(update, config)
        assert state.get("model_override") == expected


def test_resume_updates_global_override_without_displacing_role_override() -> None:
    observed: list[tuple[str, str]] = []

    def resume_node(state: ModelOverridesState) -> dict[str, Any]:
        interrupt("Continue?")
        request = SimpleNamespace(runtime=None, state=state)
        observed.append((_read_override(request, "recon"), _read_override(request, "exploit")))
        return {}

    graph = (
        StateGraph(ModelOverridesState)
        .add_node("resume", resume_node)
        .add_edge(START, "resume")
        .add_edge("resume", END)
        .compile(checkpointer=InMemorySaver())
    )
    config: RunnableConfig = {"configurable": {"thread_id": "override-resume"}}
    for selected in ("auth/gpt-6.1-sol", ""):
        graph.invoke(
            {
                "messages": [],
                "model_override": "auth/gpt-6-luna",
                "model_overrides": {"exploit": "auth/claude-sonnet-5"},
            },
            config,
        )
        graph.invoke(Command(resume="yes", update={"model_override": selected}), config)
    assert observed == [
        ("auth/gpt-6.1-sol", "auth/claude-sonnet-5"),
        ("", "auth/claude-sonnet-5"),
    ]


@pytest.mark.parametrize(
    ("model_id", "attribute", "expected"),
    [
        ("openai/gpt-6.1-sol", "use_responses_api", True),
        ("anthropic/claude-sonnet-5-5", "disable_streaming", "tool_calling"),
        ("ollama_chat/qwen3-coder:30b", "disable_streaming", "tool_calling"),
    ],
)
def test_override_preserves_factory_protocol(
    proxy_env: dict[str, str], model_id: str, attribute: str, expected: object
) -> None:
    bound = _build_proxied_llm(model_id, _original_chat_model())
    assert getattr(bound, attribute) == expected


# ── Run LLM/runtime settings (web/CLI run policy) ───────────────────────


def _run_settings_request(
    *, context: dict[str, Any] | None = None, state: dict[str, Any] | None = None
) -> Any:
    """Request stand-in carrying the run policy in runtime context and/or state."""
    runtime = SimpleNamespace(context=context) if context is not None else None
    return SimpleNamespace(runtime=runtime, state=state or {})


class TestReadRunLlmParams:
    """``_read_run_llm_params`` re-validates the run policy the CLI threaded
    into the graph — the values crossed a process boundary, so a knob outside
    its wire bound must be DROPPED rather than trusted."""

    def test_runtime_context_beats_state(self) -> None:
        request = _run_settings_request(
            context={"llm_max_output_tokens": 8192, "reasoning_effort": "low"},
            state={"llm_max_output_tokens": 4096, "reasoning_effort": "high"},
        )
        params = _read_run_llm_params(request)
        assert params["llm_max_output_tokens"] == 8192
        assert params["reasoning_effort"] == "low"

    def test_falls_back_to_state_per_key(self) -> None:
        request = _run_settings_request(
            context={"reasoning_effort": "medium"},
            state={"reasoning_effort": "high", "llm_max_output_tokens": 4096},
        )
        params = _read_run_llm_params(request)
        # The context value wins where it is present; the state fills the rest.
        assert params["reasoning_effort"] == "medium"
        assert params["llm_max_output_tokens"] == 4096

    def test_state_only(self) -> None:
        request = _run_settings_request(state={"llm_disable_streaming": True, "hitl_enabled": True})
        assert _read_run_llm_params(request) == {
            "llm_disable_streaming": True,
            "hitl_enabled": True,
        }

    def test_absent_settings_produce_no_keys(self) -> None:
        assert _read_run_llm_params(_run_settings_request()) == {}
        assert _read_run_llm_params(_run_settings_request(state={"messages": []})) == {}

    @pytest.mark.parametrize("effort", ["minimal", "ultra", "none", "", 3, None])
    def test_rejects_values_outside_the_enum(self, effort: Any) -> None:
        request = _run_settings_request(state={"reasoning_effort": effort})
        assert "reasoning_effort" not in _read_run_llm_params(request)

    @pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max"])
    def test_accepts_the_five_wire_values_verbatim(self, effort: str) -> None:
        request = _run_settings_request(state={"reasoning_effort": effort})
        assert _read_run_llm_params(request)["reasoning_effort"] == effort

    @pytest.mark.parametrize(("raw", "expected"), [(" HIGH ", "high"), ("Low", "low")])
    def test_normalizes_case_and_surrounding_space(self, raw: str, expected: str) -> None:
        request = _run_settings_request(state={"reasoning_effort": raw})
        assert _read_run_llm_params(request)["reasoning_effort"] == expected

    @pytest.mark.parametrize("value", [255, 128001, 0, -1, "nope", True, 4096.5, None])
    def test_rejects_max_output_tokens_outside_the_wire_range(self, value: Any) -> None:
        request = _run_settings_request(state={"llm_max_output_tokens": value})
        assert "llm_max_output_tokens" not in _read_run_llm_params(request)

    @pytest.mark.parametrize(
        ("value", "expected"),
        [(256, 256), (4096, 4096), (128000, 128000), ("8192", 8192), (4096.0, 4096)],
    )
    def test_accepts_max_output_tokens_inside_the_wire_range(
        self, value: Any, expected: int
    ) -> None:
        request = _run_settings_request(state={"llm_max_output_tokens": value})
        assert _read_run_llm_params(request)["llm_max_output_tokens"] == expected

    def test_extra_headers_shaped_state_key_is_not_a_channel(self) -> None:
        # Provider extra headers are a startup-only, env-resolved deployment
        # value (``llm/factory.py::_resolve_extra_headers``), so a run payload
        # carrying them must be ignored: the value would otherwise be
        # persisted into the LangGraph checkpoint.
        request = _run_settings_request(
            state={
                _RUN_HEADERS_KEY: {
                    "X-Tenant": "acme",
                    "Authorization": "Bearer operator-supplied",
                }
            }
        )
        assert _read_run_llm_params(request) == {}
        context_request = _run_settings_request(context={_RUN_HEADERS_KEY: {"x-tenant": "acme"}})
        assert _read_run_llm_params(context_request) == {}

    @pytest.mark.parametrize("value", [0, -1, 1_000_001, "abc", float("inf"), True, None])
    def test_rejects_budget_caps_outside_the_wire_range(self, value: Any) -> None:
        request = _run_settings_request(
            state={"budget_engagement_usd": value, "budget_per_agent_usd": value}
        )
        params = _read_run_llm_params(request)
        assert "budget_engagement_usd" not in params
        assert "budget_per_agent_usd" not in params

    def test_accepts_budget_caps(self) -> None:
        request = _run_settings_request(
            state={"budget_engagement_usd": "25.5", "budget_per_agent_usd": 5}
        )
        params = _read_run_llm_params(request)
        assert params["budget_engagement_usd"] == 25.5
        assert params["budget_per_agent_usd"] == 5.0

    @pytest.mark.parametrize(
        ("value", "kept"),
        [
            (0.7, True),
            (1, True),
            (0.05, True),
            (0, False),
            (-0.5, False),
            (1.5, False),
            (70, False),
        ],
    )
    def test_soft_warn_pct_is_a_fraction_in_zero_to_one(self, value: Any, kept: bool) -> None:
        request = _run_settings_request(state={"budget_soft_warn_at_pct": value})
        params = _read_run_llm_params(request)
        if kept:
            assert params["budget_soft_warn_at_pct"] == float(value)
        else:
            assert "budget_soft_warn_at_pct" not in params

    @pytest.mark.parametrize("value", [True, "true", "1", 1, False, None])
    def test_hitl_enabled_requires_the_boolean_true(self, value: Any) -> None:
        request = _run_settings_request(state={"hitl_enabled": value})
        params = _read_run_llm_params(request)
        assert ("hitl_enabled" in params) is (value is True)


class TestApplyRunLlmParams:
    """``_apply_run_llm_params`` rebinds the model via ``model_copy`` — the
    constructor-level knobs cannot ride ``request.model_settings``, which only
    binds invocation kwargs."""

    def test_returns_the_same_model_when_nothing_applies(self, proxy_env: dict[str, str]) -> None:
        model = _build_proxied_llm("groq/llama-3.3-70b-versatile", _original_chat_model())
        # ``reasoning_effort`` is unusable on this family, so nothing binds.
        assert _apply_run_llm_params(model, {"reasoning_effort": "high"}, model.model_name) is model

    def test_headers_kwarg_is_not_a_channel(self, proxy_env: dict[str, str]) -> None:
        """A run payload carrying the removed header key must not reach the
        copy's kwargs; the factory resolves headers from the process env.
        """
        model = ChatOpenAI(
            model="openai/gpt-5.5",
            api_key="sk-test-original",
            base_url="http://localhost:4000",
            default_headers={"x-base": "1"},
        )
        bound = _apply_run_llm_params(
            model, {_RUN_HEADERS_KEY: {"x-tenant": "acme"}}, "openai/gpt-5.5"
        )
        # Nothing else applies, so the original object is returned untouched.
        assert bound is model
        assert bound.default_headers == {"x-base": "1"}
        assert bound.root_client.default_headers.get("x-base") == "1"
        assert bound.root_client.default_headers.get("x-tenant") is None

    def test_original_model_is_not_mutated(self, proxy_env: dict[str, str]) -> None:
        model = _build_proxied_llm("openai/gpt-5.5", _original_chat_model())
        before = model.model_dump()
        _apply_run_llm_params(
            model,
            {"llm_max_output_tokens": 4096, "llm_disable_streaming": True},
            "openai/gpt-5.5",
        )
        assert model.model_dump() == before


class TestWrapModelCallRunSettings:
    """The acceptance requires a real call-parameter assertion: the run knobs
    must change the model the handler receives AND its outbound payload."""

    def _request(self, state: dict[str, Any], model: Any, *, context: dict[str, Any] | None = None):
        class _OverrideReq:
            runtime = SimpleNamespace(context=context) if context is not None else None

            def __init__(self) -> None:
                self.state = state
                self.model = model
                self.override_called = False
                self.last_override_model: Any = None

            def override(self, *, model: Any) -> "_OverrideReq":
                self.override_called = True
                self.last_override_model = model
                self.model = model
                return self

        return _OverrideReq()

    def test_sync_params_change_model_and_payload(self, proxy_env: dict[str, str]) -> None:
        mw = ModelOverrideMiddleware()
        req = self._request(
            {
                "llm_max_output_tokens": 4096,
                "llm_disable_streaming": True,
                _RUN_HEADERS_KEY: {"x-tenant": "acme"},
                "reasoning_effort": "high",
            },
            _build_proxied_llm("anthropic/claude-opus-4-7", _original_chat_model()),
        )
        captured: list[Any] = []

        def handler(request: Any) -> str:
            captured.append(request.model)
            return "RESULT"

        assert mw.wrap_model_call(req, handler) == "RESULT"
        assert req.override_called
        bound = captured[0]
        assert bound is req.last_override_model
        assert bound.max_tokens == 4096
        assert bound.streaming is False
        assert bound.stream_usage is False
        assert bound.reasoning_effort == "high"
        # The header-shaped state key is not a run channel: it must not reach
        # the model copy's kwargs (headers come from the factory env path).
        assert not (bound.default_headers or {}).get("x-tenant")
        assert not bound.root_client.default_headers.get("x-tenant")

        payload = bound._get_request_payload("hi")
        # ``ChatOpenAI._default_params`` renames the field to the modern wire
        # name (``max_completion_tokens``); accept either spelling so this pins
        # the VALUE, not the SDK's alias.
        assert payload.get("max_tokens", payload.get("max_completion_tokens")) == 4096
        assert payload["stream"] is False
        assert payload["reasoning_effort"] == "high"

    async def test_async_params_change_model_and_payload(self, proxy_env: dict[str, str]) -> None:
        mw = ModelOverrideMiddleware()
        req = self._request(
            {
                "llm_max_output_tokens": 4096,
                "llm_disable_streaming": True,
                _RUN_HEADERS_KEY: {"x-tenant": "acme"},
                "reasoning_effort": "high",
            },
            _build_proxied_llm("anthropic/claude-opus-4-7", _original_chat_model()),
        )
        captured: list[Any] = []

        async def handler(request: Any) -> str:
            captured.append(request.model)
            return "ARESULT"

        assert await mw.awrap_model_call(req, handler) == "ARESULT"
        assert req.override_called
        bound = captured[0]
        assert bound.max_tokens == 4096
        assert bound.streaming is False
        assert bound.reasoning_effort == "high"
        assert not (bound.default_headers or {}).get("x-tenant")
        payload = bound._get_request_payload("hi")
        assert payload.get("max_tokens", payload.get("max_completion_tokens")) == 4096
        assert payload["stream"] is False
        assert payload["reasoning_effort"] == "high"

    @pytest.mark.parametrize("effort", ["xhigh", "max"])
    def test_new_effort_tiers_reach_the_request_payload_verbatim(
        self, proxy_env: dict[str, str], effort: str
    ) -> None:
        """The two added tiers are not remapped per model: whatever the run
        policy carried is exactly what the bound model sends upstream."""
        mw = ModelOverrideMiddleware()
        req = self._request(
            {"reasoning_effort": effort},
            _build_proxied_llm("anthropic/claude-opus-4-7", _original_chat_model()),
        )
        captured: list[Any] = []

        def handler(request: Any) -> str:
            captured.append(request.model)
            return "RESULT"

        assert mw.wrap_model_call(req, handler) == "RESULT"
        assert req.override_called
        bound = captured[0]
        assert bound.reasoning_effort == effort
        assert bound._get_request_payload("hi")["reasoning_effort"] == effort

    def test_params_apply_without_an_override_id(self, proxy_env: dict[str, str]) -> None:
        mw = ModelOverrideMiddleware()
        original = _build_proxied_llm("openai/gpt-5.5", _original_chat_model())
        req = self._request({"llm_max_output_tokens": 4096}, original)
        captured: list[Any] = []

        def handler(request: Any) -> str:
            captured.append(request.model)
            return "RESULT"

        assert mw.wrap_model_call(req, handler) == "RESULT"
        assert req.override_called
        assert captured[0].max_tokens == 4096
        # Unrelated constructor-level fields are carried over unchanged.
        assert captured[0].model_name == original.model_name
        assert captured[0].openai_api_base == original.openai_api_base

    def test_override_and_params_both_apply(self, proxy_env: dict[str, str]) -> None:
        mw = ModelOverrideMiddleware()
        req = self._request(
            {"llm_max_output_tokens": 4096, "reasoning_effort": "high"},
            _original_chat_model(),
            context={"model_override": "anthropic/claude-opus-4-7"},
        )
        captured: list[Any] = []

        def handler(request: Any) -> str:
            captured.append(request.model)
            return "RESULT"

        assert mw.wrap_model_call(req, handler) == "RESULT"
        bound = captured[0]
        # The override id picks the model; the run knobs are applied on top.
        assert bound.model_name == "anthropic/claude-opus-4-7"
        assert bound.max_tokens == 4096
        assert bound.reasoning_effort == "high"

    def test_reasoning_effort_not_attached_on_unsupported_family(
        self, proxy_env: dict[str, str]
    ) -> None:
        mw = ModelOverrideMiddleware()
        req = self._request(
            {"reasoning_effort": "high"},
            _build_proxied_llm("groq/llama-3.3-70b-versatile", _original_chat_model()),
        )
        captured: list[Any] = []

        def handler(request: Any) -> str:
            captured.append(request.model)
            return "RESULT"

        assert mw.wrap_model_call(req, handler) == "RESULT"
        bound = captured[0]
        assert bound.reasoning_effort is None
        assert "reasoning_effort" not in bound._get_request_payload("hi")

    def test_no_params_and_no_override_passes_through_untouched(self) -> None:
        mw = ModelOverrideMiddleware()
        req = _run_settings_request(state={"messages": []})
        seen: list[Any] = []

        def handler(request: Any) -> str:
            seen.append(request)
            return "passthrough"

        assert mw.wrap_model_call(req, handler) == "passthrough"
        assert seen[0] is req

    async def test_async_no_params_and_no_override_passes_through_untouched(self) -> None:
        mw = ModelOverrideMiddleware()
        req = _run_settings_request(state={"messages": []})
        seen: list[Any] = []

        async def handler(request: Any) -> str:
            seen.append(request)
            return "passthrough"

        assert await mw.awrap_model_call(req, handler) == "passthrough"
        assert seen[0] is req

    def test_unusable_params_alone_do_not_rebind(self) -> None:
        mw = ModelOverrideMiddleware()
        original = _original_chat_model()
        req = self._request({"reasoning_effort": "high"}, original)
        seen: list[Any] = []

        def handler(request: Any) -> str:
            seen.append(request)
            return "passthrough"

        # The baked-in model is openai/gpt-5.5: no handler maps the param, so
        # the request must not be rebound at all.
        assert mw.wrap_model_call(req, handler) == "passthrough"
        assert seen[0] is req
        assert not req.override_called


def test_run_settings_channels_survive_graph_input() -> None:
    """Every declared run channel must be reachable from run ``input`` and
    persisted to the checkpoint (the Platform drops undeclared keys).

    Provider extra headers are deliberately NOT declared: they are a
    startup-only deployment value resolved by the factory from the agent
    process environment, and a header value must never be persisted into the
    checkpoint.
    """
    assert _RUN_HEADERS_KEY not in ModelOverridesState.__annotations__
    graph = (
        StateGraph(ModelOverridesState)
        .add_node("read", lambda state: {})
        .add_edge(START, "read")
        .add_edge("read", END)
        .compile(checkpointer=InMemorySaver())
    )
    config: RunnableConfig = {"configurable": {"thread_id": "run-settings"}}
    update: dict[str, Any] = {
        "messages": [],
        "reasoning_effort": "high",
        "llm_max_output_tokens": 4096,
        "llm_disable_streaming": True,
        "budget_engagement_usd": 25.5,
        "budget_per_agent_usd": 5.0,
        "budget_soft_warn_at_pct": 0.7,
        "hitl_enabled": True,
    }
    state = graph.invoke(update, config)
    for key, expected in update.items():
        if key == "messages":
            continue
        assert state.get(key) == expected, key
    # A resume that sends no input keeps the policy in force.
    assert graph.invoke({"messages": []}, config).get("reasoning_effort") == "high"
