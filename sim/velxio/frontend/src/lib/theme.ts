/* Theme mode — the app half of the velxio.dev-wide light/dark preference.
 *
 * ── The cross-site contract ──────────────────────────────────────────────
 * The simulator (this app), the blog (/blog/) and the docs portal (/docs/)
 * are three separate builds served from ONE origin, which is what makes the
 * sync possible at all: they share a localStorage jar. The contract is:
 *
 *   key    'velxio-theme'
 *   value  'dark' | 'light' | 'system'      ← the PREFERENCE, not the result
 *   unset  means 'dark'                      ← velxio.dev is dark by default,
 *                                              regardless of what the OS says
 *
 * Whoever changes the preference also writes the two keys the other two
 * sites' own toggles read, so their native switches stay in sync instead of
 * fighting us:
 *
 *   'starlight-theme'  the docs portal (Starlight), same vocabulary but it
 *                      spells "system" as "auto"
 *   'theme'            the blog, which only understands a RESOLVED value
 *
 * Reading works the same way in reverse: a reader who flips the docs to
 * light and then opens the simulator lands in light. See MIRRORS below.
 *
 * ── Why the OS preference is not the default ─────────────────────────────
 * A simulator is a dark-room tool and the product's identity is dark, so an
 * unset preference is dark even on a machine set to light. `system` is a
 * third, opt-in mode — never the fallback.
 */

export type ThemeMode = 'dark' | 'light' | 'system';
/** What `system` resolves to. This is what lands on `<html data-theme>`. */
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'velxio-theme';

/** Storage keys owned by the other two velxio.dev surfaces. Kept in sync on
 *  every change so their built-in toggles show the right state. */
const MIRROR_STARLIGHT = 'starlight-theme';
const MIRROR_BLOG = 'theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isMode(v: unknown): v is ThemeMode {
  return v === 'dark' || v === 'light' || v === 'system';
}

/** Read a key without letting a locked-down browser (Safari private mode,
 *  "block all cookies") throw on the way in. */
function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage denied — the theme still applies for this page's lifetime */
  }
}

/** The stored preference, falling back to the sibling sites' keys before
 *  giving up and calling it dark. */
export function readStoredMode(): ThemeMode {
  const own = readKey(THEME_STORAGE_KEY);
  if (isMode(own)) return own;

  // Docs portal: same vocabulary, different word for "system".
  const starlight = readKey(MIRROR_STARLIGHT);
  if (starlight === 'auto') return 'system';
  if (isMode(starlight)) return starlight;

  // Blog: only ever stores a resolved value.
  const blog = readKey(MIRROR_BLOG);
  if (blog === 'dark' || blog === 'light') return blog;

  return 'dark';
}

export function systemPrefers(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** keybordy is dark only: every mode resolves to dark. The mode plumbing is
 *  kept so the ~20 call sites that read the resolved theme keep compiling. */
export function resolveMode(_mode: ThemeMode): ResolvedTheme {
  return 'dark';
}

// ── Reading tokens from JS ──────────────────────────────────────────────
// Anything painted outside CSS's reach — a 2D canvas, a Monaco theme, an
// inline SVG attribute — needs the token's VALUE, not its name. Resolving a
// custom property means a getComputedStyle call, which forces style recalc,
// so results are cached and the cache is dropped whenever the theme moves.

const varCache = new Map<string, string>();

/** Resolved value of a CSS custom property, e.g. cssVar('--wb-6'). */
export function cssVar(name: string, fallback = '#000'): string {
  const hit = varCache.get(name);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v || fallback;
  varCache.set(name, out);
  return out;
}

/** Paint the resolved theme onto the document and tell the browser which
 *  scheme its own widgets (scrollbars, form controls, the caret) should use. */
function paint(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  varCache.clear();
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;

  // The address-bar tint on mobile. Matches --color-bg-canvas per theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#070608');
}

// ── Subscribable state ──────────────────────────────────────────────────
// A plain module store rather than Zustand: index.html has already applied a
// theme before React exists, so the source of truth is the DOM + storage, and
// React only needs to be told when it changes (useSyncExternalStore).

let currentMode: ThemeMode = 'dark';
let currentResolved: ResolvedTheme = 'dark';
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getMode(): ThemeMode {
  return currentMode;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply a mode, persist it, and mirror it to the blog and docs keys. */
export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  currentResolved = resolveMode(mode);
  paint(currentResolved);

  writeKey(THEME_STORAGE_KEY, mode);
  writeKey(MIRROR_STARLIGHT, mode === 'system' ? 'auto' : mode);
  writeKey(MIRROR_BLOG, currentResolved);

  emit();
}

let started = false;

/** Called once from main.tsx. keybordy has a single dark theme, so this only
 *  paints it; there is no OS or cross-tab preference to follow. */
export function initTheme(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  currentMode = 'dark';
  currentResolved = 'dark';
  paint('dark');
  emit();
}
