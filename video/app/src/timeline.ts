// The edit: scene windows come from the cue sheet (data/cues.json), so they sit on the music's beats.
import type { TimelineEntry } from './engine/engine';
import type { SceneClass } from './engine/scene';
import type { AudioData } from './engine/audio';
import { CUES } from './cues';
import { VERSION } from './version';

const modules = import.meta.glob<{ default: SceneClass }>(['./scenes/*.ts', './scenes/v*/*.ts']);
// the newest version's scene file wins: scenes/v3/<id>.ts over scenes/v2/<id>.ts over scenes/<id>.ts
const scene = (name: string) => () => {
  let m = modules[`./scenes/${name}.ts`];
  for (let v = 2; v <= VERSION; v++) m = modules[`./scenes/v${v}/${name}.ts`] ?? m;
  return m ? m() : Promise.reject(new Error(`scene module not found: scenes/${name}.ts`));
};

export function makeTimeline(_au: AudioData): TimelineEntry[] {
  return CUES.scenes.map((s) => ({ id: s.id, load: scene(s.id), start: s.start, end: s.end }));
}
