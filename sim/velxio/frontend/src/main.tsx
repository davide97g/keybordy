import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import './index.css';
// Side-effect import: initialises i18next BEFORE any component renders so
// useTranslation() always resolves against a live instance. Must come
// before App.
import './i18n';
// Side-effect-free on the DOM (index.html already painted the theme) —
// this only subscribes to the OS preference.
import { initTheme } from './lib/theme';
import { registerDefaultWokwiBoardMappings } from './utils/wokwiZip';
import { dismissBootSplash } from './lib/bootSplash';
import './components/velxio-components/IC74HC595';
import './components/velxio-components/LogicGateElements';
import './components/velxio-components/TransistorElements';
import './components/velxio-components/OpAmpElements';
import './components/velxio-components/PowerElements';
import './components/velxio-components/DiodeElements';
import './components/velxio-components/RelayElements';
import './components/velxio-components/LogicICElements';
import './components/velxio-components/MotorDriverElements';
import './components/velxio-components/FlipFlopElements';
import './components/velxio-components/RaspberryPi3Element';
import './components/velxio-components/Bmp280Element';
import './components/velxio-components/Ds3231Element';
import './components/velxio-components/GpsNeo6mElement';
import './components/velxio-components/EPaperElement';
import App from './App.tsx';

// Configure monaco-editor for offline use via local static assets
const monacoVsPath = `${import.meta.env.BASE_URL}monaco/vs`;
loader.config({ paths: { vs: monacoVsPath } });

// Adopt the stored light/dark preference and start listening for it changing
// elsewhere (the OS, another tab). index.html already put the
// right theme on <html> before the first paint; this keeps it there.
initTheme();

// Plain Wokwi diagrams (wokwi.com, the Wokwi VS Code extension) name their
// boards by Wokwi part type; teach the importer the ones Velxio can run.
registerDefaultWokwiBoardMappings();

// Every deploy renames the hashed chunks and the old ones are gone from the
// image. A tab opened before the deploy fails its next lazy import with
// "Failed to fetch dynamically imported module" (seen on the flash dialog's
// Rp2WebFlasher chunk right after a deploy). Vite raises this event first;
// reloading once picks up the new index and its chunk names. The timestamp
// guard keeps a genuinely missing chunk from reloading forever.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'velxio-chunk-reload-at';
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(key) || 0);
  } catch {
    /* storage blocked: reload without the guard */
  }
  if (Date.now() - last < 60_000) return; // let the error surface the second time
  try {
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    /* ignore */
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(<App />);

// The editor drops the boot splash once its workspace has loaded (see
// EditorPage). Every other route has nothing to wait for.
if (!/\/editor\/?$/.test(window.location.pathname)) {
  requestAnimationFrame(() => dismissBootSplash());
}

// DEV-only: expose the core stores for E2E harnesses (the platform-bugs QA
// harness drives the STORE paths — property updates, group switches — the
// way the agent tools do, which raw DOM access cannot reach). Guarded by
// import.meta.env.DEV so production bundles never ship it.
if (import.meta.env.DEV) {
  Promise.all([
    import('./store/useSimulatorStore'),
    import('./store/useEditorStore'),
    import('./store/useElectricalStore'),
  ]).then(([sim, ed, el]) => {
    (window as unknown as Record<string, unknown>).__velxioStores = {
      useSimulatorStore: sim.useSimulatorStore,
      useEditorStore: ed.useEditorStore,
      useElectricalStore: el.useElectricalStore,
      getBoardSimulator: sim.getBoardSimulator,
    };
  });
}
