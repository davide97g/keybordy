# Credits: third-party media

Everything in `video/public/vendor/` is downloaded by `video/scripts/fetch_vendor.sh` (curl, same URLs as below) and is not committed. Paths are relative to `video/public/vendor/`.

Licenses used:

- **Pixabay Content License**: https://pixabay.com/service/license-summary/ (full terms: https://pixabay.com/service/terms/). Free for commercial use in a video, no attribution required, no payment. It does not allow redistributing the files on their own (sold or given away unchanged), which is one more reason to keep them out of git. Files from the `freesound_community` account are Freesound uploads that Pixabay redistributes under its Content License.
- **CC0 1.0**: https://creativecommons.org/publicdomain/zero/1.0/. No conditions.
- **MIT**: https://opensource.org/license/mit. Keep the copyright notice and permission text with copies of the files. The text is in `clicks/kbsim-LICENSE.txt`.

None of the kept files needs on-screen credit. The optional credit lines are at the end of this file.

## music/

| File | Title | Author | Source page | Direct URL | License |
|---|---|---|---|---|---|
| `music/audioatlant-total-war-epic-action-cinematic-trailer-main-513668.mp3` | Total War (Epic Action Cinematic Trailer Main) | AudioAtlant | https://pixabay.com/music/adventure-total-war-epic-action-cinematic-trailer-main-513668/ | https://cdn.pixabay.com/download/audio/2026/04/10/audio_8470cb423f.mp3?filename=audioatlant-total-war-epic-action-cinematic-trailer-main-513668.mp3 | Pixabay Content License |
| `music/epic-hollywood-trailer-9489.mp3` | Epic Hollywood Trailer | Good_B_Music | https://pixabay.com/music/main-title-epic-hollywood-trailer-9489/ | https://cdn.pixabay.com/download/audio/2021/10/15/audio_2320f2b0bc.mp3?filename=epic-hollywood-trailer-9489.mp3 | Pixabay Content License |
| `music/kulakovka-epic-trailer-277924.mp3` | Epic Trailer | Kulakovka | https://pixabay.com/music/main-title-epic-trailer-277924/ | https://cdn.pixabay.com/download/audio/2024/12/18/audio_deb1acb832.mp3?filename=kulakovka-epic-trailer-277924.mp3 | Pixabay Content License |

## clicks/

