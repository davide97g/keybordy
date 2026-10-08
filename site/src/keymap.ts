// The example keymap the page shows (the same one as the concept render and the trailer). The real map
// lives on the Mac in ~/.config/keybordy/keymap.json; the caps only carry their K number.
export type ActionType = 'terminal' | 'app' | 'url' | 'media' | 'keys' | 'shortcut' | 'shell' | 'layer' | 'voice';

export const MAP: Record<string, [label: string, type: ActionType, detail: string]> = {
  K1: ['CLAUDE', 'terminal', 'claude'], K2: ['NOTES', 'app', 'Notes'], K3: ['TERM', 'terminal', '~'],
  K4: ['CODE', 'app', 'VS Code'], K5: ['WEB', 'url', 'localhost'], K6: ['MAIL', 'app', 'Mail'],
  K7: ['SLACK', 'app', 'Slack'], K8: ['MEET', 'url', 'meet.new'], K9: ['MUSIC', 'media', 'play'],
  K10: ['SHOT', 'keys', '⇧⌘4'], K11: ['CLIP', 'app', 'Clipboard'], K12: ['LOCK', 'keys', '⌃⌘Q'],
  K13: ['◀ DESK', 'keys', '⌃←'], K14: ['DESK ▶', 'keys', '⌃→'], K15: ['MUTE', 'media', 'mute'],
  K16: ['DND', 'shortcut', 'Focus'], K17: ['TIMER', 'shortcut', '25 min'], K18: ['SLEEP', 'shell', 'pmset'],
  K19: ['LAYER', 'layer', 'next'], K20: ['FN', 'layer', 'hold'], K21: ['TALK', 'voice', 'push to talk'], K22: ['ENTER', 'keys', '↩'],
};

/** label and "type › detail", as the OLED shows them */
export const ACTIONS: Record<string, [string, string]> = Object.fromEntries(
  Object.entries(MAP).map(([id, [label, type, detail]]) => [id, [label, `${type} › ${detail}`]]),
);

export const TYPES: { id: ActionType; name: string }[] = [
  { id: 'app', name: 'Open app' }, { id: 'terminal', name: 'Terminal' }, { id: 'shell', name: 'Shell' },
  { id: 'url', name: 'URL' }, { id: 'shortcut', name: 'Shortcut' }, { id: 'keys', name: 'Keystrokes' },
  { id: 'media', name: 'Media' }, { id: 'layer', name: 'Layer' }, { id: 'voice', name: 'Voice' },
];

/** Keyboard keys that press a cap on the page: rows of six, then the bottom row (space is the talk bar). */
export const KEYBOARD: Record<string, string> = {
  Digit1: 'K1', Digit2: 'K2', Digit3: 'K3', Digit4: 'K4', Digit5: 'K5', Digit6: 'K6',
  KeyQ: 'K7', KeyW: 'K8', KeyE: 'K9', KeyR: 'K10', KeyT: 'K11', KeyY: 'K12',
  KeyA: 'K13', KeyS: 'K14', KeyD: 'K15', KeyF: 'K16', KeyG: 'K17', KeyH: 'K18',
  KeyZ: 'K19', KeyX: 'K20', Space: 'K21', KeyC: 'K22', Enter: 'K22',
};
