/**
 * Removes the boot splash that index.html paints before any JS loads.
 *
 * The editor calls this once its workspace (the `?project=` folder, a saved
 * project or the draft) is on the canvas; main.tsx calls it right away on
 * every other route. It is idempotent. The splash stays up for at least
 * MIN_VISIBLE_MS after navigation so a fast reload still shows the sticker
 * land instead of flashing it for one frame.
 *
 * On the way out the sticker flies into the header's logo slot, and
 * `data-booted` on <html> cues the header (App.css): the mark catches it and
 * the title types itself in. The attribute is taken off again afterwards so
 * those one-shot animations never replay (a hover animation ending would
 * otherwise re-trigger them).
 */

const MIN_VISIBLE_MS = 900;
const EXIT_MS = 620;
const BOOTED_CUE_MS = 1800;

export function dismissBootSplash(): void {
  const el = document.getElementById('boot-splash');
  if (!el || el.dataset.state) return;
  el.dataset.state = 'leaving-soon';

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const wait = reduced ? 0 : Math.max(0, MIN_VISIBLE_MS - performance.now());
  window.setTimeout(() => {
    aimAtHeaderMark(el);
    el.dataset.state = 'leaving';
    window.setTimeout(() => {
      el.remove();
      const root = document.documentElement;
      root.dataset.booted = '';
      window.setTimeout(() => delete root.dataset.booted, BOOTED_CUE_MS);
    }, reduced ? 300 : EXIT_MS);
  }, wait);
}

/** Point the sticker's exit flight at the header mark, if one is on screen. */
function aimAtHeaderMark(splash: HTMLElement): void {
  const sticker = splash.querySelector<HTMLElement>('.kbs-wrap');
  const mark = document.querySelector<HTMLElement>('.header-mark');
  if (!sticker || !mark) return;
  const from = sticker.getBoundingClientRect();
  const to = mark.getBoundingClientRect();
  if (!to.width || !from.width) return;
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  sticker.style.setProperty('--boot-dx', `${dx}px`);
  sticker.style.setProperty('--boot-dy', `${dy}px`);
  // The rotated bounding box is a little wider than the sticker itself.
  sticker.style.setProperty('--boot-scale', String((to.width / from.width) * 1.15));
}
