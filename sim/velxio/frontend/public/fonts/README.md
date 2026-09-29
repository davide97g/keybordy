# Self-hosted webfonts

keybordy ships three variable fonts from this directory so the simulator renders the same with no network:

- `Anybody.var.woff2`: Anybody, weight 100-900 and width 50-150%. Display face for the wordmark and panel titles, used wide (130-150%) and heavy (800+).
- `Geist.var.woff2`: Geist, weight 100-900. Interface text.
- `MartianMono.var.woff2`: Martian Mono, weight 100-800 and width 75-112.5%. Code (Monaco), pins, serial output and micro-labels.

All three are the latin subsets served by Google Fonts (fonts.gstatic.com), downloaded once on 2026-09-29. They are licensed under the SIL Open Font License 1.1.

The `@font-face` rules and the `--font-display`, `--font-sans` and `--font-mono` tokens live in `src/tokens/typography.css`. `index.html` preloads the three files; the `crossorigin` attribute on each preload is required, or the browser fetches the font twice.

Monaco measures glyph widths once at startup, so `CodeEditor.tsx` calls `monaco.editor.remeasureFonts()` after `document.fonts.ready`.
