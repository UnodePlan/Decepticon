"use client";

/**
 * useForceSimulation — d3-force physics layout for the agent graph.
 *
 * Runs a force simulation with repulsion, linking, centering, and collision
 * avoidance. Returns a snapshot of node positions on each tick so React
 * can re-render the SVG.
 *
 * ## Why there is an offline settle
 *
 * d3-force only separates overlapping nodes by *stepping* the simulation, and
 * the seed layout `useAgentActivity` produces is a hard overlap: agents sit on a
 * 160px ring (their 24px circles clear each other, their labels do not) and each
 * agent's 60px satellite ring puts tool nodes right on top of the agent and its
 * neighbours. Measured on the real 17-agent topology (97 rendered nodes): min
 * circle clearance −30.6px and label/circle overlaps everywhere.
 *
 * Previously only a *live* graph ever resolved that, over ~340 timer frames, so
 * an idle/hidden/finished graph — which by design never ticks — painted the raw,
 * overlapping seed layout and stayed that way. That is the reported regression:
 * an initial (idle) render with "大量节点与标签重叠" that never spreads out.
 *
 * So every (re)build now runs a **bounded, synchronous settle** before the first
 * paint: `sim.tick()` in a loop, with no timer and no animation frame, until no
 * two rendered footprints (circle + label box) are closer than
 * {@link SETTLE_MIN_GAP}, capped at {@link SETTLE_MAX_TICKS}. Measured cost on
 * the real topologies: 81 ticks / 40ms for 97 nodes, 148 ticks / 114ms for 163
 * nodes (a list with marketplace agents). A rebuild only happens when the node
 * *ids* change — a tool name an agent has not called before, capped at the five
 * most recent per agent by `useAgentActivity` — not per streamed event, and such
 * a churn re-settle measures 66–185 ticks / 25–64ms. The layout is then published
 * once, so the first paint is already collision-free.
 *
 * The live loop is *not* restarted at d3's default alpha 1 — that re-flings a
 * settled layout (measured −19.3px footprint gap at 97 nodes and −52.6px at 187
 * nodes, and every streamed topology change replayed it). {@link LIVE_ALPHA}
 * keeps the ambient drift while holding the separation at both sizes.
 * `running: false` still means "no timer at all": the settle is finite and
 * synchronous, so a paused graph pays no frames.
 */

import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { GraphNode, GraphEdge } from "@/lib/graph/types";

/**
 * Clear space demanded between any two rendered footprints (circle + label box)
 * before the layout is published. 8px is one gutter of visual air at the fit
 * scale; the settled layout of the real 97-node topology measures 41px
 * circle-to-circle, 17px label-to-circle and 20px label-to-label, parsed out of
 * the rendered SVG by `canvas-geometry.test.tsx`.
 */
const SETTLE_MIN_GAP = 8;

/**
 * Tick budget for the offline settle. Measured on the real seed layouts: 81 ticks
 * / 40ms for 97 nodes (17 agents), 148 ticks / 114ms for 163 nodes (28 agents, a
 * builtin list plus marketplace agents). Past this the layout is published as-is
 * and, on a live graph, the ambient loop keeps working on it. A cap can only
 * under-spread a pathological shape, never deadlock the paint.
 */
const SETTLE_MAX_TICKS = 240;

/**
 * Alpha the ambient (live) loop restarts at. Bounded so a settled layout keeps
 * its separation while still drifting. Measured worst painted footprint gap over
 * the whole transient (the settle runs first, then this loop restarts):
 *
 *   topologies    alpha 0.1        alpha 0.04     d3 default 1.0
 *   97 nodes      +10.6px / 228f   +11.2px / 183f −19.3px / 342f
 *   187 nodes      −7.8px / 228f    +4.5px / 183f −52.6px / 342f
 *
 * (`f` = frames until d3 decays alpha below alphaMin and stops on its own, so
 * this remains bounded work per rebuild.) 0.1 still lets a marketplace-sized
 * topology brush through itself mid-transient, so the loop restarts at 0.04:
 * the separation holds at both sizes, the nodes still travel far enough for the
 * layout to read as live (57–65px over the transient), and 183 frames is still
 * ~3s of animation per topology change.
 */
