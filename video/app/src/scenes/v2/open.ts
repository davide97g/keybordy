// v2 cold open: as v1, but the first click gets no sticker (it lands in the dark on the sound and the
// light that swells with it); the stickers start with the montage.
import Open from '../open';
export default class OpenV2 extends Open { override clicks() { return false; } }
