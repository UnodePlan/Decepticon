"use client";

/**
 * GraphEdgeComponent — SVG edge with octogent-style activity dots.
 *
 * Active edges show 3 staggered dot pairs flowing along a Bezier path:
 * - Trail dots: coloured halo behind the core
 * - Core dots: bright cream (#fff4cc) with colored border
 * - Stagger: 0.62s between each dot pair
 * - Duration: 1.9s per traversal
 *
 * The dots follow the path with SMIL `<animateMotion>`, which means the browser
 * re-rasterizes them every frame for as long as the edge is active. They
 * therefore carry no `filter` (a blur + drop-shadow chain here used to run a
 * full Gaussian pass per dot per frame) and the trail's soft edge is faked with
 * a larger radius at low opacity instead.
 *
 * Memoized: an edge is re-rendered per simulation tick and per streamed event,
 * but its appearance is fully described by its primitive props.
 */

import { memo } from "react";

const DOT_INDICES = [0, 1, 2] as const;
const DURATION = 1.9;
const STAGGER = 0.62;

interface GraphEdgeProps {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  active: boolean;
  color: string;
  edgeId: string;
  sourceRadius?: number;
  targetRadius?: number;
}

function GraphEdgeComponentImpl({
  sourceX,
  sourceY,
  targetX,
  targetY,
  active,
  color,
  edgeId,
  sourceRadius = 36,
  targetRadius = 24,
}: GraphEdgeProps) {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;

  const nx = dx / dist;
  const ny = dy / dist;
  const sx = sourceX + nx * (sourceRadius + 6);
  const sy = sourceY + ny * (sourceRadius + 6);
  const tx = targetX - nx * (targetRadius + 6);
  const ty = targetY - ny * (targetRadius + 6);

  const offset = Math.max(16, Math.min(32, dist * 0.16));
  const mx = (sx + tx) / 2 - (ty - sy) / dist * offset;
  const my = (sy + ty) / 2 + (tx - sx) / dist * offset;
  const pathD = `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`;
  const pathId = `edge-path-${edgeId}`;

  return (
    <g>
      <path
        id={pathId}
        d={pathD}
        fill="none"
        stroke={active ? color : "#374151"}
        strokeWidth={active ? 2 : 1}
        opacity={active ? 0.5 : 0.15}
        strokeDasharray={active ? "none" : "4 4"}
      />

      {active && DOT_INDICES.map((i) => {
        const begin = `${i * STAGGER}s`;
        const coreOpacity = [1.0, 0.92, 0.84][i];

        return (
          <g key={i}>
            <circle
              r={3.8}
              fill={color}
              opacity={0.35}
              className="canvas-edge-dot-trail"
            >
              <animateMotion dur={`${DURATION}s`} repeatCount="indefinite" begin={begin}>
                <mpath href={`#${pathId}`} />
              </animateMotion>
              <animate
                attributeName="r"
                values="3.8;5.2;3.8"
                dur={`${DURATION}s`}
                repeatCount="indefinite"
                begin={begin}
              />
            </circle>

            <circle
              r={2.8}
              fill="#fff4cc"
              stroke={color}
              strokeWidth={1.2}
              opacity={coreOpacity}
              className="canvas-edge-dot-core"
            >
              <animateMotion dur={`${DURATION}s`} repeatCount="indefinite" begin={begin}>
                <mpath href={`#${pathId}`} />
              </animateMotion>
              <animate
                attributeName="r"
                values="2.8;3.8;2.8"
                dur={`${DURATION}s`}
                repeatCount="indefinite"
                begin={begin}
              />
            </circle>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Memoized wrapper. Every prop is a primitive, so a shallow compare is exact:
 * an edge re-renders only when one of its endpoints actually moved.
 */
export const GraphEdgeComponent = memo(function GraphEdgeComponent(props: GraphEdgeProps) {
  return GraphEdgeComponentImpl(props);
});
