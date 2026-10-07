// The wordmark: "keybordy" typed one letter per eighth over a rim-lit silhouette of the device, then the
// big hit and the MP sticker.
import type { Frame } from '../engine/scene';
import { clamp, ease } from '../engine/util';
import { events } from '../cues';
import { layoutWord } from './_word';
import { ProductScene, orbit } from './_product';
import { setFont, WHITE } from './_type';
import type { V3 } from '../stage';

export default class Title extends ProductScene {
  protected override wantsText = true;
  shot(f: Frame) {
    const p = f.lt / (f.end - f.start);
    const lit = 0;
    return {
      cam: orbit([0, 10, 0], 0.08 - 0.12 * p, 0.12, 330 - 30 * ease.outCubic(p)), at: [0, 62, 0] as V3, fov: 30,
      key: { pos: [0, 400, 200] as V3, intensity: 0.25 * lit, radius: 60 },
      rim: { intensity: 0.6 * (4 + 26 * lit), pos: [0, 70, -260] as V3, at: [0, 20, 0] as V3, w: 700, h: 20 },
      env: 0.02 + 0.06 * lit,
    };
  }
  override overlay(f: Frame, c: CanvasRenderingContext2D) {
    const letters = events('letter');
    const size = 210;
    setFont(c, 'Anybody', size, 900, 130, -4);
    const word = layoutWord(c, 'keybordy');
    const x0 = 960 - word.width / 2 - 60, y = 470;
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    for (const l of letters) {
      const lt = f.t - l.t;
      if (lt < 0) continue;
      const k = ease.outBack(clamp(lt / 0.12), 2.6);
      c.save();
      c.globalAlpha = clamp(lt / 0.025);
      const g = word.glyphs[l.i]!;
      c.translate(x0 + g.x + g.w / 2, y);
      c.scale(1, 0.4 + 0.6 * k); c.translate(0, 18 * (1 - k));
      c.fillStyle = WHITE;
      c.fillText(l.ch, -g.w / 2, 0);
      c.restore();
    }
    return f.t >= letters[0]!.t;
  }
  override post() {
    return { bloom: 0.55, vignette: 0.5 };
  }
}
