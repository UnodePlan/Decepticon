/**
 * `useForceSimulation` lifecycle.
 *
 * d3-force keeps stepping until alpha decays below alphaMin — about 340 ticks
 * at the default decay — and the canvas re-renders the whole SVG on every one
 * of those ticks. That is correct while a run is being watched and pure waste
 * when it is not (idle graph, hidden tab, finished run), so the hook takes a
 * `running` flag: false stops the timer and publishes the layout exactly once,
 * true resumes it.
 *
 * These cases pin that contract, including the parts that are easy to break:
 * a static graph must still lay out new topology and honour an explicit drag.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useForceSimulation } from "@/hooks/useForceSimulation";
import type { GraphEdge, GraphNode } from "@/lib/graph/types";

function node(id: string, x: number, y: number, pinned = false): GraphNode {
  return {
    id,
    type: "agent",
    x,
    y,
    vx: 0,
    vy: 0,
    pinned,
    radius: 24,
    agentId: id,
    label: id,
    color: "#22d3ee",
    runtimeState: "idle",
    role: "worker",
  };
}

const EDGES: GraphEdge[] = [];

interface Probe {
  /** Total renders of the harness — one per published snapshot. */
  renders: number;
  snapshots: Array<Map<string, { x: number; y: number }>>;
  current: () => Map<string, { x: number; y: number }>;
  api: { pinNode: (id: string, x: number, y: number) => void; reheat: () => void; unpinNode: (id: string) => void };
}

