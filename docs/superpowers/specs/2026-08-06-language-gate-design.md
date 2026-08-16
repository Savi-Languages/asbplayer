# Language gate — run savi only on the language being learned (SV-41)

**Status:** approved 2026-08-06, implemented on `feature/language-gate`.

## Problem

savi's learning layer activated on any video where a subtitle track matched the
learner's target language. On YouTube that is nearly always true: YouTube offers
**auto-translated** caption tracks in dozens of languages, so an English video
presents a Spanish track and the whole layer switched itself on over English
speech — gloss labels, hover-gloss, the controls, and the auto-loaded subtitles.

The visible noise was the complaint. The quieter damage was worse: watched lines
were reported as target-language exposure, so English viewing polluted Spanish
learning data.

"A track exists in language X" is not evidence that X is being spoken.

## Signal

YouTube marks its speech-recognition caption track `kind: "asr"`. That track is
produced *from the audio*, so its `languageCode` is the spoken language rather
than an offer. `youtube-page.ts` already parses the caption track list, so the
signal costs one field.

`VideoData` gains `spokenLanguage?: string`. Undefined means "no signal", which
is a first-class outcome, not an error.

Netflix is explicitly out of scope: its page script reads subtitle tracks
(`bcp47`), not audio tracks, so spoken-language detection there needs new
parsing. Failing open covers it.

## Posture: fail open

Deactivate only on a **positive mismatch**. No signal, or no configured target
language, means run exactly as before.

The asymmetry is deliberate. A savi that is noisy in the wrong place announces
itself and can be muted. A savi that goes quiet by accident loses exposure the
user never sees, and they find out weeks later from a gap in their data.

Every failure path resolves to "active": a malformed track list, unreadable
storage, or an exception inside the gate all leave savi running.

## Components

**`savi/language-gate.ts`** — pure, no I/O.

- `spokenLanguageFromTracks(tracks)` → the `asr` track's language, or undefined.
  Total: malformed entries are skipped, never thrown.
- `decideLanguageGate({ spokenLanguage, targetLanguage, episodeId, mutedEpisodes })`
  → `{ active, reason: 'match' | 'mismatch' | 'unknown' | 'muted' }`.
  Compared on the BCP-47 primary subtag, so `es-419` matches `es`. A manual mute
  outranks every automatic conclusion.

**`savi/muted-episodes.ts`** — the escape hatch's storage. Keyed by
`deriveEpisodeId` (`youtube:<id>`, `netflix:<id>`, `host:slug`), reusing savi's
existing notion of video identity. Bounded MRU (500), in-process mirror, and
storage failures read as "nothing muted" so they fail open too.

**`savi/language-hush.ts`** — a small fixed-position button, shown **only** on
the `unknown` verdict, because that is the only case where savi is guessing. On
a match it would be noise; on a mismatch savi is already off.

**`binding.ts` → `applySaviLanguageGate(verdict)`** — one place that starts or
stops the whole savi cluster: gloss, hover-gloss, hover dictionary, controls
clearance, capture, and **both reporters**. Stopping the reporters is what ends
the data pollution. Idempotent, so repeated syncs don't restart anything.

**`video-data-sync-controller.ts`** — evaluates the gate before attempting
auto-load, since a video savi should not touch is also one it should not load
subtitles for.

## Flow

```
youtube-page.ts  ──spokenLanguage──▶  VideoData
                                          │
video-data-sync-controller._trySaviAutoLoad
   ├─ roaming targetLanguage
   ├─ mutedEpisodes()
   └─ decideLanguageGate(...) ──▶ binding.applySaviLanguageGate(verdict)
                                     ├─ inactive → stop the whole savi cluster
                                     └─ active   → start it (and continue auto-load)
```

## Testing

Both decision-making units are pure and tested without a browser — the lesson
from the v0.44.14 Content-Range bug, which shipped because its code path could
not execute locally.

- `language-gate.test.ts` (13): asr extraction incl. malformed input; match,
  primary-subtag match, mismatch, unknown, unset target, muted, mute isolation.
- `muted-episodes.test.ts` (8): persistence across reload, de-duplication,
  bounding, junk in storage, storage failure failing open.
- `video-data-sync-controller.test.ts` (+4): the gate suppresses auto-load on a
  mismatch, loads on a match, fails open with no signal, and fails open when the
  gate itself throws.

## Out of scope

- Netflix spoken-language detection (needs audio-track parsing).
- Per-site and per-channel mute rules — per-video only. If the mute list grows
  uncomfortably, that is the signal to revisit.
- Any settings UI for the gate; it needs no configuration to be useful.
