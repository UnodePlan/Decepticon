/**
 * Painted-geometry regression for `AgentGraphCanvas`.
 *
 * The reported regression was visual: an initial (idle) render of the live agent
 * graph showed 大量节点与标签重叠. The seed layout `useAgentActivity` produces is a
 * 160px agent ring (24px discs on it clear each other, their labels do not) plus a
 * 60px satellite ring per agent, so a working run paints ~97 nodes whose labels
 * and circles all collide — and because an idle/hidden/finished graph never
 * ticked, nothing ever spread them.
 *
 * These cases mount the *real* canvas with the *real* `AGENTS` list and a stream
 * that gives every agent its tool satellites, then parse the rendered SVG
 * (each node's `translate`, its circle radius, its label text box) and assert
 * the painted geometry:
 *
 *   - no two node circles overlap,
 *   - no label box overlaps another node's circle,
 *   - no label box overlaps another label box.
 *
 * The metric is derived from the DOM alone — deliberately not from
 * `useForceSimulation`'s own footprint estimate (force-simulation.test.tsx pins
 * that lifecycle). A wrong internal metric would still have to paint overlapping
 * nodes here to pass, so this is a genuine regression test rather than a copy of
 * the implementation's opinion of itself.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import "../../../test-css-stub";
import { I18nProvider } from "@/lib/i18n-context";
import { EngagementProvider } from "@/lib/engagement-context";
import { AGENTS } from "@/lib/agents";
import type { SubagentCustomEvent } from "@decepticon/streaming";

/**
 * The canvas imports its stylesheet for side effects, which `tsx` cannot parse as
 * JavaScript; `../../../test-css-stub` makes every `.css` specifier resolve to an
 * empty module. The hook has to be installed before the component's module graph
 * is evaluated, so the canvas is reached with an `await import()` inside a test
 * (a static import would be hoisted above it).
 */
type CanvasModule = typeof import("@/components/agents/agent-graph-canvas");
let canvasModule: Promise<CanvasModule> | null = null;

function loadCanvas(): Promise<CanvasModule> {
  canvasModule ??= import("@/components/agents/agent-graph-canvas");
  return canvasModule;
}

const TOOLS = ["nmap_scan", "http_probe", "gobuster", "sqlmap", "hydra"];

/** Every agent starts and then calls 5 tools: 17 agents + 80 tool satellites. */
const FULL_STREAM: SubagentCustomEvent[] = [];
for (const agent of AGENTS) {
  if (agent.id === "decepticon") continue;
  FULL_STREAM.push({ type: "subagent_start", agent: agent.id });
  for (const tool of TOOLS) {
    FULL_STREAM.push({ type: "subagent_tool_call", agent: agent.id, tool });
  }
}

/** The first agent with one tool: enough to paint the ring, not the crowd. */
const SPARSE_STREAM: SubagentCustomEvent[] = (() => {
  const worker = AGENTS.find((a) => a.id !== "decepticon");
  if (!worker) throw new Error("no worker agent configured");
  return [
    { type: "subagent_start", agent: worker.id },
    { type: "subagent_tool_call", agent: worker.id, tool: "nmap_scan" },
  ];
})();

interface NodeGeom {
  x: number;
  y: number;
  radius: number;
  label: string;
  /** Baseline y of the label, in graph space. */
  labelY: number;
  /** Label font size in px (`AgentNode` 11, `SessionNode` 9). */
  fontSize: number;
  /** The orchestrator is the node drawn with an avatar `<image>`. */
  orchestrator: boolean;
}

/**
 * Read the geometry back out of the rendered SVG for one node group:
 *
 *  - position from the group's `translate(...)`;
 *  - radius from the avatar `<image>` (orchestrator) or the innermost stroked
 *    `<circle>` (agent avatar ring, satellite disc) — the unstroked hit-area and
 *    the activity ring are larger, so the minimum is the ink;
 *  - label baseline from the `text.y` attribute, font size from `font-size`.
 */
