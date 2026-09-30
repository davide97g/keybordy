// keybordy keymap editor. Talks to host/hammerspoon/keybordy_web.lua: loads
// the keymap, saves it whole, simulates presses and polls the activity log.

const TOKEN = document.querySelector('meta[name="keybordy-token"]').content;
const KEY_COUNT = 8;

// Stroke icons (lucide shapes), one per action type.
const ICONS = {
  none: '<path d="M5 12h14"/>',
  app: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  shell: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  url: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  shortcut: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  keys: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  media: '<path d="M6 3 20 12 6 21z"/>',
};

function icon(type) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[type]}</svg>`;
  return span;
}

// Every kind of action Hammerspoon can run (runners in keybordy.lua).
const TYPES = [
  { type: 'none', name: 'Nothing', desc: 'Key is free. A press only shows a hint.' },
  { type: 'app', name: 'Open app', desc: 'Launch an app, or bring it to the front.' },
  { type: 'terminal', name: 'Terminal', desc: 'New Ghostty window in a folder, typing a command.' },
  { type: 'shell', name: 'Shell command', desc: 'Run in the background with your login shell. Output lands in Activity.' },
  { type: 'url', name: 'Open URL', desc: 'A web link, or an app scheme like obsidian:// or raycast://.' },
  { type: 'shortcut', name: 'Shortcut', desc: 'Run a shortcut from the macOS Shortcuts app.' },
  { type: 'keys', name: 'Key combo', desc: 'Send a keyboard shortcut to the frontmost app.', access: true },
  { type: 'text', name: 'Type text', desc: 'Type a snippet into the frontmost app.', access: true },
  { type: 'media', name: 'Media key', desc: 'Play/pause, next track, volume, brightness.', access: true },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.type, t]));

const DEFAULTS = {
  none: {},
  app: { app: '', path: '' },
  terminal: { dir: '~', command: '' },
  shell: { command: '' },
  url: { url: 'https://' },
  shortcut: { name: '' },
  keys: { key: '', mods: [] },
  text: { text: '' },
  media: { key: 'PLAY' },
};

const MEDIA_NAMES = {
  PLAY: 'Play / pause', NEXT: 'Next track', PREVIOUS: 'Previous track',
  FAST: 'Fast forward', REWIND: 'Rewind', SOUND_UP: 'Volume up',
  SOUND_DOWN: 'Volume down', MUTE: 'Mute', BRIGHTNESS_UP: 'Brightness up',
  BRIGHTNESS_DOWN: 'Brightness down', ILLUMINATION_UP: 'Key light up',
  ILLUMINATION_DOWN: 'Key light down',
};

const MOD_KEYS = [
  { mod: 'ctrl', glyph: '⌃', prop: 'ctrlKey' },
  { mod: 'alt', glyph: '⌥', prop: 'altKey' },
  { mod: 'shift', glyph: '⇧', prop: 'shiftKey' },
  { mod: 'cmd', glyph: '⌘', prop: 'metaKey' },
];

const state = {
  saved: null,  // keymap as on disk
  draft: null,  // keymap being edited
  colors: [],
  selected: 0,
  apps: null,
  shortcuts: null,
  appQuery: '',
  events: [],
  rev: -1,
  keymapRev: -1,
  lastEventId: 0,
  accessibility: true,
  online: true,
  keymapPath: '',
  mediaKeys: Object.keys(MEDIA_NAMES),
  recording: false,
  message: '',
};

// ── API ──────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Keybordy-Token': TOKEN, 'Content-Type': 'application/json' },
  });
  // A new token means Hammerspoon was set up again: the page has to reload.
  if (res.status === 401) location.reload();
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── DOM helper ───────────────────────────────────────────────────────────

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyDirty = (i) => !same(state.draft.keys[i], state.saved.keys[i]);
const anyDirty = () => state.draft && !same(state.draft, state.saved);

function describe(action) {
  switch (action.type) {
    case 'app': return action.app || 'no app';
    case 'terminal': return [action.command || 'shell', action.dir && `in ${action.dir}`].filter(Boolean).join(' ');
    case 'shell': return action.command || 'no command';
    case 'url': return action.url;
    case 'shortcut': return action.name || 'no shortcut';
    case 'keys': return comboText(action) || 'no keys';
    case 'text': return action.text ? `“${action.text.slice(0, 40)}”` : 'no text';
    case 'media': return MEDIA_NAMES[action.key] || action.key;
    default: return 'free';
  }
}

function comboText(a) {
  if (!a.key) return '';
  const mods = MOD_KEYS.filter((m) => a.mods.includes(m.mod)).map((m) => m.glyph).join('');
  return mods + (a.key.length === 1 ? a.key.toUpperCase() : a.key);
}

// ── Header status ────────────────────────────────────────────────────────

function renderStatus() {
  const el = document.getElementById('status');
  el.replaceChildren(
    state.online
      ? h('span', { className: 'chip chip--ok', title: 'Hammerspoon is serving this page' }, 'hammerspoon')
      : h('span', { className: 'chip chip--error' }, 'hammerspoon offline'),
    state.accessibility
      ? h('span', { className: 'chip chip--ok', title: 'Key combo, Type text and Media key can post events' }, 'accessibility')
      : h('button', {
          className: 'chip chip--warn',
          title: 'Key combo, Type text and Media key need it. Opens the macOS prompt.',
          onclick: () => api('/api/accessibility', { method: 'POST' }),
        }, 'accessibility off · allow'),
    h('span', { className: 'chip chip--plain', title: 'Saved keymap' }, state.keymapPath),
  );
}

// ── Caps ─────────────────────────────────────────────────────────────────

let capsPainted = false;

function renderCaps() {
  const el = document.getElementById('caps');
  el.classList.toggle('caps--enter', !capsPainted);
  capsPainted = true;
  el.replaceChildren(...state.draft.keys.map((k, i) => {
    const t = TYPE[k.action.type];
    const free = k.action.type === 'none';
    return h('div', { className: 'cap-slot', style: `--i:${i};--c:${state.colors[i]}` },
      h('button', {
        className: 'cap' + (i === state.selected ? ' cap--selected' : '') + (free ? ' cap--free' : ''),
        id: `cap-${i}`,
        title: `K${i + 1}: ${describe(k.action)}`,
        onclick: () => select(i),
      },
        h('div', { className: 'cap__row' },
          h('span', { className: 'cap__id' }, `K${i + 1}`),
          h('span', { className: 'cap__fkey' }, `F${13 + i}`)),
        h('div', { className: 'cap__body' },
          h('span', { className: 'cap__glyph' }, icon(t.type)),
          h('span', { className: 'cap__label' }, k.label || (free ? 'free' : describe(k.action)))),
        h('span', { className: 'cap__type' }, t.name),
        keyDirty(i) && h('span', { className: 'cap__dirty', title: 'unsaved' })),
      h('button', {
        className: 'cap__press',
        title: `Simulate a press of K${i + 1}` + (keyDirty(i) ? ' (runs the unsaved version)' : ''),
        'aria-label': `Press K${i + 1}`,
        onclick: () => press(i),
      }, '▶'));
  }));
}

// Lights a cap the way the key HUD does: pressed into its skirt, then back.
function hitCap(i, failed) {
  const cap = document.getElementById(`cap-${i}`);
  if (!cap) return;
  cap.classList.remove('cap--down', 'cap--failed');
  void cap.offsetWidth;
  cap.classList.add('cap--down');
  cap.classList.toggle('cap--failed', !!failed);
  clearTimeout(cap._t);
  cap._t = setTimeout(() => cap.classList.remove('cap--down', 'cap--failed'), 220);

  const sticker = document.getElementById('sticker');
  sticker.classList.remove('kbs-slap', 'kbs--done', 'kbs--error');
  void sticker.offsetWidth;
  sticker.classList.add(failed ? 'kbs--error' : 'kbs--done');
}

// ── Editor ───────────────────────────────────────────────────────────────

function select(i) {
  state.selected = i;
  state.recording = false;
  renderCaps();
  renderEditor();
}

function update(fn, { rerender = false } = {}) {
  const k = state.draft.keys[state.selected];
  fn(k);
  renderCaps();
  renderFoot();
  if (rerender) renderEditor();
  else document.getElementById('editor-hint').textContent = `${TYPE[k.action.type].name} · ${describe(k.action)}`;
}

function setAction(patch, opts) {
  update((k) => Object.assign(k.action, patch), opts);
}

// A div, not a label: a label would forward clicks on its blank space to
// the first button inside it.
function field(label, control, note) {
  return h('div', { className: 'field' },
    h('span', { className: 'field__label' }, label),
    control,
    note && h('span', { className: 'field__note' }, note));
}

function textInput(value, onInput, attrs = {}) {
  return h('input', {
    className: 'input' + (attrs.mono ? ' input--mono' : ''),
    value: value ?? '',
    spellcheck: false,
    placeholder: attrs.placeholder,
    oninput: (e) => onInput(e.target.value),
  });
}

const fieldsFor = {
  none: () => [h('p', { className: 'field__note' }, 'Pick an action above. A press on a free key shows a hint on screen.')],

  app(a) {
    if (!state.apps) {
      api('/api/apps').then((apps) => { state.apps = apps; renderEditor(); });
      return [field('App', h('div', { className: 'field__note' }, 'Loading installed apps…'))];
    }
    const note = h('span', { className: 'field__note' });
    const grid = h('div', { className: 'apps' });
    const fill = () => {
      const q = state.appQuery.toLowerCase();
      const list = state.apps.filter((x) => x.name.toLowerCase().includes(q));
      grid.replaceChildren(...list.map((x) => h('button', {
        className: 'app' + (x.path === a.path || (!a.path && x.name === a.app) ? ' app--on' : ''),
        title: x.path,
        onclick: () => setAction({ app: x.name, path: x.path }, { rerender: true }),
      }, h('img', { src: `/api/icon?path=${encodeURIComponent(x.path)}`, loading: 'lazy', alt: '' }), h('span', {}, x.name))));
      note.textContent = `${list.length} of ${state.apps.length} apps in /Applications, ~/Applications and /System/Applications.`;
    };
    fill();
    const search = textInput(state.appQuery, (v) => { state.appQuery = v; fill(); }, { placeholder: 'Search apps' });
    return [
      field('App', h('div', { className: 'row' }, search,
        h('span', { className: 'chip chip--plain' }, a.app || 'none chosen'))),
      h('div', { className: 'field' }, grid, note),
    ];
  },

  terminal: (a) => [
    field('Folder', textInput(a.dir, (v) => setAction({ dir: v }), { mono: true, placeholder: '~/personal/projects/keybordy' }), 'Where the new window starts. ~ is your home.'),
    field('Command', textInput(a.command, (v) => setAction({ command: v }), { mono: true, placeholder: 'claude' }),
      'Typed into the shell, so the window stays open when it exits. Empty just opens a shell.'),
  ],

  shell: (a) => [
    field('Command', h('textarea', {
      className: 'textarea', value: a.command, spellcheck: false,
      placeholder: 'osascript -e \'display notification "hi"\'',
      oninput: (e) => setAction({ command: e.target.value }),
    }), 'Runs with zsh -lc, so PATH and aliases match your terminal. Nothing opens; stdout and stderr show in Activity.'),
  ],

  url: (a) => [
    field('URL', textInput(a.url, (v) => setAction({ url: v }), { mono: true, placeholder: 'https://calendar.google.com' }),
      'Any scheme macOS knows: https://, mailto:, obsidian://, raycast://, x-apple.systempreferences:…'),
  ],

  shortcut(a) {
    if (!state.shortcuts) {
      api('/api/shortcuts').then((s) => { state.shortcuts = s; renderEditor(); });
    }
    const names = state.shortcuts || [];
    return [
      field('Shortcut', h('select', {
        className: 'select',
        onchange: (e) => setAction({ name: e.target.value }),
      }, h('option', { value: '', selected: !a.name }, names.length ? 'Choose a shortcut…' : 'Loading…'),
        names.map((n) => h('option', { value: n, selected: n === a.name }, n)),
        a.name && !names.includes(a.name) && h('option', { value: a.name, selected: true }, `${a.name} (not found)`)),
      'Runs `shortcuts run <name>`. Make new ones in the Shortcuts app, then reopen this key.'),
    ];
  },

  keys(a) {
    const rec = h('button', {
      className: 'btn btn--rec' + (state.recording ? ' btn--live' : ''),
      onclick: (e) => { e.preventDefault(); state.recording = !state.recording; renderEditor(); },
    }, state.recording ? '● press a combo…' : '● Record');
    const combo = a.key
      ? [...MOD_KEYS.filter((m) => a.mods.includes(m.mod)).map((m) => h('span', { className: 'kbd' }, m.glyph)),
         h('span', { className: 'kbd' }, a.key.length === 1 ? a.key.toUpperCase() : a.key)]
      : [h('span', { className: 'field__note' }, 'nothing yet')];
    return [
      field('Combo', h('div', { className: 'row' }, h('div', { className: 'combo' }, combo), rec),
        'Record catches most combos. The browser keeps a few (⌘Q, ⌘W, ⌘Tab); set those by hand below.'),
      field('By hand', h('div', { className: 'row' },
        h('div', { className: 'mods' }, MOD_KEYS.map((m) => h('button', {
          className: 'toggle' + (a.mods.includes(m.mod) ? ' toggle--on' : ''),
          title: m.mod,
          onclick: () => {
            const mods = a.mods.includes(m.mod) ? a.mods.filter((x) => x !== m.mod) : [...a.mods, m.mod];
            setAction({ mods }, { rerender: true });
          },
        }, m.glyph))),
        textInput(a.key, (v) => setAction({ key: v.toLowerCase() }), { mono: true, placeholder: 'key: a, 4, space, return, left, f5…' })),
        'Goes to whichever app is in front. A test from here types into this page.'),
    ];
  },

  text: (a) => [
    field('Text', h('textarea', {
      className: 'textarea', value: a.text,
      placeholder: 'Thanks, talk soon!',
      oninput: (e) => setAction({ text: e.target.value }),
    }), 'Typed into whichever app is in front. A test from here types into this page.'),
  ],

  media: (a) => [
    field('Key', h('div', { className: 'media' }, state.mediaKeys.map((k) => h('button', {
      className: 'toggle' + (a.key === k ? ' toggle--on' : ''),
      style: 'font: 500 11.5px/1 var(--font-sans)',
      onclick: () => setAction({ key: k }, { rerender: true }),
    }, MEDIA_NAMES[k] || k)))),
  ],
};

function renderEditor() {
  const i = state.selected;
  const k = state.draft.keys[i];
  const t = TYPE[k.action.type];
  const el = document.getElementById('editor');
  el.style.setProperty('--c', state.colors[i]);

  const types = h('div', { className: 'types' }, TYPES.map((x) => h('button', {
    className: 'type' + (x.type === k.action.type ? ' type--on' : ''),
    onclick: () => {
      if (x.type === k.action.type) return;
      update((key) => { key.action = { type: x.type, ...clone(DEFAULTS[x.type]) }; }, { rerender: true });
    },
  },
    h('span', { className: 'type__glyph' }, icon(x.type)),
    h('span', { className: 'type__name' }, x.name, x.access && h('span', { className: 'badge', title: 'Needs Accessibility permission for Hammerspoon' }, 'a11y')),
    h('span', { className: 'type__desc' }, x.desc))));

  el.replaceChildren(
    h('div', { className: 'panel__head editor__head' },
      h('span', { className: 'dot' }),
      h('span', {}, `K${i + 1} · F${13 + i}`),
      h('span', { className: 'panel__hint', id: 'editor-hint' }, `${t.name} · ${describe(k.action)}`)),
    h('div', { className: 'editor__body' },
      field('Label', textInput(k.label, (v) => update((key) => { key.label = v; }), { placeholder: 'Shown on the cap and in the alert' })),
      field('Action', types, t.access && !state.accessibility
        ? 'Hammerspoon needs Accessibility for this one: use “accessibility off · allow” at the top.'
        : null),
      ...fieldsFor[k.action.type](k.action)),
    h('div', { className: 'editor__foot', id: 'foot' }),
  );
  renderFoot();
}

function renderFoot() {
  const foot = document.getElementById('foot');
  if (!foot) return;
  const i = state.selected;
  const dirty = anyDirty();
  foot.replaceChildren(
    h('button', { className: 'btn', onclick: () => press(i), title: 'Runs this key’s action as shown here, saved or not' }, `▶ Test K${i + 1}`),
    h('span', { className: 'msg' }, state.message || (keyDirty(i) ? 'unsaved: the board still runs the saved version' : '')),
    h('span', { className: 'spacer' }),
    h('button', {
      className: 'btn', disabled: !dirty,
      onclick: () => { state.draft = clone(state.saved); state.message = ''; renderCaps(); renderEditor(); },
    }, 'Revert'),
    h('button', { className: 'btn btn--primary', disabled: !dirty, onclick: save }, 'Save ', h('kbd', {}, '⌘S')),
  );
}

// ── Actions ──────────────────────────────────────────────────────────────

async function save() {
  if (!anyDirty()) return;
  try {
    const { keymap } = await api('/api/keymap', { method: 'PUT', body: JSON.stringify(state.draft) });
    state.saved = keymap;
    state.draft = clone(keymap);
    flash('saved to ' + state.keymapPath);
  } catch (err) {
    flash('save failed: ' + err.message);
  }
  renderCaps();
  renderEditor();
}

// A simulated press goes through the same path as the board's F-key, with
// the draft action so unsaved edits can be tried.
async function press(i) {
  try {
    await api(`/api/press/${i + 1}`, { method: 'POST', body: JSON.stringify(state.draft.keys[i]) });
    poll();
  } catch (err) {
    flash('press failed: ' + err.message);
  }
}

let flashTimer;
function flash(msg) {
  state.message = msg;
  renderFoot();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { state.message = ''; renderFoot(); }, 2600);
}

// ── Activity ─────────────────────────────────────────────────────────────

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function renderLog() {
  const el = document.getElementById('log');
  if (!state.events.length) {
    el.replaceChildren(h('li', { className: 'log__empty' }, 'Press a key on the board, or ▶ on a cap.'));
    return;
  }
  el.replaceChildren(...[...state.events].reverse().map((ev) => {
    const status = ev.pending ? ['run', 'running'] : ev.ok ? ['ok', 'ok'] : ['fail', 'failed'];
    return h('li', { className: 'ev', style: `--c:${state.colors[ev.key - 1]}` },
      h('span', { className: 'ev__t' }, timeFmt.format(ev.t)),
      h('span', { className: 'ev__k' }, `K${ev.key}`),
      h('span', { className: 'ev__what' },
        h('span', { className: 'ev__src' + (ev.source === 'board' ? ' ev__src--board' : '') }, ev.source === 'board' ? 'board ' : 'sim '),
        [ev.label, TYPE[ev.type]?.name].filter(Boolean).join(' · ')),
      h('span', { className: `ev__st--${status[0]}` }, status[1]),
      ev.error && h('pre', { className: 'ev__detail ev__detail--error' }, ev.error),
      ev.output && h('pre', { className: 'ev__detail' }, ev.output.trimEnd()));
  }));
}

async function poll() {
  try {
    const data = await api('/api/events');
    if (!state.online) { state.online = true; renderStatus(); }
    if (data.accessibility !== state.accessibility) {
      state.accessibility = data.accessibility;
      renderStatus();
      renderEditor();
    }
    if (data.keymapRev !== state.keymapRev) {
      state.keymapRev = data.keymapRev;
      await reloadKeymap();
    }
    const newest = data.events.length ? data.events[data.events.length - 1].id : 0;
    if (data.rev === state.rev && newest === state.lastEventId) return;
    // Hammerspoon restarts its ids when it reloads.
    if (newest < state.lastEventId) state.lastEventId = 0;
    for (const ev of data.events) {
      if (ev.id > state.lastEventId) hitCap(ev.key - 1, ev.ok === false);
    }
    state.lastEventId = newest;
    state.rev = data.rev;
    state.events = data.events;
    renderLog();
  } catch {
    if (state.online) { state.online = false; renderStatus(); }
  }
}

// The keymap changed outside this page (keymap.json edited by hand, another
// tab). Unsaved edits win: they are only replaced when there are none.
async function reloadKeymap() {
  const s = await api('/api/state');
  if (same(s.keymap, state.saved)) return;
  const dirty = anyDirty();
  state.saved = s.keymap;
  if (!dirty) state.draft = clone(s.keymap);
  renderCaps();
  renderEditor();
  flash(dirty ? 'keymap.json changed on disk; Save overwrites it' : 'reloaded keymap.json');
}

// ── Keyboard ─────────────────────────────────────────────────────────────

// e.code is the physical key, so the recorder works on any layout for
// letters and digits.
function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  return {
    Space: 'space', Enter: 'return', Tab: 'tab', Escape: 'escape', Backspace: 'delete',
    Delete: 'forwarddelete', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up',
    ArrowDown: 'down', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  }[code];
}

document.addEventListener('keydown', (e) => {
  if (state.recording) {
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    e.preventDefault();
    const key = codeToKey(e.code);
    if (!key) { flash(`can't record ${e.code}`); return; }
    state.recording = false;
    setAction({ key, mods: MOD_KEYS.filter((m) => e[m.prop]).map((m) => m.mod) }, { rerender: true });
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (anyDirty()) e.preventDefault();
});

// ── Boot ─────────────────────────────────────────────────────────────────

async function boot() {
  const s = await api('/api/state');
  state.saved = s.keymap;
  state.draft = clone(s.keymap);
  state.colors = s.colors;
  state.accessibility = s.accessibility;
  state.keymapPath = s.keymapPath;
  state.mediaKeys = s.mediaKeys;
  state.events = s.events;
  state.rev = s.rev;
  state.keymapRev = s.keymapRev;
  state.lastEventId = s.events.length ? s.events[s.events.length - 1].id : 0;
  renderStatus();
  renderCaps();
  renderEditor();
  renderLog();
  setInterval(poll, 400);
}

boot().catch((err) => {
  document.getElementById('editor').replaceChildren(
    h('div', { className: 'editor__body' }, h('p', { className: 'field__note' }, `Could not load the keymap: ${err.message}`)));
});
