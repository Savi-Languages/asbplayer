# Savi extension redesign

Implemented on `codex/savi-extension-redesign`, based on Savi-Languages/asbplayer `12785a8a`.

## Direction and scope

The watching extension now shares Savi's charcoal surfaces, sky-blue accent, native system typography, 14px cards, and quieter hierarchy. Colors come from the Savi app's `packages/ui/src/theme.css` at main `d6e6f4b9`. A compact S mark replaces the upstream logo in the browser toolbar and shared UI.

The main interaction changes are:

- **Popup:** a 380px watching companion, with a study-panel primary action, pause-on-hover preference, capture status when configured, account entry, and a link to the Savi web app. Full settings move to a separate page.
- **Settings:** a full-page workspace with account and languages first, responsive navigation, all existing categories and profiles retained, labeled inputs, and advanced connection details behind a disclosure. Keyboard navigation and hash links work, including same-page hash changes.
- **Study panel:** a contextual starting screen, persistent horizontal tools, roomier transcript rows, a clear active-line accent, and branded saved-card/statistics drawers.
- **Watching:** dark compact speed, replay, recording, subtitle controls, and dictionary surfaces; blue selected states; keyboard focus, speed pressed state, and reduced-motion support.
- **Dialogs:** consistent Savi fields, buttons, spacing, surfaces, and headers across subtitle selection, card creation, notifications, statistics, and dictionary/settings dialogs.
- **Onboarding:** direct setup and watching-tool actions replace the implicit scroll-to-start interaction.
- **Identity:** packaged icons, page titles, localized product names, and extension metadata say Savi. The About page retains the upstream authors, MIT license, and dependency credits.
- **Optional upstream tools:** the companion-player toggle and URL live under Misc → Advanced integrations, labeled as an optional asbplayer integration separate from the Savi account. Saved values and connection behavior remain unchanged. About Savi presents the product first, with the full upstream notice and dependency credits in a collapsed Open-source licenses disclosure.
- **Study controls:** Watch, Explore, and Listen switch immediately and save on this browser, with separate preferences for each account/backend and for signed-out use. A cloud mode supplies the initial default only until a local choice exists. Replay uses the current line, the previous line during gaps, or the first upcoming line; unavailable actions are dimmed with reasons.
- **Hover playback:** with hover pausing enabled for the active learning language, a hovered subtitle plays to its end and pauses while the pointer remains on the line or dictionary popup. Leaving resumes a hover-owned pause, while manual pauses remain paused. The behavior is independent of study mode and applies to revealed text in Listen.

## Implementation decisions

1. **Current behavior:** the fork inherited ASB Player's theme, popup settings form, modal options page, floating study tools, and remote localization cache.
2. **Success criteria:** recognizable Savi identity on every shared surface; useful popup without a compressed settings editor; full settings remain reachable; capture and subtitle commands keep their existing contracts.
3. **Approach:** restyle the shared component theme and change the major screen compositions. Retaining the existing React/MUI foundation preserves tested subtitle, card, and account behavior; a framework replacement would add risk unrelated to the redesign.
4. **Failure modes:** preserve transparent iframe backgrounds; avoid a toolbar covering transcript content; keep optional settings panel indices and ARIA relationships aligned; do not allow old cached upstream strings to erase new branding; preserve stored theme and subtitle preferences.
5. **Verification:** build both browser targets, run all existing tests plus regressions, check types/lint/localization contracts, and inspect the production extension in a disposable browser profile.

The visual redesign does not change data schemas, cloud deployment, permissions, capture protocols, or subtitle serialization. Shared UI changes also apply to the fork's local player client. Internal `asbplayer` message identifiers and asset paths remain compatibility contracts. The full branch also preserves the Spotify Web adapter and capture support from PR #38; its behavior and fixture limitations are documented in [SAVI.md](../../SAVI.md#spotify-web-060).

## Verification evidence

The original visual redesign was verified before the Spotify merge and playback/control follow-ups:

- Chromium production build: passed.
- Firefox production build: passed (runtime Firefox testing not performed).
- Extension tests: 627 passed.
- Common tests: 92 passed.
- Client tests: 3 passed.
- TypeScript, lint on changed source files, formatting, locale key/language checks, page-reference checks, and whitespace checks: passed.
- Browser regression script: `scripts/savi-redesign-qa.cjs`. Tests the production build with a disposable profile, stale upstream locale cache, saved popup preference, settings entry, every category, same-page deep links, keyboard navigation, advanced connection disclosure, narrow/light layouts, the empty study panel, saved-card navigation, and onboarding. No page errors.
- Local video fixture: loaded 30 Japanese subtitle cues into the production extension, exercised the 0.75× speed control (actual playbackRate 0.75), and inspected the populated study panel. Its page stayed within the 900px viewport with a separately scrolling transcript. Fixture connections point only to a disposable loopback server; no account, recording, or personal history is used.
- Screenshots under `screenshots/` show actual rendered builds, not design mockups.

Regression tests were observed failing before fixes for speed accessibility, setting label association, and live hash navigation. The settings-host wiring guard now covers the full settings page; the popup routes there and is covered by the browser test.

The completed study-control follow-up was verified on September 14 with 721 extension tests, TypeScript, lint on changed source files, and a Chromium production build. An isolated browser fixture exercised signed-out Listen/Reveal, previous-line Replay in subtitle gaps, and disabled-control explanations. Hover-pause and control regressions cover timing, pause ownership, stale configuration responses, and offline mode choices. These results do not establish live Netflix or Spotify capture behavior. The earlier Firefox, common, and client results above belong to the original redesign checks.

## Review and rollout

The unpacked Chromium extension is in `extension/.output/chrome-mv3`; the Firefox build is in `extension/.output/firefox-mv2`. Build outputs are ignored by Git. The Chromium build through `127854d6` was copied into the existing Edge installation directory, preserving its extension ID and settings; the extension was reloaded and verified enabled on September 15. No video tab was open for an authenticated playback check. The subsequent PR-review fixes described below have been built but have not replaced that running installation. This branch has not been merged and no production site has been deployed.

PR preparation on September 15 fixed a mode refresh that could arrive during a pending save and made Replay propagate native playback failures and time out missing Netflix acknowledgements. Final checks passed: 728 extension tests, 92 common tests, 3 client tests, extension TypeScript, ESLint on 61 changed source files, locale/page-reference checks, and fresh Chromium and Firefox production builds. These automated checks do not replace live streaming and capture smoke tests.

New interface copy currently uses English fallbacks in other locales; existing translated settings remain translated. Live authenticated Netflix/YouTube playback and real audio capture still require a separate smoke check. Spotify's synthetic fixture likewise does not verify live capture. The redesign does not change the existing Netflix/YouTube backend paths.

To run the browser check, build the extension first, then run `node scripts/savi-redesign-qa.cjs` with Playwright installed. `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can point to a host-provided Playwright installation and Chromium executable.
