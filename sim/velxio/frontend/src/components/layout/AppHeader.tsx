import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useLocalizedHref } from '../../i18n/useLocalizedNavigate';
import { applyStripLayout, STRIP_BELOW_CLASS } from './headerStripFit';
import './LanguageSwitcher.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const DISCORD_URL = 'https://discord.gg/3mARjJrh4E';

interface AppHeaderProps {
  /** Editor variant: a File/Edit menu bar rendered next to the logo. When
   *  set, the marketing nav links (Home / Docs / Pricing / …) are hidden —
   *  inside the editor they are noise that costs exactly the width the
   *  toolbar is starved of on small screens; the logo still links home. */
  editorMenu?: React.ReactNode;
  /** Editor variant: the unified toolbar strip rendered in the header's
   *  middle — the space the marketing nav used to occupy. One row instead
   *  of header + toolbar stacked; the strip wraps internally when narrow
   *  and the header grows to fit (height: auto on the modifier class). */
  editorToolbar?: React.ReactNode;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ editorMenu, editorToolbar }) => {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { t } = useTranslation();
  const localize = useLocalizedHref();

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Editor variant: where does the toolbar strip go — on the brand row or
  // on its own bar below, labelled or icon-only? Measured, not guessed —
  // see headerStripFit.ts, which sets `app-header--strip-below` on the
  // header and `unified-toolbar--compact` on the strip. Re-measured
  // whenever the strip host, the brand block or a strip zone resizes
  // (window, docked chat, board controls mounting). The first measure runs
  // before paint; later ones are deferred a frame so toggling the classes
  // never re-enters ResizeObserver delivery.
  const headerRef = useRef<HTMLElement>(null);
  const hasStrip = !!editorToolbar;
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header || !hasStrip) return;
    const apply = () => {
      applyStripLayout(header);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    };
    const ro = new ResizeObserver(schedule);
    const content = header.querySelector<HTMLElement>(':scope > .header-content');
    const left = content?.querySelector<HTMLElement>(':scope > .header-left');
    const host = content?.querySelector<HTMLElement>(':scope > .header-editor-toolbar');
    const strip = host?.firstElementChild;
    for (const el of [left, host, ...(strip ? Array.from(strip.children) : [])]) {
      if (el) ro.observe(el);
    }
    // Zones mount their controls later (the canvas side is a portal) —
    // pick up children that appear after mount.
    const mo = strip
      ? new MutationObserver(() => {
          for (const z of Array.from(strip.children)) ro.observe(z);
          schedule();
        })
      : null;
    if (strip && mo) mo.observe(strip, { childList: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      header.classList.remove(STRIP_BELOW_CLASS);
    };
  }, [hasStrip]);

  // Compare with the trailing slash ignored: /editor/ and /editor are the
  // same page.
  const samePath = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  const isActive = (path: string) =>
    samePath(location.pathname, localize(path)) ? ' header-nav-link-active' : '';

  return (
    <header ref={headerRef} className={"app-header" + (editorToolbar ? ' app-header--with-toolbar' : '')}>
      <div className="header-content">
        <div className="header-left">
          {/* Brand */}
          <div className="header-brand">
            <Link to={localize('/')} className="header-brand-link" aria-label="keybordy home">
              {/* A keycap: hover lifts it into a sticker, a click presses it.
                  The boot splash's sticker flies into this slot on load. */}
              <span className="header-mark" aria-hidden="true">
                <svg viewBox="7 6 20 20" width="13" height="13">
                  <rect x="8.5" y="7.5" width="4.5" height="17" rx="1" />
                  <polygon points="13,15.2 19.6,7.5 25,7.5 16.4,17.6" />
                  <polygon points="15.2,15.6 25,24.5 19.6,24.5 13,18.6" />
                </svg>
              </span>
              {/* One span per letter: the title types itself in once the boot
                  splash lifts, and ripples like a row of keys on hover. */}
              <span className="header-title" aria-label="keybordy">
                {'keybordy'.split('').map((ch, i) => (
                  <span key={i} aria-hidden="true" style={{ '--i': i } as React.CSSProperties}>
                    {ch}
                  </span>
                ))}
              </span>
            </Link>
          </div>

          {editorMenu}
          {!editorMenu && (
          <nav className={'header-nav-links' + (menuOpen ? ' header-nav-open' : '')}>
            <Link to={localize('/examples')} className={'header-nav-link' + isActive('/examples')}>
              {t('header.nav.examples')}
            </Link>
            <Link to={localize('/editor/')} className={'header-nav-link' + isActive('/editor')}>
              {t('header.nav.editor')}
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="header-nav-link"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                style={{ flexShrink: 0 }}
              >
                <path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.185 6.839 9.504.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.026 2.747-1.026.546 1.378.202 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.338 4.695-4.566 4.944.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.203 22 16.447 22 12.021 22 6.484 17.523 2 12 2z" />
              </svg>
              {t('header.nav.github')}
            </a>
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="header-nav-link header-nav-discord"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                style={{ flexShrink: 0 }}
              >
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.053a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
              {t('header.nav.discord')}
            </a>
          </nav>
          )}
        </div>

        {/* Editor toolbar strip — fills the middle the nav vacated. */}
        {editorToolbar && <div className="header-editor-toolbar">{editorToolbar}</div>}

        {/* Right: theme + language + mobile hamburger. In the editor
            variant this block does not render at all: every pixel of the
            row goes to the toolbar. */}
        {!editorToolbar && (
        <div className="header-right">
          <LanguageSwitcher />

          {/* Mobile hamburger — useless in the editor variant, where
              there is no nav to expand at all. */}
          {!editorMenu && (
            <button
              className="header-hamburger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              <span />
              <span />
              <span />
            </button>
          )}
        </div>
        )}
      </div>

    </header>
  );
};
