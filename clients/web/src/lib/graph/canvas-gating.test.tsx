/**
 * Mount-level gating for `AgentGraphCanvas`.
 *
 * The canvas is the piece that decides when the graph is "live", and that
 * decision is what stops the GPU work:
 *
 *   - while a run is active and the tab is visible, the physics loop ticks and
 *     the activity rings / flowing edge dots animate;
 *   - the moment the run ends — or the document is hidden — the same graph must
 *     render as a *static* image: no animated element, and no simulation loop
 *     behind it (asserted through `useForceSimulation`, whose paused path is
 *     covered in force-simulation.test.tsx).
 *
 * A hidden tab still gets animation frames, so this is the case that kept the
 * whole canvas re-rendering in the background.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import "../../../test-css-stub";
import { I18nProvider } from "@/lib/i18n-context";
import { EngagementProvider } from "@/lib/engagement-context";
import type { AgentConfig } from "@/lib/agents";
import type { SubagentCustomEvent } from "@decepticon/streaming";

/**
 * The canvas imports its stylesheet for side effects, which `tsx` cannot parse
 * as JavaScript; `../../../test-css-stub` makes every `.css` specifier resolve
 * to an empty module. The hook has to be installed before the component's
 * module graph is evaluated, so the canvas is reached with an `await import()`
 * inside a test (a static import would be hoisted above it).
 */
type CanvasModule = typeof import("@/components/agents/agent-graph-canvas");
let canvasModule: Promise<CanvasModule> | null = null;

function loadCanvas(): Promise<CanvasModule> {
  canvasModule ??= import("@/components/agents/agent-graph-canvas");
  return canvasModule;
}

const AGENTS: AgentConfig[] = [
  { id: "decepticon", name: "Decepticon", role: "orchestrator", color: "#22d3ee", description: "" },
  { id: "recon", name: "Recon", role: "worker", color: "#a855f7", description: "" },
];

const STREAM: SubagentCustomEvent[] = [
  { type: "subagent_start", agent: "recon" },
  { type: "subagent_tool_call", agent: "recon", tool: "nmap_scan" },
];

function flush(ms = 0): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function mountCanvas(isRunning: boolean, events: SubagentCustomEvent[] = STREAM) {
  const { AgentGraphCanvas } = await loadCanvas();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = async (running: boolean, nextEvents = events) => {
    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: "en",
          children: createElement(EngagementProvider, {
            engagementId: "eng-1",
            engagementSlug: "eng-1",
            agentId: "decepticon",
            threadId: "thread-1",
            setThreadId: () => {},
            events: nextEvents,
            isRunning: running,
            activeRunId: running ? "run-1" : null,
            children: createElement(AgentGraphCanvas, {
              agents: AGENTS,
              events: nextEvents,
              selectedAgent: null,
              onAgentClick: () => {},
            }),
          }),
        }),
      );
    });
    await act(() => flush(60));
  };

  await render(isRunning);

  return {
    container,
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Animation carriers on the canvas, split by lifetime:
 *  - `loopingRings` are the `infinite` state rings (processing/waiting/failed)
 *    that keep the compositor busy for as long as they exist;
 *  - `flowingDots` are the SMIL edge dots, re-rastered every frame.
 *
 * The one-shot completion fade is excluded: it plays once and then leaves a
 * still image, so it is not a continuing cost.
 */
function animatedCounts(container: HTMLElement) {
  return {
    loopingRings: container.querySelectorAll(
      ".canvas-ring-processing, .canvas-ring-waiting, .canvas-ring-failed",
    ).length,
    flowingDots: container.querySelectorAll("animateMotion").length,
  };
}

/** A jsdom event (the global `Event` is Node's and cannot be dispatched here). */
function visibilityEvent(): Event {
  return new window.Event("visibilitychange");
}

test("a live, visible run animates rings and edge dots", async () => {
  const { container, unmount } = await mountCanvas(true);
  try {
    const counts = animatedCounts(container);
    assert.ok(counts.loopingRings > 0, "live agents must show an activity ring");
    assert.ok(counts.flowingDots > 0, "live edges must flow dots");
    // The graph itself must still be drawn.
    assert.ok(container.querySelector("circle"), "nodes must render");
  } finally {
    await unmount();
  }
});

test("a finished run renders the same graph with nothing looping", async () => {
  const live = await mountCanvas(true);
  let liveNodes = 0;
  try {
    liveNodes = live.container.querySelectorAll("circle, text").length;
    assert.ok(animatedCounts(live.container).flowingDots > 0);
  } finally {
    await live.unmount();
  }

  const idle = await mountCanvas(false);
  try {
    const counts = animatedCounts(idle.container);
    assert.equal(counts.loopingRings, 0, "no state ring may keep looping");
    assert.equal(counts.flowingDots, 0, "no edge may keep flowing dots");
    // Same topology is still on screen — the gate removes animation, not nodes.
    assert.ok(idle.container.querySelectorAll("circle, text").length > 0);
    assert.ok(liveNodes > 0);
  } finally {
    await idle.unmount();
  }
});

test("hiding the document stops the looping animation without unmounting the graph", async () => {
  const page = await mountCanvas(true);
  const documentWithVisibility = document as Document & { visibilityState: DocumentVisibilityState };
  const prior = Object.getOwnPropertyDescriptor(documentWithVisibility, "visibilityState");
  try {
    assert.ok(animatedCounts(page.container).flowingDots > 0, "visible first");

    Object.defineProperty(documentWithVisibility, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => {
      document.dispatchEvent(visibilityEvent());
    });
    await act(() => flush(60));

    const hidden = animatedCounts(page.container);
    assert.equal(hidden.loopingRings, 0, "a hidden tab must not loop a state ring");
    assert.equal(hidden.flowingDots, 0, "a hidden tab must not flow edge dots");
    assert.ok(page.container.querySelector("circle"), "the graph stays mounted");

    Object.defineProperty(documentWithVisibility, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(visibilityEvent());
    });
    await act(() => flush(60));

    assert.ok(animatedCounts(page.container).flowingDots > 0, "the flow returns when visible again");
    assert.ok(animatedCounts(page.container).loopingRings > 0, "and so do the state rings");
  } finally {
    if (prior) Object.defineProperty(documentWithVisibility, "visibilityState", prior);
    else Reflect.deleteProperty(documentWithVisibility, "visibilityState");
    await page.unmount();
  }
});
