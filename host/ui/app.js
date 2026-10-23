// keybordy keymap editor. Talks to host/hammerspoon/keybordy_web.lua: loads
// the keymap, saves it whole, simulates presses and polls the activity log.
// A slot is anything with an action: "K1".."K22" and "E2.ccw"/"E2.cw"/"E2.push"
// (E3 too). K21, the talk bar, has the voice settings instead; K20 replays the
// last answer on the board and has nothing to set.

const TOKEN = document.querySelector('meta[name="keybordy-token"]').content;
const TURNS = [
  { turn: 'ccw', glyph: '↺', name: 'Turn left' },
  { turn: 'push', glyph: '●', name: 'Push' },
  { turn: 'cw', glyph: '↻', name: 'Turn right' },
];
const TURN = Object.fromEntries(TURNS.map((t) => [t.turn, t]));

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
  voice: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/>',
  replay: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
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
  layout: null,   // MP keys and encoders from layout/macropad.json
  combos: {},     // slot id -> {mods, key} the board taps
  talkKey: 'K21',
  replayKey: 'K20',
  confirmKeys: { yes: 'K22', no: 'K19' },
  voice: { state: '', log: [] },
  selected: 'K1',
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
const anyDirty = () => state.draft && !same(state.draft, state.saved);

// The keymap entry ({label, action}) for a slot id.
function entry(km, id) {
  const k = id.match(/^K(\d+)$/);
  if (k) return km.keys[k[1] - 1];
  const [enc, turn] = id.split('.');
  return km.knobs[enc][turn];
}

const isTalk = (id) => id === state.talkKey;
const isReplay = (id) => id === state.replayKey;
const isFixed = (id) => isTalk(id) || isReplay(id);   // the board handles these, no action
// K22/K19 answer Claude's yes/no questions on the board, and run their action the rest of the time.
const confirmOf = (id) => id === state.confirmKeys.yes ? 'yes' : id === state.confirmKeys.no ? 'no' : null;
const keyDirty = (id) => isTalk(id) ? !same(state.draft.voice, state.saved.voice)
  : isReplay(id) ? false : !same(entry(state.draft, id), entry(state.saved, id));

function colorOf(id) {
  const enc = state.layout?.encoders.find((e) => id.startsWith(e.id + '.'));
  if (enc) return enc.color;
  return state.layout?.keys.find((k) => k.id === id)?.color || '#d6ff1f';
}

// "⇧F13" for the combo the board taps for a slot.
function comboOf(id) {
  const c = state.combos[id];
  if (!c) return '';
  const glyph = { shift: '⇧', ctrl: '⌃', alt: '⌥', cmd: '⌘' };
  return c.mods.map((m) => glyph[m]).join('') + c.key.toUpperCase();
}

function slotName(id) {
  const [enc, turn] = id.split('.');
  return turn ? `${enc} ${TURN[turn].glyph} ${TURN[turn].name.toLowerCase()}` : id;
}

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

// ── Board ────────────────────────────────────────────────────────────────

let capsPainted = false;

// The talk bar and the replay key are drawn the same way: the board handles them.
const FIXED = {
  talk: { type: 'voice', name: 'Voice', label: 'Talk to Claude', tag: 'hold', title: 'hold to talk to Claude' },
  replay: { type: 'replay', name: 'Voice', label: 'Replay answer', tag: 'tap', title: 'says the last answer again' },
};

function capButton(id, k, extra = {}) {
  const fixed = isTalk(id) ? FIXED.talk : isReplay(id) ? FIXED.replay : null;
  const t = fixed || TYPE[k.action.type];
  const free = !fixed && k.action.type === 'none';
  return h('button', {
    className: 'cap' + (id === state.selected ? ' cap--selected' : '') + (free ? ' cap--free' : '') + (extra.wide ? ' cap--wide' : ''),
    id: `cap-${id}`,
    title: fixed ? `${id}: ${fixed.title}` : `${slotName(id)}: ${describe(k.action)}`,
    onclick: () => select(id),
  },
    h('div', { className: 'cap__row' },
      h('span', { className: 'cap__id' }, extra.short || id),
      h('span', { className: 'cap__fkey' }, fixed ? fixed.tag : comboOf(id))),
    h('div', { className: 'cap__body' },
      h('span', { className: 'cap__glyph' }, icon(t.type)),
      h('span', { className: 'cap__label' }, fixed ? fixed.label : k.label || (free ? 'free' : describe(k.action)))),
    h('span', { className: 'cap__type' }, t.name),
    confirmOf(id) && h('span', { className: 'cap__confirm', title: `answers ${confirmOf(id)} when Claude asks` }, confirmOf(id)),
    keyDirty(id) && h('span', { className: 'cap__dirty', title: 'unsaved' }));
}

