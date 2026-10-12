# savi — immersion workflow (asbplayer fork)

This fork adds **savi capture** to asbplayer: while you watch on Netflix/YouTube,
it records the tab audio in media-time-keyed segments and ships them to the
savi daemon, which stitches a **condensed, dialogue-only re-listening track**
per episode and tracks your **known-words buckets**. The daemon + player live
in the `savi` repo; this doc covers the _watching_ side.

Most of what people want from Language Reactor is already in asbplayer — it's
just behind keybinds. This is the map.

## Automatic and manual recording

Auto-capture episodes defaults to on for settings that have not been saved yet.
An explicitly saved Off remains off after upgrading. Change it in Savi settings;
the Record button remains available for manual recording either way. Stopping a
recording manually prevents automatic restart for that episode in the current
page session. For video, idle recovery continues an existing recording intent when the context permits it.
Spotify idle recovery requires Auto-capture to be on.

## Hover dictionary — built-in Japanese lookup and optional Yomitan

Savi's built-in Japanese hover dictionary uses the Savi daemon's tokenizer and
dictionary through `savi-tokenize` and `savi-dict`. It does not require Yomitan
or the optional Yomitan API configured in Annotation settings. Previously cached
tokens and entries can remain available when the daemon is offline.

The subtitle overlay also renders **selectable text**, which
[Yomitan](https://yomitan.wiki) (the successor to Yomichan) scans for hover
definitions using dictionaries you install. Yomitan is an optional alternative
for additional dictionaries, languages, pitch accent, frequency, and Anki tools.

**Optional Yomitan setup:**

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

**Yomitan use:** with Savi subtitles showing on the video, **hover a word in the
subtitle** → Yomitan pops the definition. Works the same on Netflix and YouTube.

> savi's native-subtitle-hider only hides the _streaming site's own_ captions
> (`.player-timedtext` / `.ytp-caption-window-container`), never asbplayer's
> overlay — so scanning is unaffected. If a word won't scan, make sure
> asbplayer's subtitle appearance isn't in an image/SVG mode.

## Keybinds — the Language Reactor workflow

All customizable in **Savi → Settings → Keyboard shortcuts**. Defaults:

savi rebinds the subtitle controls to a **WASD-style** layout (defaults below;
all editable in **Settings → Keyboard shortcuts**):

| Want                                  | Key               | Notes                                                                                                     |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| **Pause after every line** (LR's `Q`) | `Q`               | Toggles auto-pause; it stops at the **end** of each subtitle. Press `Space` to continue to the next line. |
| **Previous line**                     | `A`               |                                                                                                           |
| **Replay the current line**           | `S`               | Seeks to the start of the current subtitle.                                                               |
| **Next line**                         | `D`               |                                                                                                           |
| **Copy the subtitle text**            | `Ctrl+Shift+Z`    |                                                                                                           |
| **Mine a card** (Anki)                | `Ctrl+Shift+X`    | Opens the card creator for the current line.                                                              |
| Seek ±2s                              | `←` / `→`         | (the old 5-second seek, moved off A/D)                                                                    |
| **Condensed playback** (skip silence) | `Shift+O`         | Plays only subtitled spans.                                                                               |
| Fast-forward non-dialogue             | `Shift+F`         |                                                                                                           |
| Toggle subtitles / tracks             | `↓` / `1` `2` `3` |                                                                                                           |
| Repeat current line                   | `Shift+R`         |                                                                                                           |

> Q is now a clean auto-pause toggle, so asbplayer's `Q+0`…`Q+5` hover
> word-marking is unbound by default — savi tracks word status in its own
> buckets. Rebind it in Settings if you want it.

So the study loop you showed from LR is: **`Q`** to arm auto-pause →
watch → it pauses at each line → hover words / **`S`** to replay /
**`Ctrl+Shift+X`** to mine → **`Space`** to continue. **`A`**/**`D`** step
between lines.

## Recording audio for an episode

savi's condensed-audio feature records the tab's audio. Browsers require a
fresh user gesture to grant tab-audio access **on every page load** — a
security rule no extension can bypass — so after a reload you arm recording
with one keypress:

**`Ctrl+Shift+S`** (Mac: `Control+Shift+S`) — grants the audio permission **and**
starts the savi capture in a single gesture. No hunting for the toolbar icon.

It's a browser-level command, so if nothing happens the key probably wasn't
bound (another extension claimed it). Set it at **`edge://extensions/shortcuts`**
(or `chrome://extensions/shortcuts`) under _"Savi: grant audio permission and
start recording this tab"_.

There's also a **Record button** on the video (top-right) — click it to
start/stop, and it turns into a pulsing red "Recording" while live. One catch
the browser forces on everyone: a _click in the page_ can't grant the audio
permission (only the shortcut / toolbar icon can), so the **first** record of a
page load needs `Ctrl+Shift+S` once; after that the button starts/stops freely
for the rest of the session.

You only need any of this for the **audio** capture. Subtitles, the hover
dictionary, furigana, and pause-on-hover all work without it — and savi no
longer pops the "enable audio recording" dialog on reload.

## Playback speed

A speed selector sits at the **top-center** of the video — **0.5× · 0.75× · 1× ·
1.25× · 1.5×**. Click a rate to set it; the active one is highlighted. (Idle
it's faint; hover to bring it forward.) These all sit inside the 0.5–2.0× range
savi's capture tempo-corrects, so slowing down to study **while recording** is
fine — the condensed audio comes back at normal speed.

## Bilingual (dual) subtitles

Load a second subtitle track (your native language) alongside the target track
— Savi Settings → Subtitle appearance, and the track toggles (`1`/`2`).
This gives the LR-style target + native view.

## Optional companion player and licenses

**Settings → Misc → Advanced integrations** contains the optional asbplayer
companion-player toggle and URL. This opens a separate compatible subtitle/player
app; it is not the Savi account or web-app connection. Existing preferences and
custom player URLs are retained.

**About Savi → Open-source licenses** contains the complete upstream MIT notice,
author acknowledgements, and dependency credits.

## Furigana + word coloring (savi player)

The savi player (served by the daemon at `http://localhost:4030`) shows the
**condensed transcript with furigana over kanji** and **words colored by your
learning bucket** (new = highlight, learning = amber, known = dimmed). Toggle
**Furigana** / **Colors** above the transcript. This is for _review /
re-listening_; the built-in hover dictionary and optional Yomitan integration
above support _live watching_.

## Subtitle styling (Language Reactor look)

savi ships Language Reactor-style subtitle defaults (in
`common/settings/settings-provider.ts`): **soft white**, **regular weight**,
**no black outline/shadow**, on a **dark rounded box** (the box fill is
`subtitleBackgroundOpacity`; `video.content/video.css` rounds it). Hovering a
word draws a **gray box** around it and shows a **pointer** cursor, and
`pauseOnHoverMode` defaults to **inAndOut**. With an active learning language
and visible subtitles, hovering a word lets its subtitle line finish, then
pauses at the line's end. Moving away from the subtitle and dictionary popup
resumes playback only if the hover feature paused it. Leaving before the end
cancels the pending pause; a manual pause stays paused. This behavior works
across Watch, Explore, and Listen when text is revealed.

These are _defaults_ — if you've already customized subtitle appearance in
Settings, your saved values win. To get the savi look back, reset Subtitle
appearance (or clear those fields). To make the **native (English) line
smaller than the target line**, give it its own size under Settings → Subtitle
appearance → the second track's tab (per-track styling); savi can't guess which
track is your native one.

## Target words (0.78.0)

With the matching Savi cloud and daemon, episode preparation selects a small list
from public subtitle profiles and your current vocabulary. Resolved episodes can
show a pre-watch card on the next play near the episode start. Preparation that
finishes during playback or after the first minute suppresses the card for that
episode, so a later hover-hold resume is never interrupted. Preparation and heard-target mining run only in Explore.
Unresolved/provider failures leave capture running; transient preparation failures
back off from 30 seconds to a 10-minute cap, while unresolved titles are cached
for 15 minutes before another lookup.

The primary subtitle track gets a soft purple target underline. Hover and targets
share one local tokenizer request/cache: hover uses dictionary compounds, targets
use the raw analyzer lemmas that also generate heard evidence. No AI call runs on
the decoration path. Text and ruby labels remain intact.

“I know this” and “Not for this show” persist account-bound feedback offline;
“Start watching” records acceptance and resumes. Savi Settings controls the card
(default on) and automatic Anki export (default off). Saved player episode
corrections are honored through both platform and filesystem-safe capture IDs.

A target enters Savi review only after an acknowledged heard event and 90% audible
forward playback of its actual primary-track cue. Paused time, seeks and repeated
fragments cannot manufacture coverage. Mining uses a durable account/language/
episode/cue-start/lemma identity in browser storage and daemon SQLite. The signed-in
extension checks fresh known/suppressed state through the cloud, verifies the
response account, and sends `eligible` and `autoMineToAnki` to the daemon. The
daemon authenticates with the LAN token or, when no LAN token is configured, the
owner JWT; target mining sends no separate `X-Savi-Account` header and the daemon
does not relay a credential or call the cloud. This requires the daemon contract
in [Savi #74](https://github.com/Savi-Languages/savi/pull/74), version 0.78.0.
Optional audio and JPEG frames stay local and are best effort; protected video
with an active DRM session is not sampled through canvas.
Anki export requires opt-in in both the prepared request and current cloud setting,
uses the `savi` deck, reconciles lost replies and retries without duplicate actions.
Mining drops immutable daemon 400/409 failures. Transient and pending-Anki retries
back off exponentially up to six hours and stop after twelve attempts (about
20.5 hours at the earliest); exhausted rows discard their
subtitle/frame payloads. Pending-Anki retries recheck current eligibility and
export consent only when due; alarms during backoff make no cloud eligibility
request. Target-feedback delivery retries at most once every
15 minutes after a failure while retaining pending dismissals. Empty watch-review
outboxes make no cloud settings request.
The built-in reviewer continues to use the captured encounter context.

Validation covers Watch-mode gating, preparation backoff, daemon authentication,
mining retry limits, and hover-pause ownership. Run `yarn verify`, the extension
TypeScript compile, and the Chrome production build before review. Real Netflix
playback with the matching cloud/daemon and AnkiConnect remains a separate live
integration check; automated tests do not establish that result.

### Immersion modes (0.78)

The optional “Savi modes” toolbar is off by default and can be enabled in Savi settings. It provides Watch / Explore / Listen and explicit Bookmark / Replay / Reveal actions. Mode changes are saved locally with a timestamp for offline use and synchronized with the signed-in account; a newer cloud preference takes precedence. Watch is the default: no automatic target preparation, card, or hover mining. Explore allows those features subject to existing consent/settings. Gloss labels and dictionary lookup remain controlled by their settings and language support. Savi hover pause holds the current subtitle at its end in every supported learning language, independently of gloss labels or study mode, and resumes only a pause it owns. Listen hides the Savi subtitle layer only while the toolbar is enabled, with a reversible Reveal button. Disabling the toolbar reveals subtitles. General asbplayer playback modes selected explicitly by the user remain separate.

A bookmark is saved locally before upload even when hover mining is disabled. A paused hover must last 1.5 seconds, match an exact current primary cue, and be in Explore with consent. Strong AI selections become candidates; admission budgets are enforced in Savi. Playback alone never grades an item. The local outbox remains account/backend scoped; unavailable AI retries later.

Review follow-up: internal hover/replay/recording resumes bypass the pre-watch card. A signed-in default installation without a successful daemon connection does not show an offline warning; explicit daemon settings and previously successful watched-line delivery retain outage warnings across worker restarts.

## Spotify Web (0.60)

Open Spotify Web in the extension-enabled browser. The Savi panel follows the
Now Playing item, independently of the page you browse. Open Spotify's Lyrics or
Read along view to let the adapter observe text already delivered to that page.
Availability varies by item and Spotify build. The adapter never calls private
Spotify endpoints or reads Spotify credentials.

- Hover/tap words directly in Spotify’s native transcript or lyrics for dictionary
  lookup. English appears beneath each line. A compact caption follows the current
  timed text when the native view is out of sight. Save selected line creates a bookmark in the same account's Savi review library. Explore
  mode plus paused-hover consent enables the existing 1.5-second interest signal,
  knowledge-aware selection and admission limits. AI card details remain manual.
- Missing text: import SRT/VTT/LRC or paste publisher/user-supplied plain text.
  The panel also offers an explicit import of visible Spotify text. Untimed text
  stays untimed and has no exact replay or heard-word evidence. Bookmark/mining requires timed text; untimed lines remain available for reading and dictionary lookup.
- Audio recording follows the existing recording settings and requires timed text plus a verified local native media clock. If provider text is unavailable, matching native podcast timestamp groups provide a fallback without inventing per-sentence timing.
  Pause, seek, rate/volume/media changes close segments; changing item finishes
  the previous capture. A different audible browser tab blocks the process tap.
  Missing or ambiguous clocks, remote playback and crossfade disable capture.
  An explicit stop prevents another automatic start for that item. Stop and retry
  after an audio failure; the panel reports the daemon’s result.
- Savi cards use canonical song/episode links. Spotify episode links include a
  timestamp only for timed text. Spotify song links open the song; saved local
  line audio uses the existing source-to-recording map.

The collapsed Savi menu opens learning controls; × minimizes it without stopping
recording. Native text highlights and scrolls with its timed cue/group, pausing
automatic scrolling when the learner browses back. Hover pause applies only over
rendered text. The shared dictionary popup leaves room for neighboring rows on
Spotify and video sites; its blank-space corridor does not intercept word clicks.

Listening is measured from actual local advancement, uses stable UUIDs for
retries, and does not grade vocabulary. Imported text is scoped to the current
item in the tab; saving selected lines persists them. Language-matched timed
lines alone can contribute heard evidence. An imported file should match the
learning language selected in Savi.

QA: `node extension/qa/spotify/build.mjs`, then serve `extension/qa/spotify/` on
localhost. It uses the production panel with a synthetic media clock and fake
API responses, never the personal account, database, or real audio. This fixture
is not evidence of live Spotify capture. Live verification needs Spotify sign-in
and a reload of the installed extension.

### Playback sequence across capture recovery

Ownership stays in `storage.session`. The worker reserves blocks of 256 playback
sequence numbers in `storage.local` before exposing a number; a restarted worker
skips the unused tail. Retirement, replacement and failed handshakes never lower
the cursor. The mutation queue fences allocations against owner changes and Stop.
This reduces durable writes from one per batch to roughly one per 256 batches.

A fresh profile, reinstall or cleared storage can still start below the daemon's
retained cursor. [Savi #92](https://github.com/Savi-Languages/savi/pull/92) adds
`lastSeq` to playback-state responses. On a fresh stale batch the worker checks
ownership again and reserves above that floor. The video controller sends new
boundaries at the current playhead, or just an end while paused. It never resets
the daemon or replays historical boundaries under a higher sequence. Existing
files and the engine's retired-segment protection stay intact.

Recovery is bounded to one cursor resync per owner generation. Missing/invalid
`lastSeq` or another rejection retires local ownership without finishing the
shared daemon capture; the video controller warns and suppresses auto-restart.
This handles sequential profile changes, not concurrent capture ownership across
profiles. Stop other recording tabs before restarting. The daemon's existing
watchdog/idle finalization still owns abandoned audio; this path deletes nothing.

HTTP retries reuse the same sequence and time out after ten seconds. Video
content messages also carry a monotonic generation-scoped batch ID: a lost
worker reply reuses the stored sequence, a saved resync reply is repeated, and
an older superseded batch is never posted. This survives worker restarts. Older
clients/Spotify without a batch ID retain their previous delivery semantics;
new live Spotify coverage is still required before claiming that path verified.

Preserve/finish an active recording before installing or reloading either build.
The source changes do not authorize replacing an actively recording runtime.
