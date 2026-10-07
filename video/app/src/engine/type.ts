// Fonts: the simulator's self-hosted variable faces (sim/velxio/frontend/public/fonts), served at /fonts/.
// Anybody is the display face (width 50–150 %, weight 100–900), Geist the body, Martian Mono the mono.

const FACES: { family: string; file: string; descriptors: FontFaceDescriptors }[] = [
  { family: 'Anybody', file: 'Anybody.var.woff2', descriptors: { weight: '100 900', stretch: '50% 150%' } },
  { family: 'Geist', file: 'Geist.var.woff2', descriptors: { weight: '100 900' } },
  { family: 'Martian Mono', file: 'MartianMono.var.woff2', descriptors: { weight: '100 800', stretch: '75% 112.5%' } },
];

export async function loadFonts(): Promise<void> {
  await Promise.all(FACES.map(async (f) => {
    const ff = new FontFace(f.family, `url(fonts/${f.file})`, f.descriptors);
    await ff.load();
    document.fonts.add(ff);
  }));
  await document.fonts.ready;
}

/** CSS font string for Canvas2D. Width goes through ctx.fontStretch (see `stretch`). */
export const font = (family: string, sizePx: number, weight = 400) => `${weight} ${sizePx}px "${family}"`;

/** Canvas2D only takes keyword stretches: the nearest one to a width in percent. */
export function stretch(pct: number): CanvasFontStretch {
  const k: [number, CanvasFontStretch][] = [[50, 'ultra-condensed'], [62.5, 'extra-condensed'], [75, 'condensed'], [87.5, 'semi-condensed'],
    [100, 'normal'], [112.5, 'semi-expanded'], [125, 'expanded'], [150, 'extra-expanded'], [200, 'ultra-expanded']];
  return k.reduce((b, x) => (Math.abs(x[0] - pct) < Math.abs(b[0] - pct) ? x : b))[1];
}
