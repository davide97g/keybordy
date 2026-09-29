/**
 * Removes the boot splash that index.html paints before any JS loads.
 *
 * The editor calls this once its workspace (the `?project=` folder, a saved
 * project or the draft) is on the canvas; main.tsx calls it right away on
 * every other route. It is idempotent. The splash stays up for at least
 * MIN_VISIBLE_MS after navigation so a fast reload still shows the sticker
 * land instead of flashing it for one frame, then peels it off.
 */

const MIN_VISIBLE_MS = 900;
const EXIT_MS = 520;

export function dismissBootSplash(): void {
  const el = document.getElementById('boot-splash');
  if (!el || el.dataset.state) return;
  el.dataset.state = 'leaving-soon';

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const wait = reduced ? 0 : Math.max(0, MIN_VISIBLE_MS - performance.now());
  window.setTimeout(() => {
    el.dataset.state = 'leaving';
    window.setTimeout(() => el.remove(), reduced ? 400 : EXIT_MS);
  }, wait);
}
