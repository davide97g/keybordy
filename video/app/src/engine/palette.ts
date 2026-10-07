import { hexToLinear } from './util';

// keybordy's "Procedure Online" palette (sim/velxio/frontend/src/tokens/colors.css): black ground,
// white type, lime signal, pink and lavender used rarely. The key names are the engine's.
export const HEX = {
  ink: '#070608', // ground
  ink2: '#121015', // panel
  graphite: '#2C2833', // lines
  ash: '#A59FB2', // muted text
  bone: '#F4F1F8', // primary text, flashes
  signal: '#D6FF1F', // lime: the one accent
  ember: '#FF2E74', // pink
  blood: '#8FB300', // lime's shadow (the sticker's drop)
  acid: '#B9A8FF', // lavender
  green: '#00AE42', // Bambu Green, the talk bar
} as const;

export type PaletteKey = keyof typeof HEX;

/** Linear RGB triplets for GL uniforms. */
export const LIN: Record<PaletteKey, [number, number, number]> = Object.fromEntries(
  Object.entries(HEX).map(([k, v]) => [k, hexToLinear(v)]),
) as Record<PaletteKey, [number, number, number]>;

/** CSS rgba() for Canvas2D. */
export function rgba(key: PaletteKey | string, a = 1): string {
  const hex = (HEX as Record<string, string>)[key] ?? key;
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