function flush(ms = 0): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function mountProbe(nodes: GraphNode[], running: boolean) {
  const probe: Probe = {
    renders: 0,
    snapshots: [],
    current: () => probe.snapshots[probe.snapshots.length - 1],
    api: { pinNode: () => {}, reheat: () => {}, unpinNode: () => {} },
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness({ nodes, running }: { nodes: GraphNode[]; running: boolean }): ReactNode {
    const api = useForceSimulation({ nodes, edges: EDGES, running });
    probe.renders++;
    probe.snapshots.push(api.positions);
    probe.api = api;
    return null;
  }

  const render = async (nodes: GraphNode[], running: boolean) => {
    await act(async () => {
      root.render(createElement(Harness, { nodes, running }));
    });
    await act(() => flush(0));
  };

  await render(nodes, running);

  return {
    render,
    probe,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Smallest Chebyshev clearance between any two rendered footprints, measured
 * from a published snapshot. Independent of the hook's internal estimate: this
 * is the metric the canvas's own regression test (`canvas-geometry.test.tsx`)
 * parses out of the DOM, in miniature. `> 0` means nothing overlaps.
 */
function minGap(
  snapshot: Map<string, { x: number; y: number }>,
  label: Record<string, string>,
  radius = 24,
): number {
  const ids = [...snapshot.keys()];
  const halfWidth = (id: string) => Math.max(radius, (label[id].length * 0.62 * 11) / 2);
  let min = Infinity;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = snapshot.get(ids[i]);
      const b = snapshot.get(ids[j]);
      if (!a || !b) continue;
      const dx = Math.abs(a.x - b.x) - halfWidth(ids[i]) - halfWidth(ids[j]);
      const dy = Math.abs(a.y - b.y) - (radius + 10) - (radius + 10);
      min = Math.min(min, Math.max(dx, dy));
    }
  }
  return min;
}

test("a crowded static graph is spread out without paying a single frame", async () => {
  // The seed layout is a hard overlap — this is the reported regression: an
  // idle/hidden/finished graph used to paint it as-is and never resolve it.
  const nodes = [
    node("alpha", 0, 0),
    node("bravo", 0, 30),
    node("charlie", 20, 15),
    node("delta", 0, 90),
    node("echo", 30, -70),
  ];
  const { probe, unmount } = await mountProbe(nodes, false);
  try {
    const layout = probe.current();
    assert.equal(layout.size, 5, "every node must be placed");
    const gap = minGap(layout, Object.fromEntries(nodes.map((n) => [n.id, n.label])));
    assert.ok(gap > 0, `a static layout must not overlap (min gap ${gap.toFixed(1)}px)`);

    // The separation must come from the finite offline settle, not from a
    // timer: a paused graph may not start an animation loop to fix itself.
    assert.equal(probe.renders, 2, "mount renders once, then the single static publish");
    await act(() => flush(250));
    assert.equal(probe.renders, 2, "no tick may run behind a static canvas");
  } finally {
    await unmount();
  }
});

test("the first frame of a live graph is already spread out", async () => {
  const nodes = [node("alpha", 0, 0), node("bravo", 0, 30), node("charlie", 20, 15)];
  const { probe, unmount } = await mountProbe(nodes, true);
  try {
    // The earliest snapshot holding every node is the publish the rebuild makes
    // *before* restarting the loop, i.e. what the first paint shows.
    const first = probe.snapshots.find((s) => s.size === 3);
    assert.ok(first, "the live graph must publish a layout immediately");
    const label = Object.fromEntries(nodes.map((n) => [n.id, n.label]));
    const gap = minGap(first, label);
    assert.ok(gap > 0, `the first live paint must not overlap (min gap ${gap.toFixed(1)}px)`);
  } finally {
    await unmount();
  }
});

test("a live graph keeps stepping, moving the layout over time", async () => {
  const nodes = [node("a", 0, 0), node("b", 60, 20), node("c", -60, 20)];
  const { probe, unmount } = await mountProbe(nodes, true);
  try {
    // d3-force schedules ticks on animation frames, so the first snapshot lands
    // a frame after mount.
    await act(() => flush(50));

    assert.equal(probe.current().size, 3, "every node gets a position");
    const first = probe.current();

    await act(() => flush(200));

    const moved = ["a", "b", "c"].some((id) => {
      const before = first.get(id);
      const after = probe.current().get(id);
      return before && after && (before.x !== after.x || before.y !== after.y);
    });
    assert.ok(moved, "a live graph must keep moving nodes");
  } finally {
    await unmount();
  }
});

test("a paused graph publishes its layout once and then stops ticking", async () => {
  const nodes = [node("a", 0, 0), node("b", 60, 20)];
  const { probe, unmount } = await mountProbe(nodes, false);
  try {
    assert.equal(probe.current().size, 2, "the static layout must render every node without a tick");
    assert.equal(probe.renders, 2, "mount renders once, then the single static publish");

    const rendersAtPause = probe.renders;
    const layoutAtPause = probe.current();
    await act(() => flush(250));

    assert.equal(probe.renders, rendersAtPause, "no tick may re-render a paused graph");
    assert.equal(probe.current(), layoutAtPause, "the layout must not be re-published");
  } finally {
    await unmount();
  }
});

test("resuming a paused graph restarts the physics from the frozen layout", async () => {
  const nodes = [node("a", 0, 0), node("b", 60, 20)];
  const { render, probe, unmount } = await mountProbe(nodes, false);
  try {
    const frozen = probe.current();
    assert.equal(frozen.size, 2);

    await render(nodes, true);
    const resumed = probe.current();
    await act(() => flush(200));

    const moved = ["a", "b"].some((id) => {
      const before = resumed.get(id);
      const after = probe.current().get(id);
      return before && after && (before.x !== after.x || before.y !== after.y);
    });
    assert.ok(moved, "resuming must restart the physics");
    assert.deepEqual([...probe.current().keys()].sort(), ["a", "b"]);
  } finally {
    await unmount();
  }
});

test("resuming a spread layout paints it unchanged before the loop moves it", async () => {
  // Resuming must not re-fling a settled layout. d3's default restart alpha (1)
  // does exactly that — measured 23.7px of drift within one frame and 66.5px
  // after 400ms on a four-node shape — and every streamed topology change
  // replayed it live, which reads as a graph that never settles.
  const nodes = [node("a", 0, 0), node("b", 60, 20), node("c", -60, 20), node("d", 0, 90)];
  const { render, probe, unmount } = await mountProbe(nodes, false);
  try {
    const frozen = probe.current();
    assert.equal(frozen.size, 4);

    const before = probe.snapshots.length;
    await render(nodes, true);

    // The publish that accompanies the resume — the very first frame the user
    // sees after the graph becomes live again — is the frozen layout itself.
    const firstPublished = probe.snapshots[before];
    assert.ok(firstPublished, "resuming must publish before the loop ticks");
    for (const [id, pos] of frozen) {
      assert.deepEqual(firstPublished.get(id), pos, `${id} must keep its settled position on resume`);
    }
  } finally {
    await unmount();
  }
});

test("pausing keeps node positions: the layout does not re-scatter", async () => {
  const nodes = [node("a", 0, 0), node("b", 60, 20)];
  const { render, probe, unmount } = await mountProbe(nodes, true);
  try {
    await act(() => flush(150));
    const live = probe.current();
    const a = live.get("a");

    await render(nodes, false);
    const paused = probe.current();
    assert.equal(paused.get("a")?.x, a?.x, "pausing must not move the layout");
    assert.equal(paused.get("a")?.y, a?.y);
  } finally {
    await unmount();
  }
});

test("a new node still lays out while the graph is paused", async () => {
  const nodes = [node("a", 0, 0)];
  const { render, probe, unmount } = await mountProbe(nodes, false);
  try {
    assert.equal(probe.current().has("b"), false);

    await render([...nodes, node("b", 120, 0)], false);

    const layout = probe.current();
    assert.equal(layout.size, 2, "topology arriving while static must render");
    assert.ok(layout.has("b"), "the new node must have a position");

    const rendersAfterTopology = probe.renders;
    await act(() => flush(250));
    assert.equal(probe.renders, rendersAfterTopology, "and no physics loop may start");
  } finally {
    await unmount();
  }
});

test("an explicit drag updates a pinned node but cannot restart a paused loop", async () => {
  const nodes = [node("a", 0, 0), node("b", 60, 20)];
  const { probe, unmount } = await mountProbe(nodes, false);
  try {
    await act(async () => {
      probe.api.pinNode("a", 500, 400);
    });

    assert.equal(probe.current().get("a")?.x, 500, "the drag must be visible immediately");
    assert.equal(probe.current().get("a")?.y, 400);

    const rendersAfterDrag = probe.renders;
    await act(() => flush(250));
    assert.equal(probe.renders, rendersAfterDrag, "a drag must not leave the ticker running");

    // The pinned position must survive a subsequent static publish (topology
    // churn while idle) instead of snapping back to the pre-drag coordinate.
    await act(async () => {
      probe.api.reheat();
    });
    assert.equal(probe.current().get("a")?.x, 500, "reheat is a no-op while paused");
    await act(() => flush(250));
    assert.equal(probe.renders, rendersAfterDrag, "reheat must not start the loop");
  } finally {
    await unmount();
  }
});

test("a pinned node keeps its dragged position across a static re-layout", async () => {
  const nodes = [node("a", 0, 0), node("b", 60, 20)];
  const { render, probe, unmount } = await mountProbe(nodes, false);
  try {
    await act(async () => {
      probe.api.pinNode("a", 500, 400);
    });

    await render([...nodes, node("c", -120, 0)], false);

    assert.equal(probe.current().get("a")?.x, 500, "re-layout must not drop the pin");
    assert.equal(probe.current().get("a")?.y, 400);
    assert.ok(probe.current().has("c"));
  } finally {
    await unmount();
  }
});