function parseNodes(container: HTMLElement): NodeGeom[] {
  const svg = container.querySelector("svg.agent-graph-canvas");
  assert.ok(svg, "the canvas must render its svg");
  const inner = svg.querySelector("g[transform]");
  assert.ok(inner, "the canvas must render its transformed node layer");

  const out: NodeGeom[] = [];
  for (const group of Array.from(inner.children)) {
    // Edge groups carry no transform; nodes are the groups that render a label.
    const labelEl = group.querySelector("text.canvas-node-label");
    if (!labelEl) continue;
    const transform = group.getAttribute("transform") ?? "";
    const m = /translate\(([-\d.eE+]+)[ ,]+([-\d.eE+]+)\)/.exec(transform);
    assert.ok(m, `every node group is translated, got "${transform}"`);
    const x = Number(m[1]);
    const y = Number(m[2]);
    const image = group.querySelector("image");
    const stroked = Array.from(group.querySelectorAll(":scope > circle")).filter((c) =>
      c.getAttribute("stroke"),
    );
    const radius = image
      ? Number(image.getAttribute("width")) / 2
      : Math.min(...stroked.map((c) => Number(c.getAttribute("r"))));
    assert.ok(Number.isFinite(radius), "every node renders a measurable radius");
    out.push({
      x,
      y,
      radius,
      label: labelEl.textContent ?? "",
      labelY: y + Number(labelEl.getAttribute("y")),
      fontSize: Number(labelEl.getAttribute("font-size")),
      orchestrator: image != null,
    });
  }
  return out;
}

/**
 * Label boxes, using a deliberately wider advance (0.62em) than the SVG text
 * engine's average so the boxes are the pessimistic reading; the vertical box is
 * the font's ascent/descent band around the baseline.
 */
function labelBox(n: NodeGeom) {
  const halfWidth = (n.label.length * 0.62 * n.fontSize) / 2;
  return {
    left: n.x - halfWidth,
    right: n.x + halfWidth,
    top: n.labelY - 0.8 * n.fontSize,
    bottom: n.labelY + 0.2 * n.fontSize,
  };
}

function minCircleClearance(nodes: NodeGeom[]): number {
  let min = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius);
    }
  }
  return min;
}

function minLabelCircleClearance(nodes: NodeGeom[]): number {
  let min = Infinity;
  for (const boxed of nodes) {
    const box = labelBox(boxed);
    for (const other of nodes) {
      if (other === boxed) continue;
      const cx = Math.min(Math.max(other.x, box.left), box.right);
      const cy = Math.min(Math.max(other.y, box.top), box.bottom);
      min = Math.min(min, Math.hypot(other.x - cx, other.y - cy) - other.radius);
    }
  }
  return min;
}

function minLabelClearance(nodes: NodeGeom[]): number {
  const boxes = nodes.map(labelBox);
  let min = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const dx = Math.max(a.left - b.right, b.left - a.right);
      const dy = Math.max(a.top - b.bottom, b.top - a.bottom);
      min = Math.min(min, Math.max(dx, dy));
    }
  }
  return min;
}

/**
 * Thresholds carry ~2x headroom on the measured geometry of the real topology
 * (idle: circle 40.6px, label/circle 16.9px, label/label 19.5px; live frame 0:
 * 56.0 / 31.4 / 25.8). Pre-fix, an idle graph painted the raw seed layout, whose
 * min circle clearance is −30.6px — every assertion below fails.
 */
const MIN_CIRCLE_CLEARANCE = 16;
const MIN_LABEL_CIRCLE_CLEARANCE = 8;
const MIN_LABEL_CLEARANCE = 8;

function assertNoOverlap(nodes: NodeGeom[], context: string) {
  assert.ok(nodes.length >= 12, `${context}: the crowded topology must be on screen (got ${nodes.length})`);
  const radii = new Set(nodes.map((n) => n.radius));
  assert.ok(radii.size > 1, `${context}: agents and tool satellites must both be present`);

  const circle = minCircleClearance(nodes);
  const labelCircle = minLabelCircleClearance(nodes);
  const labelLabel = minLabelClearance(nodes);
  assert.ok(
    circle >= MIN_CIRCLE_CLEARANCE,
    `${context}: node circles must not overlap (min clearance ${circle.toFixed(1)}px)`,
  );
  assert.ok(
    labelCircle >= MIN_LABEL_CIRCLE_CLEARANCE,
    `${context}: no label may run into another node's circle (min ${labelCircle.toFixed(1)}px)`,
  );
  assert.ok(
    labelLabel >= MIN_LABEL_CLEARANCE,
    `${context}: no two labels may overlap (min ${labelLabel.toFixed(1)}px)`,
  );
}

