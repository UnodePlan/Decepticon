"use client";

/**
 * useAgentActivity — maps SubagentCustomEvent[] to graph nodes/edges.
 *
 * Uses @decepticon/streaming types directly — no regex parsing.
 * Same event types that the CLI processes, rendered as a graph instead of text.
 *
 * Two properties exist for render cost, not just correctness:
 *
 *  1. Node objects are reconciled against the previous output, so an event that
 *     does not change a node's visible fields reuses the same object identity.
 *     The canvas renders memoized nodes/edges, so an event batch only re-renders
 *     the nodes it actually changed instead of the whole graph.
 *  2. `activeRun` gates every "live" state. Without it the orchestrator — and
 *     every unfinished tool satellite — stayed in `processing` forever, which
 *     kept the infinite activity animations running on a graph where nothing is
 *     happening.
 *
 * Waiting states are deliberately NOT gated: an interrupted run that is waiting
 * for operator approval has `activeRun === false` but is still a real state.
 */

import { useMemo, useRef } from "react";
import type { AgentConfig } from "@/lib/agents";
import type { SubagentCustomEvent } from "@decepticon/streaming";
import type { GraphNode, GraphEdge, AgentRuntimeState } from "@/lib/graph/types";
import { isWaitingState } from "@/lib/graph/types";

const ORCHESTRATOR_RADIUS = 36;
const AGENT_RADIUS = 24;
const TOOL_SESSION_RADIUS = 10;
const AGENT_RING_RADIUS = 160;
const SESSION_RING_RADIUS = 60;
/** One node per unique tool name per agent; keep only the most recent ones. */
const MAX_SESSIONS_PER_AGENT = 5;

interface ToolSession {
  id: string;
  agentId: string;
  toolName: string;
  done: boolean;
}

interface UseAgentActivityOptions {
  agents: AgentConfig[];
  events: SubagentCustomEvent[];
  /** True while a LangGraph run is active. Gates all live (animated) states. */
  activeRun: boolean;
}

