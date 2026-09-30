/**
 * WireRenderer — purely visual renderer for a single wire.
 * All interaction (click/hover/drag) is handled by SimulatorCanvas.
 */

import React from 'react';
import type { Wire } from '../../types/wire';
import { generateOrthogonalPath } from '../../utils/wireUtils';
import { cssVar } from '../../lib/theme';

interface WireRendererProps {
  wire: Wire;
  isSelected: boolean;
  isHovered: boolean;
  /** Temporary waypoints used during drag preview */
  previewWaypoints?: { x: number; y: number }[];
  /** Override the full SVG path string (used during segment drag preview) */
  overridePath?: string;
  /** Pin map emphasis: 'linked' wires touch the mapped part, 'focus' ones the
      pin under the pointer, and every other wire is 'dim'. */
  emphasis?: 'focus' | 'linked' | 'dim';
}

export const WireRenderer: React.FC<WireRendererProps> = ({
  wire,
  isSelected,
  isHovered,
  previewWaypoints,
  overridePath,
  emphasis,
}) => {
  // Breadboard seating wires are pure connectivity — the part visually
  // sits in the holes, so there is nothing to draw.
  if (wire.bb) return null;

  const waypoints = previewWaypoints ?? wire.waypoints;
  const path = overridePath ?? generateOrthogonalPath(wire.start, waypoints, wire.end);

  if (!path) return null;

  const color = wire.color;
  // Wire COLOUR is the user's; the outline, the hover wash and the selection
  // dashes are canvas chrome and follow the theme. On a light canvas the old
  // near-black outline read as a heavy shadow around every run, and the white
  // hover/selection strokes were invisible outright.
  const outline = cssVar('--color-wire-outline');
  const marker = cssVar('--color-wire-marker');
  const lifted = isSelected || emphasis === 'focus' || emphasis === 'linked';
  const strokeW = emphasis === 'focus' ? 3.5 : lifted ? 3 : 2;
  const outlineW = lifted ? 6 : 5;
  const opacity = isSelected || isHovered || lifted ? 1 : 0.95;

  return (
    <g
      style={{ pointerEvents: 'none' }}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={emphasis === 'dim' ? 'wire--pinmap-dim' : undefined}
    >
      {/* Pin map glow in the wire's own color, under everything else */}
      {(emphasis === 'focus' || emphasis === 'linked') && (
        <path
          d={path}
          stroke={color}
          strokeWidth={emphasis === 'focus' ? 13 : 9}
          fill="none"
          opacity={emphasis === 'focus' ? 0.4 : 0.22}
        />
      )}

      {/* Contrast outline, so wires stay readable where they cross */}
      <path d={path} stroke={outline} strokeWidth={outlineW} fill="none" />

      {/* Hover highlight (below wire) */}
      {isHovered && !isSelected && (
        <path d={path} stroke={marker} strokeWidth="6" fill="none" opacity="0.2" />
      )}

      {/* Visible wire */}
      <path d={path} stroke={color} strokeWidth={strokeW} fill="none" opacity={opacity} />

      {/* Selection dashed highlight */}
      {isSelected && (
        <path
          d={path}
          stroke={marker}
          strokeWidth="1.5"
          fill="none"
          strokeDasharray="6,4"
          opacity="0.6"
        />
      )}

      {/* Pin map focus: current flowing along the wire */}
      {emphasis === 'focus' && (
        <path
          className="wire-pinmap-flow"
          d={path}
          stroke={marker}
          strokeWidth="1.5"
          fill="none"
          strokeDasharray="2,8"
          opacity="0.9"
        />
      )}

      {/* Endpoint dots */}
      <circle
        cx={wire.start.x}
        cy={wire.start.y}
        r="3"
        fill={color}
        stroke={outline}
        strokeWidth="1"
      />
      <circle cx={wire.end.x} cy={wire.end.y} r="3" fill={color} stroke={outline} strokeWidth="1" />
      {emphasis === 'focus' && (
        <>
          <circle cx={wire.start.x} cy={wire.start.y} r="6" fill="none" stroke={color} strokeWidth="1.5" />
          <circle cx={wire.end.x} cy={wire.end.y} r="6" fill="none" stroke={color} strokeWidth="1.5" />
        </>
      )}
    </g>
  );
};