function pressButton(id) {
  return h('button', {
    className: 'cap__press',
    title: `Simulate ${slotName(id)}` + (keyDirty(id) ? ' (runs the unsaved version)' : ''),
    'aria-label': `Press ${slotName(id)}`,
    onclick: () => press(id),
  }, '▶');
}

// A knob: its id on a round cap, then one small cap per turn and the push.
function knob(enc, i) {
  if (enc.id === 'E1') {
    return h('div', { className: 'knob knob--fixed', style: `--i:${i};--c:var(--wb-9)` },
      h('div', { className: 'knob__dial' }, 'E1'),
      h('ul', { className: 'knob__fixed' },
        h('li', {}, '↺ ↻ speaker volume'),
        h('li', {}, '● tap: new Claude session'),
        h('li', {}, '● hold 2 s: power off')));
  }
  return h('div', { className: 'knob', style: `--i:${i};--c:${enc.color}` },
    h('div', { className: 'knob__dial' }, enc.id),
    h('div', { className: 'knob__turns' }, TURNS.map((t) => {
      const id = `${enc.id}.${t.turn}`;
      return h('div', { className: 'cap-slot', style: `--c:${enc.color}` },
        capButton(id, entry(state.draft, id), { short: `${enc.id} ${t.glyph}` }), pressButton(id));
    })));
}

function renderCaps() {
  const el = document.getElementById('caps');
  el.classList.toggle('caps--enter', !capsPainted);
  capsPainted = true;
  const top = Math.min(...state.layout.keys.map((k) => k.y));
  el.replaceChildren(
    h('div', { className: 'mp__top' },
      h('div', { className: 'mp__oled' },
        h('span', {}, 'keybordy MP'),
        h('span', { className: 'mp__oled-sub' }, state.voice.state === 'running' ? 'voice ready' : `voice ${state.voice.state || '…'}`)),
      state.layout.encoders.map(knob)),
    h('div', { className: 'mp__keys' }, state.layout.keys.map((k, i) => {
      const id = k.id;
      return h('div', {
        className: 'cap-slot',
        style: `--i:${i};--c:${k.color};grid-column:${k.x * 2 + 1} / span ${k.w * 2};grid-row:${k.y - top + 1}`,
      }, capButton(id, entry(state.draft, id), { wide: k.w > 1 }), !isFixed(id) && pressButton(id));
    })));
}

// Lights a cap the way the key HUD does: pressed into its skirt, then back.
function hitCap(id, failed) {
  const cap = document.getElementById(`cap-${id}`);
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

function select(id) {
  state.selected = id;
  state.recording = false;
  renderCaps();
  renderEditor();
}

function update(fn, { rerender = false } = {}) {
  const k = entry(state.draft, state.selected);
  fn(k);
  scheduleSave();
  renderCaps();
  renderFoot();
  if (rerender) renderEditor();
  else document.getElementById('editor-hint').textContent = `${TYPE[k.action.type].name} · ${describe(k.action)}`;
}

function setVoice(patch) {
  Object.assign(state.draft.voice, patch);
  scheduleSave();
  renderCaps();
  renderFoot();
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
  const id = state.selected;
  const el = document.getElementById('editor');
  el.style.setProperty('--c', colorOf(id));
  if (isTalk(id)) return renderVoice(el);
  if (isReplay(id)) return renderReplay(el);
  const k = entry(state.draft, id);
  const t = TYPE[k.action.type];

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
      h('span', {}, `${slotName(id)} · ${comboOf(id)}`),
      h('span', { className: 'panel__hint', id: 'editor-hint' }, `${t.name} · ${describe(k.action)}`)),
    h('div', { className: 'editor__body' },
      confirmOf(id) && h('p', { className: 'field__note note--confirm' },
        `When Claude asks a yes or no question (the pad shows YES/NO?), this key answers “${confirmOf(id)}” on the board. `,
        'The rest of the time it runs the action below.'),
      field('Label', textInput(k.label, (v) => update((key) => { key.label = v; }), { placeholder: 'Shown on the cap and in the alert' })),
      field('Action', types, t.access && !state.accessibility
        ? 'Hammerspoon needs Accessibility for this one: use “accessibility off · allow” at the top.'
        : null),
      ...fieldsFor[k.action.type](k.action)),
    h('div', { className: 'editor__foot', id: 'foot' }),
  );
  renderFoot();
}

