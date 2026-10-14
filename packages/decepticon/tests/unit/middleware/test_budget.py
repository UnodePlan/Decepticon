"""Tests for decepticon.middleware.budget."""

from __future__ import annotations

import pytest

from decepticon.middleware.budget import (
    BudgetEnforcementMiddleware,
    BudgetExceeded,
    _SpendCache,
)


def test_spend_cache_set_get():
    cache = _SpendCache(ttl_seconds=60.0)
    cache.set("k1", 1.23)
    assert cache.get("k1") == 1.23


def test_spend_cache_miss():
    cache = _SpendCache(ttl_seconds=60.0)
    assert cache.get("nope") is None


def test_spend_cache_eviction_at_capacity():
    cache = _SpendCache(ttl_seconds=60.0)
    for i in range(cache._MAX_ENTRIES + 10):
        cache.set(f"k{i}", float(i))
    assert len(cache._entries) <= cache._MAX_ENTRIES


def test_disabled_when_no_caps_set():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=0.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 1000.0,
    )
    assert mw._enabled() is False


def test_under_cap_does_not_raise():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        soft_warn_at_pct=0.7,
        spend_provider=lambda _k: 5.0,
    )

    class _Req:
        state = {"engagement_name": "test"}
        runtime = None

    mw._enforce(_Req())


def test_over_cap_raises_budget_exceeded():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 15.0,
    )

    class _Req:
        state = {"engagement_name": "test"}
        runtime = None

    with pytest.raises(BudgetExceeded) as exc_info:
        mw._enforce(_Req())
    assert exc_info.value.scope == "engagement"
    assert exc_info.value.cap_usd == 10.0


def test_per_agent_cap_is_checked_separately():
    spends = {"engagement:test": 1.0, "agent:test:recon": 50.0}
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=100.0,
        per_agent_cap_usd=10.0,
        spend_provider=spends.get,
    )

    class _RT:
        agent_name = "recon"

    class _Req:
        state = {"engagement_name": "test"}
        runtime = _RT()

    with pytest.raises(BudgetExceeded) as exc_info:
        mw._enforce(_Req())
    assert exc_info.value.scope == "agent"


def test_provider_exception_is_swallowed():
    def _bad_provider(_k):
        raise RuntimeError("postgres down")

    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        spend_provider=_bad_provider,
    )

    class _Req:
        state = {"engagement_name": "test"}
        runtime = None

    mw._enforce(_Req())


def test_soft_warn_fires_once_per_scope():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        soft_warn_at_pct=0.5,
        spend_provider=lambda _k: 7.0,
    )

    class _Req:
        state = {"engagement_name": "test"}
        runtime = None

    mw._enforce(_Req())
    assert "engagement:engagement:test" in mw._warned_scopes
    mw._enforce(_Req())
    assert len(mw._warned_scopes) == 1


# ------------------------------------------------------------- _tag_request


class _OverridableReq:
    """Minimal ModelRequest stand-in supporting ``override``."""

    def __init__(self, model_settings: dict | None = None):
        self.state = {"engagement_name": "test"}

        class _RT:
            agent_name = "recon"

        self.runtime = _RT()
        self.model_settings = model_settings or {}

    def override(self, **kwargs):
        new = _OverridableReq()
        new.__dict__.update(self.__dict__)
        new.__dict__.update(kwargs)
        return new


def test_tag_request_injects_scope_tags():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 0.0,
    )
    tagged = mw._tag_request(_OverridableReq())
    tags = tagged.model_settings["extra_body"]["metadata"]["tags"]
    assert tags == ["engagement:test", "agent:test:recon"]


def test_tag_request_preserves_existing_extra_body_and_tags():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 0.0,
    )
    req = _OverridableReq(
        model_settings={
            "extra_body": {
                "thinking": {"type": "enabled"},
                "metadata": {"tags": ["custom-tag"], "trace_id": "t-1"},
            },
            "max_tokens": 64,
        }
    )
    tagged = mw._tag_request(req)
    extra = tagged.model_settings["extra_body"]
    assert extra["thinking"] == {"type": "enabled"}
    assert tagged.model_settings["max_tokens"] == 64
    assert extra["metadata"]["trace_id"] == "t-1"
    assert extra["metadata"]["tags"] == [
        "custom-tag",
        "engagement:test",
        "agent:test:recon",
    ]
    # the original request's settings must not be mutated in place
    assert req.model_settings["extra_body"]["metadata"]["tags"] == ["custom-tag"]


def test_tag_request_is_idempotent():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 0.0,
    )
    once = mw._tag_request(_OverridableReq())
    twice = mw._tag_request(once)
    tags = twice.model_settings["extra_body"]["metadata"]["tags"]
    assert tags == ["engagement:test", "agent:test:recon"]


def test_tag_request_noop_when_disabled():
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=0.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 0.0,
    )
    req = _OverridableReq()
    assert mw._tag_request(req) is req


# ------------------------------------------------- per-run state caps


class _StateReq:
    """Request stand-in with configurable state and runtime agent name."""

    def __init__(self, state: dict | None = None, agent_name: str = "recon"):
        self.state = state if state is not None else {"engagement_name": "test"}

        class _RT:
            pass

        rt = _RT()
        rt.agent_name = agent_name
        self.runtime = rt


def test_resolve_caps_falls_back_to_constructor_when_state_has_no_caps():
    """A request with no cap keys behaves exactly as before this knob existed."""
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=2.0,
        soft_warn_at_pct=0.25,
        spend_provider=lambda _k: 0.0,
    )
    assert mw._resolve_caps(_StateReq()) == (10.0, 2.0, 0.25)


