// v5 cold open, after the reveal grammar of hardware launches: context, silhouette, reveal. Black; on the
// opening hit a flash, the flare streak and two lines of lime light running round the case's top edge
// from the front, meeting at the back; three backlights hold the device as a silhouette under a faint
// shaft (no dust); a fill fades in just before the crash zoom into the first click.
import type { Frame } from '../../engine/scene';
import { clamp, pulse, smoothstep } from '../../engine/util';
import { first } from '../../cues';
import OpenV4 from '../v4/open';

export default class OpenV5 extends OpenV4 {
  // further back and aimed lower than v4: the whole device and its pool of light sit inside the frame
  protected override wide = { r0: 980, r1: 700, atY: 62 };
  override shot(f: Frame) {
    const s = super.shot(f);
    const boom = first('boom_open').t, crash = first('crash');
    const lit = smoothstep(boom - 0.01, boom + 0.05, f.t);
    // the trace: the heads run the half-outline in 1.1 s (ease-out), the line holds, then dims into the zoom
    const p = 1 - (1 - clamp((f.t - boom) / 1.1)) ** 2.2;
    const fill = smoothstep(crash.t - 0.45, crash.t, f.t);
    return {
      ...s,
      atmos: { beam: (s.atmos?.beam ?? 0) * 0.3, dust: 0 },
      trace: { p, glow: lit * (1.15 + 2 * pulse(f.t, boom, 0.2)) * (1 - smoothstep(crash.t, crash.t + 0.35, f.t)), head: lit * 7 * (1 - smoothstep(boom + 1.0, boom + 1.3, f.t)) },
      sides: { intensity: 14 * lit * (1 - 0.7 * fill) },
      rim: { ...s.rim!, intensity: (s.rim?.intensity ?? 0) * 0.85 },
      key: { ...s.key!, intensity: Math.max(s.key?.intensity ?? 0, 0.9 * fill) },
      env: Math.max(s.env ?? 0, 0.1 * fill),
    };
  }
}