// K21: the talk bar's settings, read by host/voice.py on every take.
function renderVoice(el) {
  const v = state.draft.voice;
  const running = state.voice.state === 'running';
  el.replaceChildren(
    h('div', { className: 'panel__head editor__head' },
      h('span', { className: 'dot' }),
      h('span', {}, `${state.talkKey} · talk to Claude`),
      h('span', { className: 'panel__hint' }, 'hold the bar, talk, let go')),
    h('div', { className: 'editor__body' },
      h('p', { className: 'field__note' },
        'The take goes over Wi-Fi to host/voice.py: Echo transcribes it, claude -p answers in the folder below, ',
        'and Echo speaks the answer in the chosen voice on the pad. One session carries on between takes; ',
        'tap E1 for a new one. Holding the bar again stops an answer. The answer scrolls on the display while it is spoken; ',
        'when Claude needs a yes or no, K22 answers yes and K19 no.'),
      field('Service', h('div', { className: 'row' },
        h('span', { className: 'chip ' + (running ? 'chip--ok' : 'chip--warn') }, `voice.py ${state.voice.state || '…'}`),
        h('button', { className: 'btn', onclick: restartVoice }, 'Restart'))),
      field('Folder', textInput(v.dir, (x) => setVoice({ dir: x }), { mono: true, placeholder: '~' }),
        'Where claude -p runs: its CLAUDE.md and files are what it sees. A new folder starts a new session.'),
      field('Tools', textInput(v.tools, (x) => setVoice({ tools: x }), { mono: true, placeholder: 'Read,Glob,Grep,WebSearch,WebFetch' }),
        'Allowed without asking, comma separated. Bash, Edit, Write and NotebookEdit stay blocked unless listed here (Bash(git log:*) works too).'),
      field('Model', textInput(v.model, (x) => setVoice({ model: x }), { mono: true, placeholder: 'your default (sonnet, haiku, opus…)' }),
        'Empty uses your Claude Code default. A smaller model answers sooner.'),
      h('div', { className: 'row row--fields' },
        field('Voice', textInput(v.voice, (x) => setVoice({ voice: x }), { mono: true, placeholder: 'me' }), 'An Echo voice id.'),
        field('Language', textInput(v.language, (x) => setVoice({ language: x }), { mono: true, placeholder: 'it' }), 'What you speak: it, en, auto.')),
      field('Instructions', h('textarea', {
        className: 'textarea', value: v.prompt, spellcheck: false,
        placeholder: 'Extra system prompt, e.g. “Call me Davide. Keep it under 20 words.”',
        oninput: (e) => setVoice({ prompt: e.target.value }),
      }), 'Added to the spoken-answer prompt (short sentences, no markdown).'),
      field('Log', h('pre', { className: 'voice-log', id: 'voice-log' }, state.voice.log.slice(-14).join('\n') || 'nothing yet'))),
    h('div', { className: 'editor__foot', id: 'foot' }),
  );
  renderFoot();
}

// K20: nothing to set, only what it does.
function renderReplay(el) {
  el.replaceChildren(
    h('div', { className: 'panel__head editor__head' },
      h('span', { className: 'dot' }),
      h('span', {}, `${state.replayKey} · replay answer`),
      h('span', { className: 'panel__hint' }, 'tap')),
    h('div', { className: 'editor__body' },
      h('p', { className: 'field__note' },
        'Says Claude’s last spoken answer again on the pad, straight from its memory, with the text scrolling. After a restart, when the pad has none, ',
        'it asks voice.py, which keeps the last answer on disk. Tap it while it talks to stop.'),
      h('p', { className: 'field__note' }, 'It is handled on the board, so it sends nothing to the Mac and has no action to set.')),
    h('div', { className: 'editor__foot', id: 'foot' }),
  );
  renderFoot();
}

async function restartVoice() {
  try {
    await api('/api/voice/restart', { method: 'POST' });
    flash('restarting voice.py');
  } catch (err) {
    flash('restart failed: ' + err.message);
  }
}

