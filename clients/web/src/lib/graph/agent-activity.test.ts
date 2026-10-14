/**
 * `deriveAgentActivity` — the event→graph mapping that decides which nodes are
 * "live".
 *
 * Two properties matter for render cost, and both are asserted here:
 *
 *  1. `activeRun === false` must leave nothing in an animated state. The
 *     orchestrator and every unfinished tool satellite otherwise stayed in
 *     `processing` forever, which kept the infinite ring animations (and the
 *     active-edge dot flow) running on a graph where nothing was happening.
 *     Waiting states are deliberately *not* gated: an interrupted run that is
 *     waiting for operator approval is a real state.
 *  2. A node whose visible fields are unchanged must come back as the *same
 *     object*, so the memoized canvas components skip it. The event log grows
 *     by one entry per streamed token/event, so without identity reuse every
 *     new event rebuilt the whole graph.
 *
 * It is a pure function (no hooks), which is exactly why the mapping is
 * testable in isolation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "@/lib/agents";
import type { SubagentCustomEvent } from "@decepticon/streaming";
import { deriveAgentActivity } from "@/hooks/useAgentActivity";
import type { GraphNode } from "@/lib/graph/types";

const AGENTS: AgentConfig[] = [
  { id: "decepticon", name: "Decepticon", role: "orchestrator", color: "#22d3ee", description: "" },
  { id: "recon", name: "Recon", role: "worker", color: "#a855f7", description: "" },
];

const STREAM: SubagentCustomEvent[] = [
  { type: "subagent_start", agent: "recon" },
  { type: "subagent_tool_call", agent: "recon", tool: "nmap_scan" },
];

function nodeById(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

test("an idle graph has no live state at all", () => {
  const { nodes, edges } = deriveAgentActivity(AGENTS, [], false);

  for (const node of nodes) {
    assert.notEqual(node.runtimeState, "processing", `${node.id} must not stay processing`);
    assert.notEqual(node.runtimeState, "waiting_for_permission");
    assert.notEqual(node.runtimeState, "waiting_for_user");
  }
  assert.equal(edges.some((edge) => edge.active), false, "no edge may stay active");
});

test("a finished run freezes processing nodes but keeps a waiting one", () => {
  const events: SubagentCustomEvent[] = [
    { type: "subagent_start", agent: "recon" },
    { type: "ask_user_question", agent: "recon", question: "proceed?" },
  ];

  const live = deriveAgentActivity(AGENTS, events, true);
  assert.ok(live.edges.every((edge) => edge.active), "a live run animates its edges");

  const idle = deriveAgentActivity(AGENTS, events, false);
  const waiting = nodeById(idle.nodes).get("recon");
  assert.equal(waiting?.runtimeState, "waiting_for_user", "waiting survives the run ending");
  assert.ok(idle.edges.some((edge) => edge.active), "the waiting edge stays highlighted");

  const orchestrator = nodeById(idle.nodes).get("decepticon");
  assert.equal(orchestrator?.runtimeState, "idle", "the orchestrator stops processing");
});

test("a settled tool satellite stops being a live node", () => {
  const pending: SubagentCustomEvent[] = [{ type: "subagent_tool_call", agent: "recon", tool: "nmap_scan" }];
  const settled: SubagentCustomEvent[] = [
    ...pending,
    { type: "subagent_tool_result", agent: "recon", tool: "nmap_scan" },
  ];
  const satelliteId = "tool-recon-nmap_scan";

  // A tool that has returned is not live, even while the run continues.
  const running = nodeById(deriveAgentActivity(AGENTS, pending, true).nodes);
  assert.equal(running.get(satelliteId)?.type, "tool-session");
  assert.equal(running.get(satelliteId)?.runtimeState, "processing");

  const done = nodeById(deriveAgentActivity(AGENTS, settled, true).nodes);
  assert.equal(done.get(satelliteId)?.type, "completed-session");
  assert.equal(done.get(satelliteId)?.runtimeState, "completed");

  // And it stays settled once the run ends.
  const stopped = nodeById(deriveAgentActivity(AGENTS, settled, false).nodes);
  assert.equal(stopped.get(satelliteId)?.type, "completed-session");
});

test("an unchanged node keeps its object identity across event batches", () => {
  let previous = deriveAgentActivity(AGENTS, [], true).nodeById;

  // The stream grows one event at a time; the first event only touches `recon`.
  for (const event of STREAM) {
    const next = deriveAgentActivity(AGENTS, [event], true, previous);
    const before = previous.get("decepticon");
    const after = next.nodeById.get("decepticon");
    assert.equal(after, before, "untouched nodes must be reused, not rebuilt");
    previous = next.nodeById;
  }
});

test("a changed node gets a fresh object", () => {
  const before = deriveAgentActivity(AGENTS, [], true).nodeById;
  assert.equal(before.get("recon")?.runtimeState, "idle");

  const after = deriveAgentActivity(AGENTS, STREAM, true, before).nodeById;
  assert.notEqual(after.get("recon"), before.get("recon"), "a state change must re-render");
  assert.equal(after.get("recon")?.runtimeState, "processing");
});

test("tool satellites are capped per agent and reused while unchanged", () => {
  const events: SubagentCustomEvent[] = Array.from({ length: 8 }, (_, i) => ({
    type: "subagent_tool_call" as const,
    agent: "recon",
    tool: `tool_${i}`,
  }));

  const first = deriveAgentActivity(AGENTS, events, true);
  const satelliteIds = first.nodes.filter((node) => node.parentAgentId === "recon").map((node) => node.id);
  assert.equal(satelliteIds.length, 5, "only the 5 most recent calls get a node");

  const second = deriveAgentActivity(AGENTS, [...events, { type: "subagent_message", agent: "recon" }], true, first.nodeById);
  for (const id of satelliteIds) {
    assert.equal(second.nodeById.get(id), first.nodeById.get(id), `${id} must be reused`);
  }
});
