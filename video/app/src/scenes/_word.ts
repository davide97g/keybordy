// Per-glyph layout with the font's kerning (glyph i sits at the width of text[0..i] minus its advance).
export function layoutWord(c: CanvasRenderingContext2D, text: string) {
  const chars = Array.from(text);
  let prefix = '';
  const glyphs = chars.map((ch) => {
    prefix += ch;
    const w = c.measureText(ch).width;
    return { ch, x: c.measureText(prefix).width - w, w };
  });
  return { width: c.measureText(text).width, glyphs };
}