const LIVE_ALPHA = 0.04;

/**
 * Smallest Chebyshev separation between any two *rendered footprints*; `> 0`
 * means nothing overlaps, `Infinity` for fewer than two nodes.
 *
 * A node is not just a circle: `AgentNode`/`SessionNode` draw the node's name
 * below it, and that label box is what visibly collides first — the reported
 * symptom was a real-time agent ring graph with 大量节点与标签重叠 (many nodes and
 * labels overlapping). Judging the layout on circles alone would let two 24px
 * discs clear each other while their labels run through the next node.
 *
 * The footprint is the box `[x ± halfWidth] × [y - radius, y + radius + 20]`,
 * which is symmetric about `y + 10`, so `|Δy|` against the sum of the half
 * heights compares the boxes exactly. `fx`/`fy` (a pin or drag) win over `x`/`y`
 * because that is the position `publishPositions` renders. Both node kinds use
 * the agent label metrics (11px, 0.6em advance); the 9px satellite labels are
 * therefore over-estimated, which errs towards more separation, never less.
 *
 * Two *pinned* nodes are skipped: a pin is an anchor the user placed (or the
 * orchestrator's seed centre) and the settle may not move it, so a pair of them
 * is unresolvable by construction — counting it would burn the whole tick budget
 * on every rebuild without changing a pixel.
 */
function minFootprintGap(nodes: readonly ForceNode[]): number {
  let min = Infinity;
  const halfWidth = (n: ForceNode) => Math.max(n.radius, (n.label.length * 0.6 * 11) / 2);
  const halfHeight = (n: ForceNode) => n.radius + 10;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.pinned && b.pinned) continue;
      const dx = Math.abs((a.fx ?? a.x ?? 0) - (b.fx ?? b.x ?? 0)) - halfWidth(a) - halfWidth(b);
      const dy = Math.abs((a.fy ?? a.y ?? 0) - (b.fy ?? b.y ?? 0)) - halfHeight(a) - halfHeight(b);
      const gap = Math.max(dx, dy);
      if (gap < min) min = gap;
    }
  }
  return min;
}

interface ForceNode extends SimulationNodeDatum {
  id: string;
  label: string;
  radius: number;
  pinned: boolean;
}

interface ForceParams {
  repelStrength: number;
  repelDistanceMax: number;
  linkDistance: number;
  linkStrength: number;
  positionStrength: number;
  collisionPadding: number;
  velocityDecay: number;
  alphaDecay: number;
}

const DEFAULT_FORCE_PARAMS: ForceParams = {
  repelStrength: -350,
  repelDistanceMax: 500,
  linkDistance: 120,
  linkStrength: 0.3,
  positionStrength: 0.05,
  collisionPadding: 40,
  velocityDecay: 0.4,
  alphaDecay: 0.02,
};

interface UseForceSimulationOptions {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Whether the graph is being watched and something is moving. When false the
   * physics loop is torn down entirely: d3-force otherwise keeps stepping until
   * alpha decays below 0.001 (≈300 ticks), and every tick re-renders the whole
   * canvas — an idle or hidden graph should burn zero frames.
   */
  running?: boolean;
  params?: Partial<ForceParams>;
}

interface UseForceSimulationReturn {
  /** Current node positions snapshot (triggers re-render on tick). */
  positions: Map<string, { x: number; y: number }>;
  /** Pin a node at its current position (for dragging). */
  pinNode: (id: string, x: number, y: number) => void;
  /** Unpin a node and let forces resume. */
  unpinNode: (id: string) => void;
  /** Reheat the simulation (e.g. after topology changes). */
  reheat: () => void;
}

