/**
 * The keybordy mark as a die-cut vinyl sticker: a lime keycap with the K on
 * it, a white border, a lifted corner and a gloss sweep. It slaps onto the
 * screen when it mounts; while `busy` the key keeps getting pressed.
 *
 * Styles live in public/keybordy/sticker.css, linked from index.html, because
 * the boot splash there uses the same sticker before any JS has loaded. The
 * markup below is duplicated in index.html: keep the two in step.
 */

import { useId } from 'react';

export type LogoStickerState = 'busy' | 'done' | 'error' | 'idle';

interface LogoStickerProps {
  size?: number;
  state?: LogoStickerState;
  className?: string;
}

export function LogoSticker({ size = 96, state = 'busy', className }: LogoStickerProps) {
  // url(#…) references break on the punctuation React puts in its ids.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clip = `kbs-clip-${uid}`;
  const mask = `kbs-mask-${uid}`;
  const flap = `kbs-flap-${uid}`;

  return (
    <span
      className={`kbs-wrap kbs-slap kbs--${state}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg className="kbs" viewBox="0 0 100 100">
        <defs>
          <clipPath id={clip}>
            <rect x="4" y="4" width="92" height="92" rx="22" />
          </clipPath>
          <mask id={mask}>
            <rect width="100" height="100" fill="#fff" />
            <polygon points="100,72 72,100 100,100" fill="#000" />
          </mask>
          <linearGradient id={flap} x1="86" y1="86" x2="76" y2="76" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#9d95ab" />
            <stop offset="1" stopColor="#f4f1f8" />
          </linearGradient>
        </defs>
        <g mask={`url(#${mask})`}>
          <rect className="kbs-vinyl" x="4" y="4" width="92" height="92" rx="22" />
          <rect className="kbs-cap-skirt" x="13" y="15" width="74" height="72" rx="15" />
          <g className="kbs-cap">
            <rect className="kbs-cap-top" x="13" y="13" width="74" height="64" rx="15" />
            <path
              d="M22 27q0-8 8-8h20"
              fill="none"
              stroke="#fff"
              strokeOpacity=".55"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <g className="kbs-ink" transform="translate(50 45) scale(2.25) translate(-16.75 -16)">
              <rect x="8.5" y="7.5" width="4.5" height="17" rx="1" />
              <polygon points="13,15.2 19.6,7.5 25,7.5 16.4,17.6" />
              <polygon points="15.2,15.6 25,24.5 19.6,24.5 13,18.6" />
            </g>
          </g>
          <g clipPath={`url(#${clip})`}>
            <rect className="kbs-sheen" x="-50" y="-10" width="22" height="120" fill="#fff" />
          </g>
        </g>
        <g className="kbs-peel">
          <polygon points="96,76 76,96 73,73" fill="#000" fillOpacity=".28" />
          <path d="M96 76L76 96V79q0-3 3-3z" fill={`url(#${flap})`} />
        </g>
        <g className="kbs-badge">
          <circle className="kbs-badge-bg" cx="86" cy="14" r="12" />
          <path className="kbs-badge-icon kbs-badge-ok" d="M80.5 14.5l3.8 3.8 7.2-7.6" />
          <path className="kbs-badge-icon kbs-badge-err" d="M81.5 9.5l9 9m0-9l-9 9" />
        </g>
      </svg>
    </span>
  );
}
