/**
 * Catch-all route. Unknown paths used to render a blank black page; now they
 * get the logo sticker (pink, with a cross), the path that missed, and a way
 * back. Enter opens the editor, like pressing the keycap on screen.
 */

import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { LogoSticker } from '../components/ui/LogoSticker';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import './NotFoundPage.css';

export function NotFoundPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useDocumentTitle('Not found · keybordy');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) navigate('/editor');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <main className="nf">
      <LogoSticker size={120} state="error" />
      <h1 className="nf__title">No key mapped here</h1>
      <p className="nf__path">
        {/* Typed out one character at a time, like the header title. */}
        {pathname.split('').map((ch, i) => (
          <span key={i} style={{ animationDelay: `${500 + i * 28}ms` }}>
            {ch}
          </span>
        ))}
        <span className="nf__caret" aria-hidden="true" />
      </p>
      <p className="nf__body">Nothing lives at this address. The workbench does.</p>
      <div className="nf__actions">
        <Link to="/editor" className="nf__primary">
          Open the editor
          <kbd className="nf__kbd" aria-hidden="true">
            ↵
          </kbd>
        </Link>
        <Link to="/examples" className="nf__secondary">
          Browse examples
        </Link>
      </div>
    </main>
  );
}
