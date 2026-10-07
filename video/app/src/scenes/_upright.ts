// The upright cut (?aspect=9x16): each shot of the 16:9 edit reframed for a 1080x1920 frame. three.js keeps
// the vertical field of view, so upright the frame is ~3x narrower: the camera pulls back along its own line
// of sight (same angle, same lens), the fog moves back with it, and a lens shift places the subject between
// the type and the Reels/Shorts overlays. Every scene of every version reads this table when VERTICAL.
import type { Frame } from '../engine/scene';
import { clamp, ease } from '../engine/util';
import { first } from '../cues';
import type { Shot, V3 } from '../stage';

export interface Upright {
  /** Camera distance to `at` times this. */
  dolly?: number;
  /** Field of view times this. */
  fov?: number;
  /** Lens shift (fraction of the frame height, + moves the image up). */
  shift?: number;
}

const TABLE: Record<string, (f: Frame) => Upright> = {
  // wide on the silhouette and the edge light, back to the v5 macro as the crash zoom lands
  open: (f) => {
    const crash = first('crash').t, press = first('press', (c) => c.key === 'K1').t;
    const u = ease.inOutCubic(clamp((f.t - crash) / (press - 0.1 - crash)));
    return { dolly: 1.3 - 0.3 * u, shift: -0.06 * (1 - u) };
  },
  knob: () => ({ dolly: 1.35 }),
  oled: () => ({ dolly: 2.2 }),
  build: () => ({ dolly: 1.55, shift: -0.03 }),
  hero: () => ({ dolly: 2.5 }),
  montage: () => ({ dolly: 1.5 }),
  editor: () => ({ dolly: 1.4 }),
  talk: () => ({ dolly: 1.4 }),
  title: () => ({ dolly: 2.0, shift: -0.12 }),
  credit: () => ({ dolly: 2.0, shift: -0.12 }),
};

export function upright<S extends Omit<Shot, 'pose'>>(id: string, f: Frame, s: S): S {
  const u = TABLE[id]?.(f) ?? {};
  const d = u.dolly ?? 1;
  const at = s.at, cam = s.cam;
  return {
    ...s,
    cam: [0, 1, 2].map((i) => at[i]! + (cam[i]! - at[i]!) * d) as V3,
    fov: s.fov * (u.fov ?? 1),
    shift: (s.shift ?? 0) + (u.shift ?? 0),
    fog: (s.fog ?? 1) * Math.max(1, d),
  };
}
