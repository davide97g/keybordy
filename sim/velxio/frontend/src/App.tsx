import type { ReactElement } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { EditorPage } from './pages/EditorPage';
import { ExamplesPage } from './pages/ExamplesPage';
import { ExampleDetailPage } from './pages/ExampleDetailPage';
import { ExampleEditorPage } from './pages/ExampleEditorPage';
import { ImageToCodePage } from './pages/ImageToCodePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { LocaleSync } from './i18n/LocaleSync';
import { NON_DEFAULT_LOCALES } from './i18n/config';
import { MessageDialogHost } from './components/ui/MessageDialogHost';
import './App.css';

/**
 * Single source of truth for the route tree. Each entry is registered
 * twice in <Routes> below: once at the root (default locale) and once
 * nested under each non-default locale prefix (e.g. `/es/editor`).
 *
 * Index entries (path === '') belong to the locale-prefixed parent's
 * `index` slot — they render at exactly `/<locale>/`.
 */
const ROUTES: { path: string; element: ReactElement; index?: boolean }[] = [
  // The app IS the editor: no landing page.
  { path: '/', element: <Navigate to="/editor" replace />, index: true },
  { path: 'editor', element: <EditorPage /> },
  { path: 'examples', element: <ExamplesPage /> },
  // /examples/<id> = example detail (preview, badges, "Open in Simulator").
  // /example/<id>  = live editor with the example pre-loaded; the URL
  //                  stays pinned so links are bookmarkable.
  { path: 'examples/:exampleId', element: <ExampleDetailPage /> },
  { path: 'example/:exampleId', element: <ExampleEditorPage /> },
  // Standalone tool: image to monochrome C byte array for OLED displays.
  { path: 'tools/image-to-code', element: <ImageToCodePage /> },
];

/**
 * The default locale (English) is served at the root with NO `/en` prefix, so
 * `/en/...` matches no route and renders blank. People reasonably guess `/en/`
 * by analogy with `/es/`, `/zh-cn/`, … — redirect them to the prefix-free path
 * (`/en/project/x` → `/project/x`, `/en` → `/`) instead of a blank page. This
 * keeps the canonical no-prefix English URLs (good for SEO) while handling the
 * guessed ones gracefully.
 */
function EnPrefixRedirect() {
  const { pathname, search, hash } = useLocation();
  const stripped = pathname.replace(/^\/en(?=\/|$)/, '');
  return <Navigate to={(stripped || '/') + search + hash} replace />;
}

function App() {
  return (
    <Router>
      <LocaleSync>
        <Routes>
          {/* Default locale (English) — no URL prefix. */}
          {ROUTES.map((r) =>
            r.index ? (
              <Route key="root" path="/" element={r.element} />
            ) : (
              <Route key={r.path} path={`/${r.path}`} element={r.element} />
            )
          )}

          {/*
            Non-default locales — same routes nested under `/<locale>/`.
            We register one branch per locale rather than a `:lang` param
            so React Router doesn't accidentally swallow real top-level
            paths like `/circuit-simulator` as a locale segment.
          */}
          {NON_DEFAULT_LOCALES.map((locale) => (
            <Route key={`locale-${locale}`} path={`/${locale}`}>
              {ROUTES.map((r) =>
                r.index ? (
                  <Route key={`${locale}-root`} index element={r.element} />
                ) : (
                  <Route
                    key={`${locale}-${r.path}`}
                    path={r.path}
                    element={r.element}
                  />
                )
              )}
            </Route>
          ))}

          {/* `/en/...` is the default locale spelled out — redirect to the
              canonical prefix-free path instead of rendering a blank page. */}
          <Route path="/en/*" element={<EnPrefixRedirect />} />

          {/* Anything else: the 404 sticker instead of a blank page. */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </LocaleSync>
      {/* Global alert() replacement — opened from anywhere (React or plain
          .ts) via showMessageDialog() in store/useMessageDialogStore. */}
      <MessageDialogHost />
    </Router>
  );
}

export default App;
