/* Monaco theme wired to the app's workbench ramp.
 *
 * Monaco paints into a canvas-backed DOM of its own and cannot read CSS
 * custom properties, so the theme below restates the ramp as literals. It is
 * the ONLY place in the app allowed to do that; if tokens/colors.css moves a
 * --wb-* value or a signal color, move it here too or the editor will sit a
 * shade off the panel around it.
 *
 * keybordy is dark only ("Procedure Online"): keywords in hot pink, types in
 * lavender, numbers in acid lime, macros and constants in violet.
 */
import type { Monaco } from '@monaco-editor/react';

export const MONACO_DARK = 'keybordy-dark';

/** Editor chrome. Mirrors --wb-* in tokens/colors.css. */
const DARK = {
  bg: '#0e0d11', // --wb-2
  gutter: '#0e0d11',
  lineNumber: '#716a7c', // --wb-9
  lineNumberActive: '#f4f1f8', // --wb-13
  indentGuide: '#2c2833', // --wb-6
  currentLine: '#d6ff1f0f', // lime at 6%
  selection: '#b9a8ff4d', // lavender at 30%
  widgetBg: '#121015', // --wb-3
  widgetBorder: '#3a3444', // --wb-7
  scrollShadow: '#000000',
  cursor: '#d6ff1f', // lime
};

/** Syntax colors. Mirrors the signal primitives in tokens/colors.css. */
const RULES = [
  { token: 'comment', foreground: '6f6879', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'ff5c93' },
  { token: 'keyword.directive', foreground: 'd17bff' },
  { token: 'type', foreground: 'b9a8ff' },
  { token: 'type.identifier', foreground: 'b9a8ff' },
  { token: 'number', foreground: 'd6ff1f' },
  { token: 'number.hex', foreground: 'd6ff1f' },
  { token: 'number.float', foreground: 'd6ff1f' },
  { token: 'string', foreground: 'e9ff9a' },
  { token: 'string.escape', foreground: 'd6ff1f' },
  { token: 'identifier', foreground: 'd8d3e0' },
  { token: 'delimiter', foreground: 'a59fb2' },
  { token: 'operator', foreground: 'a59fb2' },
  { token: 'constant', foreground: 'd17bff' },
  { token: 'annotation', foreground: 'd17bff' },
  // Python (MicroPython boards)
  { token: 'keyword.python', foreground: 'ff5c93' },
  { token: 'string.python', foreground: 'e9ff9a' },
];

function colors(c: typeof DARK): Record<string, string> {
  return {
    'editor.background': c.bg,
    'editor.foreground': '#d8d3e0',
    'editorCursor.foreground': c.cursor,
    'editorGutter.background': c.gutter,
    'editorLineNumber.foreground': c.lineNumber,
    'editorLineNumber.activeForeground': c.lineNumberActive,
    'editorIndentGuide.background1': c.indentGuide,
    'editor.lineHighlightBackground': c.currentLine,
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': c.selection,
    'editor.inactiveSelectionBackground': '#b9a8ff26',
    'editorBracketMatch.background': '#b9a8ff26',
    'editorBracketMatch.border': '#b9a8ff80',
    // The hover / suggest / signature popups. They escape the editor box as
    // fixed overlays (fixedOverflowWidgets), so they land on top of the
    // canvas and have to read as app chrome, not as a stray dark rectangle.
    'editorWidget.background': c.widgetBg,
    'editorWidget.border': c.widgetBorder,
    'editorSuggestWidget.background': c.widgetBg,
    'editorSuggestWidget.border': c.widgetBorder,
    'editorSuggestWidget.selectedBackground': '#b9a8ff2e',
    'editorSuggestWidget.highlightForeground': '#d6ff1f',
    'editorHoverWidget.background': c.widgetBg,
    'editorHoverWidget.border': c.widgetBorder,
    'input.background': c.bg,
    'dropdown.background': c.widgetBg,
    'scrollbar.shadow': c.scrollShadow,
    'scrollbarSlider.background': '#3a344480',
    'scrollbarSlider.hoverBackground': '#4b4456aa',
    'minimap.background': c.bg,
  };
}

/** Register the theme on a monaco instance. Idempotent per instance —
 *  CodeEditor remounts per file (the `key` prop) and would otherwise
 *  redefine it on every tab switch. */
export function defineKeybordyThemes(monaco: Monaco): void {
  const g = monaco as unknown as { __keybordyThemes?: boolean };
  if (g.__keybordyThemes) return;
  g.__keybordyThemes = true;

  monaco.editor.defineTheme(MONACO_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: RULES,
    colors: colors(DARK),
  });
}

/** keybordy has one theme; the argument is kept for existing call sites. */
export function monacoThemeFor(_resolved: 'dark' | 'light'): string {
  return MONACO_DARK;
}