export function useForceSimulation({
  nodes,
  edges,
  running = true,
  params: userParams,
}: UseForceSimulationOptions): UseForceSimulationReturn {
  const p = { ...DEFAULT_FORCE_PARAMS, ...userParams };
  const simRef = useRef<Simulation<ForceNode, SimulationLinkDatum<ForceNode>> | null>(null);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  // Preserve positions and pinned state across simulation rebuilds
  const prevPositionsRef = useRef<Map<string, { x: number; y: number; fx: number | null; fy: number | null }>>(new Map());
  const posMapRef = useRef(new Map<string, { x: number; y: number }>());
  const publishRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;

  // Stable keys for topology change detection
  const nodeKey = useMemo(() => nodes.map((n) => n.id).join(","), [nodes]);
  const edgeKey = useMemo(() => edges.map((e) => `${e.source}-${e.target}`).join(","), [edges]);

  // Build / rebuild simulation when topology changes
  useEffect(() => {
    // prevPositionsRef is populated by the PREVIOUS effect's cleanup (see below)
    const forceNodes: ForceNode[] = nodes.map((n) => {
      const prev = prevPositionsRef.current.get(n.id);
      return {
        id: n.id,
        label: n.label,
        x: prev?.x ?? n.x,
        y: prev?.y ?? n.y,
        vx: 0,
        vy: 0,
        radius: n.radius,
        pinned: n.pinned || (prev?.fx != null),
        // Restore pinned position if node was previously pinned
        ...(prev?.fx != null ? { fx: prev.fx, fy: prev.fy } : {}),
      };
    });

    const forceEdges: SimulationLinkDatum<ForceNode>[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
    }));

    const sim = forceSimulation<ForceNode>(forceNodes)
      .force(
        "link",
        forceLink<ForceNode, SimulationLinkDatum<ForceNode>>(forceEdges)
          .id((d) => d.id)
          .distance(p.linkDistance)
          .strength(p.linkStrength),
      )
      .force(
        "charge",
        forceManyBody<ForceNode>()
          .strength(p.repelStrength)
          .distanceMax(p.repelDistanceMax),
      )
      .force("x", forceX<ForceNode>(0).strength(p.positionStrength))
      .force("y", forceY<ForceNode>(0).strength(p.positionStrength))
      .force(
        "collide",
        forceCollide<ForceNode>((d) => d.radius + p.collisionPadding),
      )
      .velocityDecay(p.velocityDecay)
      .alphaDecay(p.alphaDecay);

    // Publish a position snapshot. Called once per simulation tick while the
    // graph is live, and exactly once when it is not (see below) so the static
    // layout still renders.
    //
    // `fx`/`fy` win over `x`/`y`: on a live graph d3 writes the pinned position
    // into `x`/`y` on the next tick, but a paused graph never ticks, so a drag
    // would otherwise not move the node until the loop restarted.
    const publishPositions = () => {
      posMapRef.current.clear();
      for (const n of forceNodes) {
        posMapRef.current.set(n.id, { x: n.fx ?? n.x ?? 0, y: n.fy ?? n.y ?? 0 });
      }
      setPositions(new Map(posMapRef.current));
    };

    sim.on("tick", publishPositions);
    publishRef.current = publishPositions;
    simRef.current = sim;

    // d3 starts a timer on construction; stop it before touching alpha ourselves
    // so no animation frame can tick the simulation mid-settle.
    sim.stop();

    // A pinned node is *rendered* at `fx`/`fy` (see publishPositions), so freeze it
    // there before settling. Otherwise the settle is free to walk a pinned node off
    // its anchor and only then pin it wherever it drifted — and the orchestrator,
    // which is pinned at the seed centre on purpose ("Decepticon at center"),
    // measured 27.8px off centre on the real 97-node topology.
    for (const node of forceNodes) {
      if (node.pinned && node.fx == null) {
        node.fx = node.x;
        node.fy = node.y;
      }
    }

    // Bounded offline settle — the fix for the overlapping first paint. The seed
    // layout (agent ring + satellite rings) overlaps badly, and on an idle/hidden
    // graph nothing else would ever separate it: the timer is off, so the raw
    // seeds were published as-is and stayed that way (measured min circle
    // clearance −30.6px on the real 17-agent / 97-node topology). A finite,
    // synchronous `tick()` loop costs no animation frame and spreads the layout
    // before the first paint. On a re-layout of an already-spread topology the
    // criterion is satisfied immediately, so it exits at 0 ticks and publishes
    // the carried positions unchanged.
    //
    // The gap check is O(n²) and runs between ticks; on the real topologies that
    // is well under a millisecond per check (97 nodes settle in 81 ticks / 40ms,
    // 163 nodes in 148 ticks / 114ms), and it is what makes the cap a *budget*
    // rather than a guess.
    for (let tick = 0; tick < SETTLE_MAX_TICKS; tick++) {
      if (minFootprintGap(forceNodes) >= SETTLE_MIN_GAP) break;
      sim.tick(1);
    }

    // Publish once, whatever the state: a static graph still has to render, and a
    // live one must not paint the raw overlap for a frame first.
    publishPositions();

    if (running) {
      // Keep the ambient drift while the graph is live — but from a bounded alpha.
      // Restarting at d3's default (1) re-flings an already settled layout
      // (measured −19.3px worst footprint gap at 97 nodes, −52.6px at 187 nodes)
      // and every streamed topology change replays that, which reads as the graph
      // never settling. d3 decays LIVE_ALPHA below alphaMin and stops on its own
      // (~183 frames), so this stays finite work per rebuild.
      sim.alpha(LIVE_ALPHA).restart();
    }
    // 关键原因：hidden tab 照样能拿到动画帧，d3-force 会一直跑到 alpha 衰减到下限
    // （默认约 300+ tick），每个 tick 都重渲染整张 SVG；暂停时直接 stop()，上面的有限
    // settle 只做一次同步 tick，不产生任何动画帧。

    return () => {
      // Save positions + pinned state BEFORE destroying — next effect reads prevPositionsRef
      const prev = new Map<string, { x: number; y: number; fx: number | null; fy: number | null }>();
      for (const n of sim.nodes()) {
        prev.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, fx: n.fx ?? null, fy: n.fy ?? null });
      }
      prevPositionsRef.current = prev;
      sim.stop();
      publishRef.current = null;
      simRef.current = null;
    };
    // Re-run when node/edge IDs change (serialized for stable deps), or when
    // the graph starts/stops being live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey, edgeKey, running]);

  const pinNode = useCallback((id: string, x: number, y: number) => {
    const sim = simRef.current;
    if (!sim) return;
    const node = sim.nodes().find((n) => n.id === id);
    if (node) {
      node.fx = x;
      node.fy = y;
      node.pinned = true;
      // Dragging a node is an explicit interaction, so it may reheat even on a
      // paused graph — but only if the graph is live, otherwise the loop would
      // start running behind a static (idle/hidden) canvas.
      if (runningRef.current) sim.alpha(0.3).restart();
      else publishRef.current?.();
    }
  }, []);

  const unpinNode = useCallback((id: string) => {
    const sim = simRef.current;
    if (!sim) return;
    const node = sim.nodes().find((n) => n.id === id);
    if (node) {
      node.fx = null;
      node.fy = null;
      node.pinned = false;
      if (runningRef.current) sim.alpha(0.3).restart();
      else publishRef.current?.();
    }
  }, []);

  const reheat = useCallback(() => {
    if (!runningRef.current) return;
    simRef.current?.alpha(0.5).restart();
  }, []);

  return { positions, pinNode, unpinNode, reheat };
}