def test_resolve_caps_falls_back_to_env_when_state_has_no_caps(monkeypatch):
    monkeypatch.setenv("DECEPTICON_BUDGET__ENGAGEMENT_USD", "7.5")
    monkeypatch.setenv("DECEPTICON_BUDGET__PER_AGENT_USD", "1.5")
    monkeypatch.setenv("DECEPTICON_BUDGET__SOFT_WARN_AT_PCT", "0.4")
    mw = BudgetEnforcementMiddleware(spend_provider=lambda _k: 0.0)
    assert mw._resolve_caps(_StateReq()) == (7.5, 1.5, 0.4)


def test_state_caps_override_constructor_and_env(monkeypatch):
    """Per-run operator intent wins over the deployment values, for that run."""
    monkeypatch.setenv("DECEPTICON_BUDGET__ENGAGEMENT_USD", "7.5")
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=2.0,
        soft_warn_at_pct=0.25,
        spend_provider=lambda _k: 0.0,
    )
    state = {
        "engagement_name": "test",
        "budget_engagement_usd": 500.0,
        "budget_per_agent_usd": 50.0,
        "budget_soft_warn_at_pct": 0.9,
    }
    assert mw._resolve_caps(_StateReq(state)) == (500.0, 50.0, 0.9)
    # ...and only for that run: a state-less request still sees the deployment.
    assert mw._resolve_caps(_StateReq()) == (10.0, 2.0, 0.25)


def test_state_cap_enables_enforcement_on_uncapped_deployment():
    """No env/constructor cap, but the run asked for one: enforce it."""
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=0.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 15.0,
    )
    assert mw._enabled() is False
    req = _StateReq({"engagement_name": "test", "budget_engagement_usd": 10.0})
    with pytest.raises(BudgetExceeded) as exc_info:
        mw._enforce(req)
    assert exc_info.value.scope == "engagement"
    # The STATE cap — not some constructor/env value — is what tripped.
    assert exc_info.value.cap_usd == 10.0


def test_state_cap_overrides_env_cap_for_enforcement(monkeypatch):
    """Raising the cap per run must suppress a deployment cap that would trip."""
    monkeypatch.setenv("DECEPTICON_BUDGET__ENGAGEMENT_USD", "5")
    monkeypatch.delenv("DECEPTICON_BUDGET__PER_AGENT_USD", raising=False)
    mw = BudgetEnforcementMiddleware(spend_provider=lambda _k: 10.0)
    # Deployment cap alone would raise...
    with pytest.raises(BudgetExceeded):
        mw._enforce(_StateReq())
    # ...but the run raised it to 100.
    mw._enforce(_StateReq({"engagement_name": "test", "budget_engagement_usd": 100.0}))


def test_state_soft_warn_fraction_is_honoured():
    """The state fraction — not the constructor's 0.9 — decides the warning."""
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        soft_warn_at_pct=0.9,
        spend_provider=lambda _k: 6.0,
    )
    state = {"engagement_name": "test", "budget_soft_warn_at_pct": 0.5}
    mw._enforce(_StateReq(state))
    assert "engagement:engagement:test" in mw._warned_scopes
    # Once per scope, same as the deployment-configured path.
    mw._enforce(_StateReq(state))
    assert len(mw._warned_scopes) == 1


def test_state_soft_warn_absent_uses_constructor_fraction():
    """60% spend is below the constructor's 90% → no warning."""
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        soft_warn_at_pct=0.9,
        spend_provider=lambda _k: 6.0,
    )
    mw._enforce(_StateReq())
    assert mw._warned_scopes == set()


@pytest.mark.parametrize(
    "value",
    ["not-a-number", -5, 0.0, None, True, [1], {"usd": 1}],
)
def test_malformed_state_engagement_cap_falls_back(value):
    """Zero, negative, non-numeric, ``None`` and bool junk keep the fallback.

    ``None`` in state is the same as an absent key: the wire may include the
    field with a null rather than omitting it.
    """
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 0.0,
    )
    state = {"engagement_name": "test", "budget_engagement_usd": value}
    assert mw._resolve_caps(_StateReq(state))[0] == 10.0


@pytest.mark.parametrize("value", ["junk", -1, 0, 1.5, 100, True])
def test_malformed_state_soft_warn_falls_back(value):
    """A wire fraction outside (0, 1] — or non-numeric — keeps the default.

    100 and 1.5 are the 0..100-percent mistakes the wire contract forbids;
    accepting them would silently move the warning threshold.
    """
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        soft_warn_at_pct=0.3,
        spend_provider=lambda _k: 0.0,
    )
    state = {"engagement_name": "test", "budget_soft_warn_at_pct": value}
    assert mw._resolve_caps(_StateReq(state))[2] == 0.3


def test_malformed_state_value_does_not_raise():
    """Garbage run input is ignored, never fatal: the guardrail stays up."""
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=10.0,
        per_agent_cap_usd=0.0,
        spend_provider=lambda _k: 5.0,
    )
    mw._enforce(
        _StateReq(
            {
                "engagement_name": "test",
                "budget_engagement_usd": "twelve",
                "budget_per_agent_usd": "n/a",
                "budget_soft_warn_at_pct": "half",
            }
        )
    )


def test_state_per_agent_cap_enforced_separately():
    spends = {"engagement:test": 1.0, "agent:test:recon": 50.0}
    mw = BudgetEnforcementMiddleware(
        engagement_cap_usd=0.0,
        per_agent_cap_usd=0.0,
        spend_provider=spends.get,
    )
    state = {"engagement_name": "test", "budget_per_agent_usd": 10.0}
    with pytest.raises(BudgetExceeded) as exc_info:
        mw._enforce(_StateReq(state))
    assert exc_info.value.scope == "agent"
    assert exc_info.value.cap_usd == 10.0