function flush(ms = 0): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function mountCanvas(running: boolean, events: SubagentCustomEvent[]) {
  const { AgentGraphCanvas } = await loadCanvas();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = async (isRunning: boolean, nextEvents: SubagentCustomEvent[]) => {
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
            isRunning,
            activeRunId: isRunning ? "run-1" : null,
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

  await render(running, events);

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

test("an idle graph paints a spread-out layout, never the raw overlapping seed", async () => {
  const idle = await mountCanvas(false, FULL_STREAM);
  try {
    const nodes = parseNodes(idle.container);
    assertNoOverlap(nodes, "idle");

    // The settle must not walk a pinned node off its anchor: the orchestrator is
    // pinned at the seed centre ("Decepticon at center"), and the neighbours it
    // has to clear are the ones that move.
    const orchestrator = nodes.find((n) => n.orchestrator);
    assert.ok(orchestrator, "the orchestrator must be on screen at the centre");
    assert.ok(
      Math.hypot(orchestrator.x, orchestrator.y) < 1,
      `the pinned orchestrator must stay at the seed centre (drifted to ${orchestrator.x.toFixed(1)}, ${orchestrator.y.toFixed(1)})`,
    );
  } finally {
    await idle.unmount();
  }
});

test("the first live frame is already spread out", async () => {
  const live = await mountCanvas(true, FULL_STREAM);
  try {
    assertNoOverlap(parseNodes(live.container), "live frame 0");

    // And it stays spread once the ambient loop has been running for a while.
    await act(() => flush(400));
    assertNoOverlap(parseNodes(live.container), "live +400ms");
  } finally {
    await live.unmount();
  }
});

test("hiding the document freezes spread-out geometry", async () => {
  const page = await mountCanvas(true, FULL_STREAM);
  const documentWithVisibility = document as Document & { visibilityState: DocumentVisibilityState };
  const prior = Object.getOwnPropertyDescriptor(documentWithVisibility, "visibilityState");
  try {
    Object.defineProperty(documentWithVisibility, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await act(() => flush(120));

    assertNoOverlap(parseNodes(page.container), "hidden");
  } finally {
    if (prior) Object.defineProperty(documentWithVisibility, "visibilityState", prior);
    else Reflect.deleteProperty(documentWithVisibility, "visibilityState");
    await page.unmount();
  }
});

test("pan/zoom changes the view transform, never the node geometry", async () => {
  // Resize and fit are pure view operations: the settle owns the graph-space
  // layout, so a transform change must not move a node (and must not re-settle).
  const page = await mountCanvas(false, FULL_STREAM);
  try {
    const svg = page.container.querySelector("svg.agent-graph-canvas");
    assert.ok(svg, "the canvas must render its svg");
    const before = parseNodes(page.container);

    const layer = svg.querySelector("g[transform]");
    assert.ok(layer);
    const transformBefore = layer.getAttribute("transform");

    await act(async () => {
      svg.dispatchEvent(
        new window.WheelEvent("wheel", {
          deltaY: -100,
          clientX: 100,
          clientY: 100,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    assert.notEqual(
      layer.getAttribute("transform"),
      transformBefore,
      "the wheel handler must zoom the view (it is registered non-passive)",
    );
    assert.deepEqual(
      parseNodes(page.container),
      before,
      "zooming must not move a single node in graph space",
    );
  } finally {
    await page.unmount();
  }
});

test("topology arriving while idle is placed without overlapping", async () => {
  const page = await mountCanvas(false, SPARSE_STREAM);
  try {
    assertNoOverlap(parseNodes(page.container), "idle, sparse");

    // A whole run's worth of satellites lands in one update while the graph is
    // static: the new nodes must be placed, not stacked on their parents.
    await page.render(false, FULL_STREAM);
    assertNoOverlap(parseNodes(page.container), "idle, after topology change");
  } finally {
    await page.unmount();
  }
});
