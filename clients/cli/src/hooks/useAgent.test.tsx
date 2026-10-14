// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  createMockStream,
  createMockClient,
  createControllableStream,
  type MockClient,
  type StreamEvent,
} from "./__fixtures__/mockStream.js";

// ── Hoisted mock state ──────────────────────────────────────────────────────
// vi.hoisted() runs before module imports so the factory closure is safe to
// reference even after vitest hoists the vi.mock() calls.
const { mockState } = vi.hoisted(() => ({
  mockState: { client: null as MockClient | null },
}));

vi.mock("@langchain/langgraph-sdk", () => ({
  Client: vi.fn(() => mockState.client),
}));

vi.mock("../utils/threadStore.js", () => ({
  saveThread: vi.fn(async () => {}),
  touchThread: vi.fn(async () => {}),
  loadThreadByIndex: vi.fn(async () => null),
}));

vi.mock("../commands/planMode.js", () => ({
  assertRedApproved: vi.fn(async () => {}),
}));

// ── Module-level binding (reset per test via dynamic import) ─────────────────
// useAgent reads INITIAL_ASSISTANT_ID = process.env.DECEPTICON_ASSISTANT_ID at
// module load time. Static import would capture the value before vi.stubEnv()
// runs in beforeEach. Dynamic import after stubbing gets the right default.
let useAgent: (typeof import("./useAgent.js"))["useAgent"];

// ── Common event fixtures ────────────────────────────────────────────────────
const noopValuesEvent: StreamEvent = { event: "values", data: { messages: [] } };

const engagementReadyEvent: StreamEvent = {
  event: "custom",
  data: { type: "engagement_ready" },
};

