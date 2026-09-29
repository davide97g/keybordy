/**
 * Accent color per board family, used for the board's tab in the serial
 * monitor and its section header in the file explorer. Drawn from the
 * keybordy palette so board accents sit with the rest of the theme.
 */
export function boardAccent(boardKind: string): string {
  if (/esp32|lolin32/.test(boardKind)) return 'var(--lime-500)';
  if (boardKind.startsWith('raspberry-pi-pico') || boardKind === 'pi-pico-w')
    return 'var(--lavender-400)';
  if (boardKind.startsWith('raspberry-pi-')) return 'var(--pink-500)';
  if (boardKind.startsWith('arduino-')) return 'var(--cyan-400)';
  if (boardKind.startsWith('attiny')) return 'var(--amber-500)';
  if (boardKind.startsWith('stm32')) return 'var(--violet-400)';
  return 'var(--wb-10)';
}

/**
 * Per-key trace colors. A pushbutton labeled `K<n>` owns its cap color; the
 * same hex is used on its wires in the Wokwi diagram, so the serial monitor
 * can paint "key <n>" lines in that color too.
 */
export function keyColorsFromComponents(
  components: { metadataId: string; properties: Record<string, unknown> }[],
): Map<number, string> {
  const out = new Map<number, string>();
  for (const c of components) {
    if (c.metadataId !== 'pushbutton' && c.metadataId !== 'pushbutton-6mm') continue;
    const label = typeof c.properties.label === 'string' ? c.properties.label.trim() : '';
    const m = /^K(\d+)$/i.exec(label);
    const color = c.properties.color;
    if (m && typeof color === 'string' && color) out.set(Number(m[1]), color);
  }
  return out;
}
