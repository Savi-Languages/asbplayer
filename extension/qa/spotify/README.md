# Spotify integrated reading QA

The Spotify controller owns playback identity, imports and automatic capture.
`SpotifyReadingSurface` decorates Spotify's transcript/lyrics and uses the same
Japanese dictionary and word study panel as Netflix. A current-line caption
above the player appears when matching native text is not visible. Controls and
the imported-text browser live in a collapsed Savi menu.

Native episode text must match Now Playing and the browsed episode. Paragraphs
that combine provider cues, or repeated phrases whose timing is ambiguous, can
be looked up and translated but receive no invented timing. Plain imported text
remains available in the menu.
Japanese spacing normalization changes only leaf text nodes and restores their
original content on teardown if Spotify has not changed it in the meantime.

Hover holds the caption and transcript scroll. The existing pause-on-hover
preference controls playback; only an owned pause may resume, and episode,
player, seek or explicit playback controls revoke that ownership. Native scroll
follows the audio until the learner scrolls back; Back to current line restores
following. Browser/window scroll is never changed.

English appears below each native line and the current caption; imported lines
also show their English in the menu. Translation uses the existing signed-in
cloud service, with current/visible lines prioritized and at most two requests
in flight. Results are scoped to account, episode, source language and sentence
context. Missing results are shown as pending or unavailable, with a 30-second
failure backoff. English is outside the Japanese lookup target and never becomes
capture subtitle text. Native paragraph padding is adjusted only while its
English sibling is present and is restored when the surface stops.

## Automated checks

From the extension repository root:

```sh
node node_modules/jest/bin/jest.js --config extension/jest.config.js --runInBand
node .yarn/releases/yarn-3.2.0.cjs workspace @project/extension compile
node .yarn/releases/yarn-3.2.0.cjs workspace @project/extension build
```

Coverage includes capture regressions, clock ambiguity, transcript identity,
native/fallback exclusivity, timed cue changes/gaps, node replacement and cleanup,
scroll-follow suspension, pause ownership, and stale shared dictionary requests.

## Isolated rendered fixture

```sh
node extension/qa/spotify/build.mjs
python3 -m http.server 4178 --directory extension/qa/spotify
```

Open localhost:4178. All responses and media are synthetic; no personal Savi
review state or real recording is created. Click 旅行 in the native text to open
the shared word panel. Preview word hover dispatches a pointer event at its DOM
Range for a repeatable dictionary geometry check. Toggle native transcript to
check the caption fallback. Play, seek, scroll, change item and hide text to
exercise lifecycle transitions.

## September 14 verification

Verified the native Spotify transcript markup on the signed-in podcast page.
In the rendered fixture, native line highlighting and the collapsed menu were
visible, the duplicate caption was hidden, and clicking 旅行 opened the shared
study panel with the correct term. Further browser QA was interrupted by an open
Edge extension UI. Final live hover, automatic capture and native/fallback checks
require the updated extension to be reloaded. Browser policy blocks agent access
to extension management; the user performs that reload.

A read-only Claude CLI critique was attempted but produced no response within
six minutes and was stopped. Automated checks and direct source review remain
the validation evidence; no independent review is claimed.

The later English-subtitle fixture check verified English below all three native
lines, the bilingual caption fallback, Japanese source language in requests, and
the 旅行 dictionary popup with translations present. These rendered checks use
isolated synthetic translation responses; live cloud translations still require
the extension reload.