interface UseAgentActivityReturn {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * True when a re-derived node would render exactly like the previous one, so the
 * cached object can be reused and the memoized node component can skip.
 */
function sameNode(prev: GraphNode, next: GraphNode): boolean {
  return (
    prev.type === next.type &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.pinned === next.pinned &&
    prev.radius === next.radius &&
    prev.agentId === next.agentId &&
    prev.label === next.label &&
    prev.color === next.color &&
    prev.runtimeState === next.runtimeState &&
    prev.role === next.role &&
    prev.waitingToolName === next.waitingToolName &&
    prev.parentAgentId === next.parentAgentId
  );
}

export function useAgentActivity({
  agents,
  events,
  activeRun,
}: UseAgentActivityOptions): UseAgentActivityReturn {
  const nodeCacheRef = useRef<Map<string, GraphNode>>(new Map());

  return useMemo(() => {
    const { nodes, edges, nodeById } = deriveAgentActivity(
      agents,
      events,
      activeRun,
      nodeCacheRef.current,
    );
    nodeCacheRef.current = nodeById;
    return { nodes, edges };
  }, [agents, events, activeRun]);
}

/**
 * Pure graph derivation — no hooks, so the mapping from streamed events to
 * nodes/edges (including the identity-reuse contract the memoized canvas
 * components depend on) is directly testable.
 *
 * `previousNodes` is the node map returned by the previous call; a node whose
 * visible fields are unchanged comes back as the *same object*.
 */
export function deriveAgentActivity(
  agents: AgentConfig[],
  events: SubagentCustomEvent[],
  activeRun: boolean,
  previousNodes?: Map<string, GraphNode>,
): { nodes: GraphNode[]; edges: GraphEdge[]; nodeById: Map<string, GraphNode> } {
  const agentStates = new Map<string, AgentRuntimeState>();
  const agentToolNames = new Map<string, string>();
  const toolSessionMap = new Map<string, ToolSession>();

  for (const event of events) {
    switch (event.type) {
      case "subagent_start":
        agentStates.set(event.agent, "processing");
        break;

      case "subagent_end":
        agentStates.set(event.agent, "completed");
        break;

      case "subagent_tool_call": {
        agentStates.set(event.agent, "processing");
        if (event.tool) {
          agentToolNames.set(event.agent, event.tool);
          // One node per unique tool name per agent — no duplicates
          const sessionId = `tool-${event.agent}-${event.tool}`;
          toolSessionMap.set(sessionId, {
            id: sessionId,
            agentId: event.agent,
            toolName: event.tool,
            done: false,
          });
        }
        break;
      }

      case "subagent_tool_result": {
        if (event.tool) {
          const sessionId = `tool-${event.agent}-${event.tool}`;
          const session = toolSessionMap.get(sessionId);
          if (session) session.done = true;
        }
        break;
      }

      case "ask_user_question": {
        agentStates.set(event.agent, "waiting_for_user");
        break;
      }
    }
  }

  // A finished run leaves nothing in `processing` — freeze those states so the
  // activity animations stop. Waiting states survive (see file header).
  if (!activeRun) {
    for (const [agentId, state] of agentStates) {
      if (state === "processing") agentStates.set(agentId, "completed");
    }
  }

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  // Reuse the previous pass's object whenever nothing visible changed.
  const nextNodes = new Map<string, GraphNode>();
  const stable = (node: GraphNode): GraphNode => {
    const previous = previousNodes?.get(node.id);
    const value = previous && sameNode(previous, node) ? previous : node;
    nextNodes.set(node.id, value);
    return value;
  };

  // Show all agents — idle ones are dimmed, active ones pulse
  const nodes: GraphNode[] = [];
  const agentPositions = new Map<string, { x: number; y: number }>();
  const ringCount = agents.filter((a) => a.id !== "decepticon").length;
  const angleStep = (2 * Math.PI) / Math.max(ringCount, 1);

  let angleIdx = 0;
  for (const agent of agents) {
    const isOrch = agent.id === "decepticon";
    const runtimeState: AgentRuntimeState =
      agentStates.get(agent.id) ?? (isOrch && activeRun ? "processing" : "idle");
    const radius = isOrch ? ORCHESTRATOR_RADIUS : AGENT_RADIUS;
    const angle = angleStep * angleIdx;
    const x = isOrch ? 0 : Math.cos(angle) * AGENT_RING_RADIUS;
    const y = isOrch ? 0 : Math.sin(angle) * AGENT_RING_RADIUS;
    if (!isOrch) angleIdx++;

    agentPositions.set(agent.id, { x, y });

    nodes.push(
      stable({
        id: agent.id,
        type: isOrch ? "orchestrator" : "agent",
        x,
        y,
        vx: 0,
        vy: 0,
        pinned: isOrch,
        radius,
        agentId: agent.id,
        label: agent.name,
        color: agent.color,
        runtimeState,
        role: agent.role,
        waitingToolName: agentToolNames.get(agent.id),
      }),
    );
  }

  // Build tool session satellite nodes (last 5 per agent)
  const sessionsByAgent = new Map<string, ToolSession[]>();
  for (const session of toolSessionMap.values()) {
    const list = sessionsByAgent.get(session.agentId) ?? [];
    list.push(session);
    sessionsByAgent.set(session.agentId, list);
  }

  for (const [agentId, sessions] of sessionsByAgent) {
    const parentPos = agentPositions.get(agentId);
    if (!parentPos) continue;

    const color = agentsById.get(agentId)?.color ?? "#6b7280";
    const recentSessions = sessions.slice(-MAX_SESSIONS_PER_AGENT);
    const sessionAngleStep = (2 * Math.PI) / Math.max(recentSessions.length, 1);

    for (let i = 0; i < recentSessions.length; i++) {
      const session = recentSessions[i];
      const live = activeRun && !session.done;
      const angle = sessionAngleStep * i - Math.PI / 2;

      nodes.push(
        stable({
          id: session.id,
          type: live ? "tool-session" : "completed-session",
          x: parentPos.x + Math.cos(angle) * SESSION_RING_RADIUS,
          y: parentPos.y + Math.sin(angle) * SESSION_RING_RADIUS,
          vx: 0,
          vy: 0,
          pinned: false,
          radius: TOOL_SESSION_RADIUS,
          agentId: session.agentId,
          label: session.toolName,
          color,
          runtimeState: live ? "processing" : "completed",
          role: "tool",
          parentAgentId: agentId,
        }),
      );
    }
  }

  // Build edges
  const edges: GraphEdge[] = [];

  for (const [agentId, state] of agentStates) {
    if (agentId === "decepticon") continue;
    edges.push({
      source: "decepticon",
      target: agentId,
      active: state === "processing" || isWaitingState(state),
    });
  }

  for (const node of nodes) {
    if ((node.type === "tool-session" || node.type === "completed-session") && node.parentAgentId) {
      edges.push({
        source: node.parentAgentId,
        target: node.id,
        active: node.type === "tool-session",
      });
    }
  }

  return { nodes, edges, nodeById: nextNodes };
}
