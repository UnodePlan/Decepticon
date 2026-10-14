"use client";

/**
 * SessionNode — small SVG node for tool calls.
 *
 * One node per unique tool name per agent. Active: activity ring.
 * Completed: dimmed, no animation.
 *
 * Memoized for the same reason as `AgentNode`: the canvas re-renders on every
 * simulation tick and every streamed event, and this subtree only depends on
 * four primitives.
 */

import { memo } from "react";
import type { GraphNode } from "@/lib/graph/types";

interface SessionNodeProps {
  node: GraphNode;
  x: number;
  y: number;
}

function SessionNodeComponent({ node, x, y }: SessionNodeProps) {
  const r = node.radius;
  const isActive = node.type === "tool-session";
  const color = isActive ? node.color : "#6b7280";

  return (
    <g transform={`translate(${x}, ${y})`}>
      {isActive && (
        <circle
          r={r + 4}
          fill="none"
          strokeWidth={1.5}
          stroke={color}
          className="canvas-ring canvas-ring-processing"
        />
      )}
      <circle
        r={r}
        fill={`${color}${isActive ? "60" : "30"}`}
        stroke={color}
        strokeWidth={1}
      />

      <text
        y={r + 12}
        textAnchor="middle"
        fill={isActive ? "#d1d5db" : "#6b7280"}
        fontSize={9}
        className="canvas-node-label"
      >
        {node.label}
      </text>
    </g>
  );
}

export const SessionNode = memo(SessionNodeComponent);