// ── Suite ────────────────────────────────────────────────────────────────────
describe("useAgent — engagement handoff lifecycle", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("DECEPTICON_API_URL", "http://localhost:2024");
    vi.stubEnv("DECEPTICON_ASSISTANT_ID", "soundwave");
    vi.stubEnv("DECEPTICON_ENGAGEMENT", "eng-abc");
    vi.stubEnv("DECEPTICON_WORKSPACE_PATH", "/tmp/ws");
    vi.stubEnv("DECEPTICON_TARGET_TYPE", "web_url");
    vi.stubEnv("DECEPTICON_TARGET", "https://target.example");
    vi.stubEnv("DECEPTICON_AUTHORIZATION_CONFIRMED", "true");
    delete process.env.DECEPTICON_THREAD_ID;
    mockState.client = createMockClient();
    ({ useAgent } = await import("./useAgent.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends the selected model through graph input on set, repeat, change and clear", async () => {
    const { setModelOverride } = await import("../commands/modelOverride.js");
    const { result } = renderHook(() => useAgent());
    const selections = ["auth/gpt-6-luna", "auth/gpt-6-luna", "auth/gpt-6.1-sol", ""];
    for (const selected of selections) {
      setModelOverride(selected);
      act(() => result.current.submit("hello"));
      await act(async () => { await vi.runAllTimersAsync(); });
    }
    const requests = (mockState.client!.runs.stream as Mock).mock.calls.map((call) => call[2]);
    // Clearing drops the field entirely: `setModelOverride("")` means "no
    // override", and the saved dashboard policy (absent here) has nothing to
    // fall back to, so the run payload stays byte-identical to a plain one.
    expect(requests.map((request) => request.input.model_override))
      .toEqual([...selections.slice(0, 3), undefined]);
    expect(requests.every((request) => request.input.model_overrides === undefined)).toBe(true);
    expect(requests.every((request) => request.context === undefined)).toBe(true);
    expect(requests.every((request) => request.config?.configurable.model_override === undefined)).toBe(true);
  });

  it("layers the saved dashboard model policy under the in-session choice", async () => {
    const { setModelOverride } = await import("../commands/modelOverride.js");
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDE", "openai/gpt-5.5");
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDES", '{"soundwave":"auth/claude-sonnet-5"}');
    const { result } = renderHook(() => useAgent());

    // No `/model` in this session → the kickoff run carries the saved policy.
    act(() => result.current.submit("hello"));
    await act(async () => { await vi.runAllTimersAsync(); });
    const saved = (mockState.client!.runs.stream as Mock).mock.calls.at(-1)?.[2];
    expect(saved.input.model_override).toBe("openai/gpt-5.5");
    expect(saved.input.model_overrides).toEqual({ soundwave: "auth/claude-sonnet-5" });

    // `/model` typed in this terminal is the more recent intent → it wins.
    setModelOverride("auth/gpt-6-luna");
    act(() => result.current.submit("again"));
    await act(async () => { await vi.runAllTimersAsync(); });
    const typed = (mockState.client!.runs.stream as Mock).mock.calls.at(-1)?.[2];
    expect(typed.input.model_override).toBe("auth/gpt-6-luna");
    expect(typed.input.model_overrides).toEqual({ soundwave: "auth/claude-sonnet-5" });
  });

  it("sends the saved run-scoped LLM and guardrail knobs on the kickoff run only", async () => {
    const { setModelOverride } = await import("../commands/modelOverride.js");
    // Module-level store shared by every test in this file; clear the override
    // the previous case left behind so this one isolates the saved policy.
    setModelOverride("");
    // No saved model row either: the model channel must stay absent.
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDE", "");
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDES", "");
    const stream = mockState.client!.runs.stream as Mock;
    vi.stubEnv("DECEPTICON_RUN_REASONING_EFFORT", "medium");
    vi.stubEnv("DECEPTICON_RUN_LLM_MAX_OUTPUT_TOKENS", "4096");
    vi.stubEnv("DECEPTICON_RUN_LLM_DISABLE_STREAMING", "1");
    vi.stubEnv("DECEPTICON_RUN_BUDGET_ENGAGEMENT_USD", "25");
    vi.stubEnv("DECEPTICON_RUN_BUDGET_PER_AGENT_USD", "5");
    vi.stubEnv("DECEPTICON_RUN_BUDGET_SOFT_WARN_AT_PCT", "0.8");
    vi.stubEnv("DECEPTICON_RUN_HITL_ENABLED", "true");
    const { result } = renderHook(() => useAgent());

    const pausedStream = createControllableStream();
    stream.mockReturnValueOnce(pausedStream);
    act(() => result.current.submit("hello"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const kickoff = stream.mock.calls.at(-1)?.[2];
    expect(kickoff.input).toMatchObject({
      reasoning_effort: "medium",
      llm_max_output_tokens: 4096,
      llm_disable_streaming: true,
      budget_engagement_usd: 25,
      budget_per_agent_usd: 5,
      budget_soft_warn_at_pct: 0.8,
      hitl_enabled: true,
    });
    // No `/model` and no saved model row → the model channel stays absent.
    expect("model_override" in kickoff.input).toBe(false);

    // Reach the pause point, then resume: the kickoff-only fields are already
    // in the checkpoint, so the update writes back just the model channel.
    await act(async () => {
      await pausedStream.emit({
        event: "custom", data: { type: "ask_user_question", question: "Continue?" },
      });
    });
    await act(async () => { pausedStream.end(); await vi.runAllTimersAsync(); });
    expect(result.current.runState).toBe("paused");

    act(() => result.current.resume("yes"));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(stream.mock.calls.at(-1)?.[2].command).toEqual({
      resume: "yes", update: { model_override: "" },
    });
  });

  it("omits every run-scoped knob when the saved policy is default", async () => {
    const { setModelOverride } = await import("../commands/modelOverride.js");
    // The model store is module-level and shared; clear it so this case pins
    // "policy is default", not "whatever the previous case typed".
    setModelOverride("");
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDE", "");
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDES", "");
    for (const name of [
      "DECEPTICON_RUN_REASONING_EFFORT",
      "DECEPTICON_RUN_LLM_MAX_OUTPUT_TOKENS",
      "DECEPTICON_RUN_LLM_DISABLE_STREAMING",
      "DECEPTICON_RUN_BUDGET_ENGAGEMENT_USD",
      "DECEPTICON_RUN_BUDGET_PER_AGENT_USD",
      "DECEPTICON_RUN_BUDGET_SOFT_WARN_AT_PCT",
      "DECEPTICON_RUN_HITL_ENABLED",
    ]) {
      vi.stubEnv(name, "");
    }
    const { result } = renderHook(() => useAgent());

    act(() => result.current.submit("hello"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const input = (mockState.client!.runs.stream as Mock).mock.calls.at(-1)?.[2].input;
    expect(Object.keys(input ?? {}).sort()).toEqual(["messages"]);
  });

  it("never carries provider extra headers on the run input", async () => {
    const { setModelOverride } = await import("../commands/modelOverride.js");
    setModelOverride("");
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDE", "");
    vi.stubEnv("DECEPTICON_RUN_MODEL_OVERRIDES", "");
    // Provider headers are a startup-only deployment value the agent process
    // reads from its own environment; the run input round-trips through the
    // LangGraph checkpoint, so a header value must never reach it.
    vi.stubEnv("DECEPTICON_RUN_LLM_EXTRA_HEADERS", '{"X-Tenant":"acme"}');
    const { result } = renderHook(() => useAgent());

    act(() => result.current.submit("hello"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const input = (mockState.client!.runs.stream as Mock).mock.calls.at(-1)?.[2].input;
    expect(Object.keys(input ?? {}).sort()).toEqual(["messages"]);
    expect(JSON.stringify(input)).not.toContain("acme");
  });

  it.each(["resume", "answerQuestion"] as const)(
    "%s updates the checkpoint with the current model, including clear", async (method) => {
      const { setModelOverride } = await import("../commands/modelOverride.js");
      const stream = mockState.client!.runs.stream as Mock;
      const { result } = renderHook(() => useAgent());
      for (const selected of ["auth/gpt-6.1-sol", ""]) {
        const pausedStream = createControllableStream();
        stream.mockReturnValueOnce(pausedStream);
        act(() => result.current.submit("hello"));
        await act(async () => { await vi.runAllTimersAsync(); });
        await act(async () => {
          await pausedStream.emit({
            event: "custom", data: { type: "ask_user_question", question: "Continue?" },
          });
        });
        await act(async () => { pausedStream.end(); await vi.runAllTimersAsync(); });
        expect(result.current.runState).toBe("paused");
        setModelOverride(selected);
        act(() => result.current[method]("yes"));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(stream.mock.calls.at(-1)?.[2].command).toEqual({
          resume: "yes", update: { model_override: selected },
        });
      }
    },
  );

  it.each([
    [{ finish_reason: "length" }, "output token limit"],
    [{ stop_reason: "max_tokens" }, "output token limit"],
    [{ finish_reason: "content_filter" }, "content filter"],
    [{ finish_reason: "stop" }, "cause is unknown"],
    [{}, "cause is unknown"],
  ])("reports empty-response metadata %j without recommending a blind retry", async (metadata, diagnosis) => {
    (mockState.client!.runs.stream as Mock).mockReturnValueOnce(createMockStream([
      { event: "metadata", data: { run_id: "run-empty-response" } },
      { event: "values", data: { messages: [{
        type: "ai", content: "", response_metadata: metadata,
      }] } },
    ]));
    const { result } = renderHook(() => useAgent());

    act(() => result.current.submit("hello"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const notices = result.current.events.filter((event) => event.type === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain(diagnosis);
    expect(notices[0].content).toContain("run-empty-response");
    expect(notices[0].content).not.toContain("/resume");
  });

  it("reports a server error without a duplicate or lost-connection notice", async () => {
    (mockState.client!.runs.stream as Mock).mockReturnValueOnce(createMockStream([
      { event: "error", data: { message: "Model request exceeds context size" } },
    ]));
    const { result } = renderHook(() => useAgent());

    act(() => result.current.submit("hello"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const notices = result.current.events.filter((event) => event.type === "system");
    expect(notices).toEqual([]);
    expect(result.current.error).toBe("Model request exceeds context size");
    expect(result.current.runState).toBe("idle");
  });

  it.each(["", "BENIGN_QA_OK"])("reports invalid tool calls when visible content is %j", async (content) => {
    const client = createMockClient();
    mockState.client = client;
    client.runs.stream.mockReturnValueOnce(createMockStream([
      { event: "metadata", data: { run_id: "run-invalid-tool" } },
      { event: "values", data: { messages: [{
        type: "ai", content,
        invalid_tool_calls: [{ name: "format_note", args: "not-json", error: "Invalid JSON" }],
      }] } },
    ]));
    const { result } = renderHook(() => useAgent());

    act(() => result.current.submit("hello"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const notices = result.current.events.filter((event) => event.type === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.content).toContain("invalid tool call");
    expect(notices[0]?.content).toContain("run-invalid-tool");
  });

  it("reports a failed history lookup without claiming the session was loaded", async () => {
    const client = mockState.client;
    if (!client) throw new TypeError("Expected an initialized test client");
    client.threads.getState.mockRejectedValueOnce(new TypeError("Session not found"));
    const { result } = renderHook(() => useAgent());

    act(() => result.current.resume("missing-thread"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const notices = result.current.events.filter((event) => event.type === "system");
    expect(notices.at(-1)?.content).toBe(
      "Could not restore this session. Check server availability and the session ID.",
    );
  });

  it("keeps Plan active when a legacy engagement_ready event arrives", async () => {
    const stream = createControllableStream();
    (mockState.client!.runs.stream as Mock).mockReturnValueOnce(stream);

    const { result } = renderHook(() => useAgent());

    // First runs.stream call should use the INITIAL_ASSISTANT_ID = "soundwave"
    act(() => {
      result.current.submit("hello soundwave");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect((mockState.client!.runs.stream as Mock).mock.calls[0][1]).toBe("soundwave");

    // Emit engagement_ready while the stream is still open
    await act(async () => {
      await stream.emit(engagementReadyEvent);
    });

    expect(result.current.assistantId).toBe("soundwave");
    expect(result.current.events.at(-1)?.content).toContain("/mode red");

    // Clean up — end stream so the hook reaches an idle state
    await act(async () => {
      stream.end();
      await vi.runAllTimersAsync();
    });
  });

  it("keeps a queued Plan message in Plan after the legacy completion event", async () => {
    const firstStream = createControllableStream();
    const secondStream = createMockStream([noopValuesEvent]);
    const mc = mockState.client!;
    (mc.runs.stream as Mock)
      .mockReturnValueOnce(firstStream)
      .mockReturnValueOnce(secondStream);
    (mc.threads.create as Mock)
      .mockResolvedValueOnce({ thread_id: "thread-soundwave" })
      .mockResolvedValueOnce({ thread_id: "thread-decepticon" });

    const { result } = renderHook(() => useAgent());

    act(() => {
      result.current.submit("start engagement");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.enqueue("queued follow-up");
    });
    expect(result.current.queuedMessage).toBe("queued follow-up");

    await act(async () => {
      await firstStream.emit(engagementReadyEvent);
    });
    await act(async () => {
      firstStream.end();
      await vi.runAllTimersAsync(); // fire setTimeout(0) auto-submit
    });

    const streamCalls = (mc.runs.stream as Mock).mock.calls;
    const createCalls = (mc.threads.create as Mock).mock.calls;

    expect(createCalls.length).toBe(1);
    expect(streamCalls.length).toBe(2);
    expect(streamCalls[1][0]).toBe("thread-soundwave");
    expect(streamCalls[1][1]).toBe("soundwave");

    // Second stream call's input carries the queued message
    const secondInput = streamCalls[1][2].input as { messages: Array<{ content: string }> };
    expect(secondInput.messages[0].content).toBe("queued follow-up");
  });

  // ── 3. Engagement fields travel only via config.configurable ─────────────
  it("injects engagement context via config.configurable only — never as top-level run input", async () => {
    const firstStream = createControllableStream();
    const secondStream = createMockStream([noopValuesEvent]);
    const mc = mockState.client!;
    (mc.runs.stream as Mock)
      .mockReturnValueOnce(firstStream)
      .mockReturnValueOnce(secondStream);
    (mc.threads.create as Mock)
      .mockResolvedValueOnce({ thread_id: "thread-soundwave" })
      .mockResolvedValueOnce({ thread_id: "thread-decepticon" });

    const { result } = renderHook(() => useAgent());

    act(() => {
      result.current.submit("start");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.enqueue("decepticon prompt");
    });

    await act(async () => {
      await firstStream.emit(engagementReadyEvent);
    });
    await act(async () => {
      firstStream.end();
      await vi.runAllTimersAsync();
    });

    const streamCalls = (mc.runs.stream as Mock).mock.calls;
    expect(streamCalls.length).toBe(2);

    for (let i = 0; i < 2; i++) {
      const opts = streamCalls[i][2] as Record<string, unknown>;

      // Engagement fields must never appear anywhere inside `input` — checked
      // recursively via serialization to catch nested placements.
      const inputJson = JSON.stringify(opts.input);
      expect(inputJson).not.toContain("engagement_name");
      expect(inputJson).not.toContain("workspace_path");
      expect(inputJson).not.toContain("target_value");
      expect(inputJson).not.toContain("authorization_confirmed");

      // Engagement fields must be present in config.configurable for every
      // run (the env vars are set for the full test, so both submits route
      // context this way per the post-#182 architecture).
      const configurable = (opts.config as Record<string, unknown> | undefined)
        ?.configurable as Record<string, unknown> | undefined;
      expect(configurable).toMatchObject({
        engagement_name: "eng-abc",
        workspace_path: "/tmp/ws",
        target_type: "web_url",
        target_value: "https://target.example",
        authorization_confirmed: true,
      });
    }
  });

  // ── 4. No handoff — thread state preserved across two submits ────────────
  it("preserves thread across two submits when no engagement_ready fires", async () => {
    const firstStream = createMockStream([noopValuesEvent]);
    const secondStream = createMockStream([noopValuesEvent]);
    const mc = mockState.client!;
    (mc.runs.stream as Mock)
      .mockReturnValueOnce(firstStream)
      .mockReturnValueOnce(secondStream);

    const { result } = renderHook(() => useAgent());

    // First submit — stream has no handoff event
    act(() => {
      result.current.submit("first");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    // Flush again — processStream → handleStreamComplete → setState chain
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.runState).toBe("idle");

    // Second submit — same thread should be reused
    act(() => {
      result.current.submit("second");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.runState).toBe("idle");

    const streamCalls = (mc.runs.stream as Mock).mock.calls;
    const createCalls = (mc.threads.create as Mock).mock.calls;

    // Only one thread was created across both runs
    expect(createCalls.length).toBe(1);

    // Both stream calls used the same threadId
    expect(streamCalls.length).toBe(2);
    expect(streamCalls[0][0]).toBe(streamCalls[1][0]);

    // assistantId never flipped
    expect(result.current.assistantId).toBe("soundwave");
  });

  it("keeps Interview on the same thread after a planning draft", async () => {
    const mc = mockState.client!;
    (mc.runs.stream as Mock)
      .mockReturnValueOnce(createMockStream([
        { event: "custom", data: { type: "planning_draft_ready" } },
      ]))
      .mockReturnValueOnce(createMockStream([noopValuesEvent]));
    const { result } = renderHook(() => useAgent());

    act(() => result.current.submit("prepare plan"));
    await act(async () => { await vi.runAllTimersAsync(); });
    act(() => result.current.submit("revise plan"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const calls = (mc.runs.stream as Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(calls[1][0]);
    expect(calls[1][1]).toBe("soundwave");
    expect(result.current.assistantId).toBe("soundwave");
    expect(result.current.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "system",
        content: expect.stringContaining("Planning draft ready for review"),
      }),
    ]));
  });

  it("keeps separate Plan and Red threads and restores the Plan transcript", async () => {
    const mc = mockState.client!;
    (mc.threads.create as Mock)
      .mockResolvedValueOnce({ thread_id: "interview-thread" })
      .mockResolvedValueOnce({ thread_id: "red-thread" });
    (mc.runs.stream as Mock)
      .mockReturnValueOnce(createMockStream([noopValuesEvent]))
      .mockReturnValueOnce(createMockStream([noopValuesEvent]))
      .mockReturnValueOnce(createMockStream([noopValuesEvent]));
    const { setAssistantOverride } = await import("../commands/assistantOverride.js");
    const { result } = renderHook(() => useAgent());

    act(() => result.current.submit("prepare plan"));
    await act(async () => { await vi.runAllTimersAsync(); });
    act(() => expect(result.current.selectAssistant("decepticon")).toBe(true));
    setAssistantOverride("decepticon");
    act(() => result.current.submit("begin approved Red work"));
    await act(async () => { await vi.runAllTimersAsync(); });

    const calls = (mc.runs.stream as Mock).mock.calls;
    expect(mc.threads.create).toHaveBeenCalledTimes(2);
    expect(calls[0][0]).not.toBe(calls[1][0]);
    expect(calls[1][1]).toBe("decepticon");
    expect(result.current.assistantId).toBe("decepticon");
    expect(result.current.events.some((event) => event.content === "prepare plan")).toBe(false);

    act(() => expect(result.current.selectAssistant("soundwave")).toBe(true));
    setAssistantOverride("soundwave");
    expect(result.current.events.some((event) => event.content === "prepare plan")).toBe(true);
    expect(result.current.events.some((event) => event.content === "begin approved Red work")).toBe(false);
    act(() => result.current.submit("revise plan"));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(mc.threads.create).toHaveBeenCalledTimes(2);
    expect((mc.runs.stream as Mock).mock.calls[2][0]).toBe("interview-thread");
  });

  it("does not stream a Red message after scope approval becomes stale", async () => {
    const { assertRedApproved } = await import("../commands/planMode.js");
    vi.mocked(assertRedApproved).mockRejectedValueOnce(new Error("Red scope changed"));
    const { result } = renderHook(() => useAgent());

    act(() => expect(result.current.selectAssistant("decepticon")).toBe(true));
    act(() => result.current.submit("continue Red work"));
    await act(async () => { await vi.runAllTimersAsync(); });

    expect(mockState.client!.runs.stream).not.toHaveBeenCalled();
    expect(result.current.error).toContain("Red scope changed");
    expect(result.current.runState).toBe("idle");
  });

  it("does not switch the visible mode during a live run", async () => {
    const stream = createControllableStream();
    (mockState.client!.runs.stream as Mock).mockReturnValueOnce(stream);
    const { result } = renderHook(() => useAgent());
    act(() => result.current.submit("plan"));
    await act(async () => { await vi.runAllTimersAsync(); });
    act(() => expect(result.current.selectAssistant("blue_cell")).toBe(false));
    expect(result.current.assistantId).toBe("soundwave");
    await act(async () => { stream.end(); await vi.runAllTimersAsync(); });
  });

  it("recovers after thread creation retries are exhausted", async () => {
    const mc = mockState.client!;
    const createThread = mc.threads.create as Mock;
    for (let attempt = 0; attempt < 5; attempt++) {
      createThread.mockRejectedValueOnce(new Error("server unavailable"));
    }
    createThread.mockResolvedValueOnce({ thread_id: "thread-recovered" });
    (mc.runs.stream as Mock).mockReturnValueOnce(createMockStream([noopValuesEvent]));

    const { result } = renderHook(() => useAgent());

    act(() => {
      result.current.submit("first attempt");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(createThread).toHaveBeenCalledTimes(5);
    expect(result.current.runState).toBe("idle");
    expect(result.current.error).toBe("Connection failed: server unavailable");
    expect(result.current.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "system",
        content: "Connection failed: server unavailable",
      }),
    ]));

    act(() => {
      result.current.submit("retry");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(createThread).toHaveBeenCalledTimes(6);
    expect(mc.runs.stream).toHaveBeenCalledTimes(1);
    expect(result.current.runState).toBe("idle");
  });

  it("keeps queuedMessage intact after a legacy engagement_ready event", async () => {
    const firstStream = createControllableStream();
    const secondStream = createMockStream([noopValuesEvent]);
    const mc = mockState.client!;
    (mc.runs.stream as Mock)
      .mockReturnValueOnce(firstStream)
      .mockReturnValueOnce(secondStream);
    (mc.threads.create as Mock)
      .mockResolvedValueOnce({ thread_id: "t-soundwave" })
      .mockResolvedValueOnce({ thread_id: "t-decepticon" });

    const { result } = renderHook(() => useAgent());

    act(() => {
      result.current.submit("start");
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Queue a message while the stream is active
    act(() => {
      result.current.enqueue("queued-msg");
    });
    expect(result.current.queuedMessage).toBe("queued-msg");

    // Emit engagement_ready — keep the stream open
    await act(async () => {
      await firstStream.emit(engagementReadyEvent);
    });

    // Queue must still be intact — engagement_ready alone must not clear it
    expect(result.current.queuedMessage).toBe("queued-msg");

    // Now end the stream — handleStreamComplete handoff branch auto-submits
    await act(async () => {
      firstStream.end();
      await vi.runAllTimersAsync();
    });
    // Additional flush for the queued auto-submit to complete
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // After the handoff auto-submit fires, queuedMessage is cleared
    expect(result.current.queuedMessage).toBeNull();
  });
});