// Edits save themselves: the foot only tests the slot and says where saving is.
function renderFoot() {
  const foot = document.getElementById('foot');
  if (!foot) return;
  const id = state.selected;
  const saving = anyDirty();
  foot.replaceChildren(...[
    !isFixed(id) && h('button', { className: 'btn', onclick: () => press(id), title: 'Runs this action now (↵)' }, `▶ Test ${id}`),
    h('span', { className: 'spacer' }),
    h('span', { className: 'msg' + (state.message ? '' : saving ? ' msg--saving' : ' msg--saved') },
      state.message || (saving ? 'saving…' : '✓ saved')),
  ].filter(Boolean));
}

// ── Actions ──────────────────────────────────────────────────────────────

// The editor is not re-rendered after a save, so a field being typed in keeps its focus.
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

async function save() {
  clearTimeout(saveTimer);
  if (!anyDirty()) return;
  const sent = clone(state.draft);
  try {
    const { keymap } = await api('/api/keymap', { method: 'PUT', body: JSON.stringify(sent) });
    state.saved = keymap;
    if (same(state.draft, sent)) state.draft = clone(keymap);  // nothing typed meanwhile
  } catch (err) {
    flash('save failed: ' + err.message);
  }
  renderCaps();
  renderFoot();
}

// A simulated press goes through the same path as the board's F-key, with
// the draft action so unsaved edits can be tried.
async function press(id) {
  try {
    await api(`/api/press/${id}`, { method: 'POST', body: JSON.stringify(entry(state.draft, id)) });
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
    return h('li', { className: 'ev', style: `--c:${colorOf(String(ev.key))}` },
      h('span', { className: 'ev__t' }, timeFmt.format(ev.t)),
      h('span', { className: 'ev__k' }, String(ev.key).replace('.', ' ')),
      h('span', { className: 'ev__what' },
        h('span', { className: 'ev__src' + (ev.source === 'board' ? ' ev__src--board' : '') }, ev.source === 'board' ? 'board ' : 'sim '),
        [ev.label, ev.type === 'voice' ? 'Voice' : TYPE[ev.type]?.name].filter(Boolean).join(' · ')),
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
    if (data.voice && !same(data.voice, state.voice)) {
      const changedState = data.voice.state !== state.voice.state;
      state.voice = data.voice;
      if (changedState) renderCaps();
      if (isTalk(state.selected)) {
        if (changedState) renderEditor();
        else {
          const log = document.getElementById('voice-log');
          if (log) log.textContent = state.voice.log.slice(-14).join('\n') || 'nothing yet';
        }
      }
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
      if (ev.id > state.lastEventId) hitCap(String(ev.key), ev.ok === false);
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
    return;
  }
  // ← → walk the slots in board order, ↵ tests the selected one, unless a field has focus.
  const tag = document.activeElement?.tagName;
  if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  const order = slotOrder();
  const at = order.indexOf(state.selected);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    select(order[(at + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]);
    document.getElementById(`cap-${state.selected}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else if (e.key === 'Enter' && tag !== 'BUTTON' && !isFixed(state.selected)) {
    e.preventDefault();
    press(state.selected);
  }
});

// Knob slots first (they sit on top of the board), then the keys row by row.
function slotOrder() {
  const knobs = state.layout.encoders.filter((e) => e.id !== 'E1').flatMap((e) => TURNS.map((t) => `${e.id}.${t.turn}`));
  return [...knobs, ...state.layout.keys.map((k) => k.id)];
}

window.addEventListener('beforeunload', (e) => {
  if (anyDirty()) { save(); e.preventDefault(); }
});
// The Mac app (host/app) saves what is pending before it quits.
window.keybordyDirty = () => { if (anyDirty()) save(); return !!anyDirty(); };

// ── Boot ─────────────────────────────────────────────────────────────────

// Inside the Mac app (host/app loads /?app=1) the window's title bar is the header, so the status
// chips move to a status bar at the bottom.
if (new URLSearchParams(location.search).has('app')) {
  document.documentElement.dataset.app = '';
  document.getElementById('statusbar').append(document.getElementById('status'));
}

async function boot() {
  const s = await api('/api/state');
  state.saved = s.keymap;
  state.draft = clone(s.keymap);
  state.layout = s.layout;
  state.combos = s.combos;
  state.talkKey = s.talkKey;
  state.replayKey = s.replayKey || state.replayKey;
  state.confirmKeys = s.confirmKeys || state.confirmKeys;
  state.voice = s.voice || state.voice;
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