Key switch samples come from kbsim by Thomas Lai (https://github.com/tplai/kbsim), MIT, pinned to commit `ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4`. Each switch folder has five press variations (`press/GENERIC_R0..R4.mp3`, all different), `press/SPACE.mp3`, `press/ENTER.mp3`, `release/GENERIC.mp3` and `release/SPACE.mp3`. The direct URL pattern is `https://raw.githubusercontent.com/tplai/kbsim/ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4/src/assets/audio/<switch>/<press|release>/<NAME>.mp3`.

| File | Title | Author | Source page | Direct URL | License |
|---|---|---|---|---|---|
| `clicks/kbsim-holypanda/{press,release}/*.mp3` | Holy Panda (tactile) | Thomas Lai (kbsim) | https://github.com/tplai/kbsim/tree/ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4/src/assets/audio/holypanda | pattern above, `<switch>` = `holypanda` | MIT, `clicks/kbsim-LICENSE.txt` |
| `clicks/kbsim-cream/{press,release}/*.mp3` | NovelKeys Cream (linear) | Thomas Lai (kbsim) | https://github.com/tplai/kbsim/tree/ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4/src/assets/audio/cream | pattern above, `<switch>` = `cream` | MIT |
| `clicks/kbsim-mxbrown/{press,release}/*.mp3` | Cherry MX Brown | Thomas Lai (kbsim) | https://github.com/tplai/kbsim/tree/ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4/src/assets/audio/mxbrown | pattern above, `<switch>` = `mxbrown` | MIT |
| `clicks/kbsim-LICENSE.txt` | kbsim license text | Thomas Lai | https://github.com/tplai/kbsim/blob/ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4/LICENSE.md | https://raw.githubusercontent.com/tplai/kbsim/ba103f3b0afa9dab80447aa2e7e2ed80b6bd80e4/LICENSE.md | MIT |
| `clicks/mechanical-keyboard-sounds-gaming-on-a-keyboard-17149.mp3` | Mechanical Keyboard Sounds: Gaming on a keyboard | Pixabay | https://pixabay.com/sound-effects/mechanical-keyboard-sounds-gaming-on-a-keyboard-17149/ | https://cdn.pixabay.com/download/audio/2022/02/07/audio_7e77288571.mp3?filename=mechanical-keyboard-sounds-gaming-on-a-keyboard-17149.mp3 | Pixabay Content License |
| `clicks/knob/rachet-click-47834.mp3` | Rachet click | freesound_community | https://pixabay.com/sound-effects/rachet-click-47834/ | https://cdn.pixabay.com/download/audio/2022/03/10/audio_dd77c0b450.mp3?filename=rachet-click-47834.mp3 | Pixabay Content License |
| `clicks/knob/freesound_community-ratchet-88147.mp3` | ratchet | freesound_community | https://pixabay.com/sound-effects/film-special-effects-ratchet-88147/ | https://cdn.pixabay.com/download/audio/2022/03/15/audio_53a0579ebe.mp3?filename=freesound_community-ratchet-88147.mp3 | Pixabay Content License |
| `clicks/knob/kenney-ui-switch13.ogg` | UI Audio: switch13 | Kenney | https://kenney.nl/assets/ui-audio | https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip (member `Audio/switch13.ogg`) | CC0 1.0 |
| `clicks/knob/kenney-ui-switch14.ogg` | UI Audio: switch14 | Kenney | https://kenney.nl/assets/ui-audio | same zip, `Audio/switch14.ogg` | CC0 1.0 |
| `clicks/knob/kenney-ui-click4.ogg` | UI Audio: click4 | Kenney | https://kenney.nl/assets/ui-audio | same zip, `Audio/click4.ogg` | CC0 1.0 |
| `clicks/knob/kenney-ui-click5.ogg` | UI Audio: click5 | Kenney | https://kenney.nl/assets/ui-audio | same zip, `Audio/click5.ogg` | CC0 1.0 |
| `clicks/knob/kenney-ui-switch19.ogg` | UI Audio: switch19 (8 quick ticks) | Kenney | https://kenney.nl/assets/ui-audio | same zip, `Audio/switch19.ogg` | CC0 1.0 |

## sfx/

| File | Title | Author | Source page | Direct URL | License |
|---|---|---|---|---|---|
| `sfx/ascent-sub-boom-cinematic-trailer-sound-effect-222265.mp3` | ASCENT Sub Boom, Cinematic Trailer Sound Effect | VIRALAUDIO | https://pixabay.com/sound-effects/ascent-sub-boom-cinematic-trailer-sound-effect-222265/ | https://cdn.pixabay.com/download/audio/2024/07/05/audio_8110b93280.mp3?filename=ascent-sub-boom-cinematic-trailer-sound-effect-222265.mp3 | Pixabay Content License |
| `sfx/descent-sub-boom-massive-cinematic-sound-effect-405929.mp3` | DESCENT Sub Boom, Massive Cinematic Sound Effect | VIRALAUDIO | https://pixabay.com/sound-effects/descent-sub-boom-massive-cinematic-sound-effect-405929/ | https://cdn.pixabay.com/download/audio/2025/09/17/audio_446287d8a4.mp3?filename=descent-sub-boom-massive-cinematic-sound-effect-405929.mp3 | Pixabay Content License |
| `sfx/ascent-braam-magma-brass-d-cinematic-trailer-sound-effect-222269.mp3` | ASCENT Braam - Magma Brass (D) | VIRALAUDIO | https://pixabay.com/sound-effects/ascent-braam-magma-brass-d-cinematic-trailer-sound-effect-222269/ | https://cdn.pixabay.com/download/audio/2024/07/05/audio_923e4d8360.mp3?filename=ascent-braam-magma-brass-d-cinematic-trailer-sound-effect-222269.mp3 | Pixabay Content License |
| `sfx/deep-braam-trailer-228761.mp3` | deep braam trailer | LazyChillZone | https://pixabay.com/sound-effects/deep-braam-trailer-228761/ | https://cdn.pixabay.com/download/audio/2024/07/31/audio_f457629235.mp3?filename=deep-braam-trailer-228761.mp3 | Pixabay Content License |
| `sfx/ascent-riser-cover-the-basics-cinematic-trailer-sound-effect-222278.mp3` | ASCENT Riser - Cover The Basics | VIRALAUDIO | https://pixabay.com/sound-effects/ascent-riser-cover-the-basics-cinematic-trailer-sound-effect-222278/ | https://cdn.pixabay.com/download/audio/2024/07/05/audio_c346b5df7f.mp3?filename=ascent-riser-cover-the-basics-cinematic-trailer-sound-effect-222278.mp3 | Pixabay Content License |
| `sfx/descent-riser-cinematic-sound-effect-405926.mp3` | DESCENT Riser, Cinematic Sound Effect | VIRALAUDIO | https://pixabay.com/sound-effects/descent-riser-cinematic-sound-effect-405926/ | https://cdn.pixabay.com/download/audio/2025/09/17/audio_d0a4787ba8.mp3?filename=descent-riser-cinematic-sound-effect-405926.mp3 | Pixabay Content License |
| `sfx/ascent-whoosh-cinematic-sound-effect-222266.mp3` | ASCENT Whoosh, Cinematic Sound Effect | VIRALAUDIO | https://pixabay.com/sound-effects/ascent-whoosh-cinematic-sound-effect-222266/ | https://cdn.pixabay.com/download/audio/2024/07/05/audio_5add671d21.mp3?filename=ascent-whoosh-cinematic-sound-effect-222266.mp3 | Pixabay Content License |
| `sfx/universfield-boom-swoosh-454825.mp3` | Boom Swoosh | Universfield | https://pixabay.com/sound-effects/boom-swoosh-454825/ | https://cdn.pixabay.com/download/audio/2025/12/21/audio_32bcdab697.mp3?filename=universfield-boom-swoosh-454825.mp3 | Pixabay Content License |
| `sfx/oxidvideos-paper-slide-short-478835.mp3` | Paper slide - Short | OxidVideos | https://pixabay.com/sound-effects/film-special-effects-paper-slide-short-478835/ | https://cdn.pixabay.com/download/audio/2026/02/03/audio_5d6c980794.mp3?filename=oxidvideos-paper-slide-short-478835.mp3 | Pixabay Content License |
| `sfx/floraphonic-cartoon-slap-2-189831.mp3` | Cartoon Slap 2 | floraphonic | https://pixabay.com/sound-effects/film-special-effects-cartoon-slap-2-189831/ | https://cdn.pixabay.com/download/audio/2024/02/06/audio_a35aec4cb2.mp3?filename=floraphonic-cartoon-slap-2-189831.mp3 | Pixabay Content License |
| `sfx/freesound_community-paper-fold-31416.mp3` | Paper Fold | freesound_community | https://pixabay.com/sound-effects/household-paper-fold-31416/ | https://cdn.pixabay.com/download/audio/2022/03/10/audio_8456e4327d.mp3?filename=freesound_community-paper-fold-31416.mp3 | Pixabay Content License |
| `sfx/beep-125033.mp3` | Beep | emircanalp | https://pixabay.com/sound-effects/beep-125033/ | https://cdn.pixabay.com/download/audio/2022/11/04/audio_9ff1118f72.mp3?filename=beep-125033.mp3 | Pixabay Content License |
| `sfx/kenney-confirmation_001.ogg` | Interface Sounds: confirmation_001 | Kenney | https://kenney.nl/assets/interface-sounds | https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip (member `Audio/confirmation_001.ogg`) | CC0 1.0 |
| `sfx/kenney-confirmation_002.ogg` | Interface Sounds: confirmation_002 | Kenney | https://kenney.nl/assets/interface-sounds | same zip, `Audio/confirmation_002.ogg` | CC0 1.0 |
| `sfx/kenney-select_001.ogg` | Interface Sounds: select_001 | Kenney | https://kenney.nl/assets/interface-sounds | same zip, `Audio/select_001.ogg` | CC0 1.0 |

## hdri/

| File | Title | Author | Source page | Direct URL | License |
|---|---|---|---|---|---|
| `hdri/studio_small_09_2k.hdr` | Studio Small 09 (2K, Radiance HDR) | Sergej Majboroda | https://polyhaven.com/a/studio_small_09 | https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/studio_small_09_2k.hdr (md5 `b056fea247bc84b81d2e0987d44c87d8`) | CC0 1.0 |

## Optional credit lines

None of these is required. They are here if the video description gets a credits section.

```
Music: "Total War" by AudioAtlant / "Epic Hollywood Trailer" by Good_B_Music / "Epic Trailer" by Kulakovka (Pixabay)
Sound effects: VIRALAUDIO, Universfield, LazyChillZone, OxidVideos, floraphonic, emircanalp (Pixabay); Kenney (kenney.nl)
Switch sounds: kbsim by Thomas Lai (MIT)
HDRI: Studio Small 09 by Sergej Majboroda (Poly Haven, CC0)
```

## Used in the cut

`audio/build.py` uses: "Total War" (music, edited: intro 0.58–10.6 s, then 49.6 s to the end), the kbsim **Cream** press/release/SPACE/ENTER samples, Kenney `click4`, `click5`, `switch13`, `switch14` (knob detents) and `confirmation_002`, `descent-sub-boom-massive`, `ascent-braam-magma-brass-d` and `oxidvideos-paper-slide-short`. Everything else in the mix is synthesized by `audio/synth.py`. The other files are kept as alternatives.

## Code

The renderer in `video/app/` (engine, post-processing, offline export) is vendored from **pdoom-video** by mexicat, https://github.com/mexicat/pdoom-video, MIT, `video/app/LICENSE.pdoom-video`. Changes: lyrics, HUD and stroke fonts removed; keybordy palette and fonts; frames reach the encoder as same-origin HTTP POSTs instead of a WebSocket.
