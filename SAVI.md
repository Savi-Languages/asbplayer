# savi — immersion workflow (asbplayer fork)

This fork adds **savi capture** to asbplayer: while you watch on Netflix/YouTube,
it records the tab audio in media-time-keyed segments and ships them to the
savi daemon, which stitches a **condensed, dialogue-only re-listening track**
per episode and tracks your **known-words buckets**. The daemon + player live
in the `savi` repo; this doc covers the *watching* side.

Most of what people want from Language Reactor is already in asbplayer — it's
just behind keybinds. This is the map.

## Hover dictionary (Yomitan) — the LR pop-up, but better

asbplayer renders its subtitle overlay as **selectable text**, which
[Yomitan](https://yomitan.wiki) (the successor to Yomichan) scans for hover
definitions — readings, meanings, pitch accent, frequency, one-tap Anki. It's
strictly more capable than LR's built-in dictionary.

**Setup (once):**

1. Install **Yomitan** from your browser's add-on store — [Chrome Web
   Store](https://chromewebstore.google.com/detail/yomitan/likgccmbimhjbgkjambclfkhldnlhbnn),
   [Edge Add-ons](https://microsoftedge.microsoft.com/addons/search?q=yomitan),
   or [Firefox AMO](https://addons.mozilla.org/firefox/addon/yomitan/). (On Edge
   you can also install from the Chrome Web Store once you allow extensions from
   other stores.)
2. Import dictionaries — Yomitan → Settings → **Dictionaries → Import a
   dictionary**. The `.zip` imports directly; no need to unzip.
   - **Japanese:** [**Jitendex**](https://jitendex.org/pages/downloads.html) —
     the modern, better-formatted JMdict build for Yomitan (recommended over raw
     JMdict). Optionally add a frequency dictionary and a **pitch-accent**
     dictionary from [MarvNC/yomitan-dictionaries](https://github.com/MarvNC/yomitan-dictionaries#japanese)
     — pitch accent is worth it given the N1 goal.
   - **Spanish (Leon):** a Spanish→English (`es→en`) dictionary from
     [MarvNC/yomitan-dictionaries → Spanish](https://github.com/MarvNC/yomitan-dictionaries#spanish).
   - Prefer raw JMdict (covers many target languages incl. Spanish glosses)?
     [yomidevs/jmdict-yomitan releases](https://github.com/yomidevs/jmdict-yomitan/releases).
3. Yomitan → Settings → **Scanning**: confirm hover/scan is enabled (default:
   hold no key, or Shift — your preference).

**Use:** with asbplayer subtitles showing on the video, **hover a word in the
subtitle** → Yomitan pops the definition. Works the same on Netflix and YouTube.

> savi's native-subtitle-hider only hides the *streaming site's own* captions
> (`.player-timedtext` / `.ytp-caption-window-container`), never asbplayer's
> overlay — so scanning is unaffected. If a word won't scan, make sure
> asbplayer's subtitle appearance isn't in an image/SVG mode.

## Keybinds — the Language Reactor workflow

All customizable in **asbplayer → Settings → Keyboard shortcuts**. Defaults:

savi rebinds the subtitle controls to a **WASD-style** layout (defaults below;
all editable in **Settings → Keyboard shortcuts**):

| Want | Key | Notes |
|------|-----|-------|
| **Pause after every line** (LR's `Q`) | `Q` | Toggles auto-pause; it stops at the **end** of each subtitle. Press `Space` to continue to the next line. |
| **Previous line** | `A` | |
| **Replay the current line** | `S` | Seeks to the start of the current subtitle. |
| **Next line** | `D` | |
| **Copy the subtitle text** | `Ctrl+Shift+Z` | |
| **Mine a card** (Anki) | `Ctrl+Shift+X` | Opens the card creator for the current line. |
| Seek ±2s | `←` / `→` | (the old 5-second seek, moved off A/D) |
| **Condensed playback** (skip silence) | `Shift+O` | Plays only subtitled spans. |
| Fast-forward non-dialogue | `Shift+F` | |
| Toggle subtitles / tracks | `↓` / `1` `2` `3` | |
| Repeat current line | `Shift+R` | |

> Q is now a clean auto-pause toggle, so asbplayer's `Q+0`…`Q+5` hover
> word-marking is unbound by default — savi tracks word status in its own
> buckets (+ Yomitan for lookups). Rebind it in Settings if you want it.

So the study loop you showed from LR is: **`Q`** to arm auto-pause →
watch → it pauses at each line → hover words (Yomitan) / **`S`** to replay /
**`Ctrl+Shift+X`** to mine → **`Space`** to continue. **`A`**/**`D`** step
between lines.

## Bilingual (dual) subtitles

Load a second subtitle track (your native language) alongside the target track
— asbplayer Settings → Subtitle appearance, and the track toggles (`1`/`2`).
This gives the LR-style target + native view.

## Furigana + word coloring (savi player)

The savi player (served by the daemon at `http://localhost:4670`) shows the
**condensed transcript with furigana over kanji** and **words colored by your
learning bucket** (new = highlight, learning = amber, known = dimmed). Toggle
**Furigana** / **Colors** above the transcript. This is for *review /
re-listening*; Yomitan above is for *live watching*.

## Subtitle styling (Language Reactor look)

savi ships Language Reactor-style subtitle defaults (in
`common/settings/settings-provider.ts`): **soft white**, **regular weight**,
**no black outline/shadow**, on a **dark rounded box** (the box fill is
`subtitleBackgroundOpacity`; `video.content/video.css` rounds it). Hovering a
word draws a **gray box** around it and shows a **pointer** cursor, and
`pauseOnHoverMode` defaults to **inAndOut** so the video **pauses while you
hover a word** and resumes when you move away.

These are *defaults* — if you've already customized subtitle appearance in
Settings, your saved values win. To get the savi look back, reset Subtitle
appearance (or clear those fields). To make the **native (English) line
smaller than the target line**, give it its own size under Settings → Subtitle
appearance → the second track's tab (per-track styling); savi can't guess which
track is your native one.
