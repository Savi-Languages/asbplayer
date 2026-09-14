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

## Implementation decisions

1. **Current behavior:** the fork inherited ASB Player's theme, popup settings form, modal options page, floating study tools, and remote localization cache.
2. **Success criteria:** recognizable Savi identity on every shared surface; useful popup without a compressed settings editor; full settings remain reachable; capture and subtitle commands keep their existing contracts.
3. **Approach:** restyle the shared component theme and change the major screen compositions. Retaining the existing React/MUI foundation preserves tested subtitle, card, and account behavior; a framework replacement would add risk unrelated to the redesign.
4. **Failure modes:** preserve transparent iframe backgrounds; avoid a toolbar covering transcript content; keep optional settings panel indices and ARIA relationships aligned; do not allow old cached upstream strings to erase new branding; preserve stored theme and subtitle preferences.
5. **Verification:** build both browser targets, run all existing tests plus regressions, check types/lint/localization contracts, and inspect the production extension in a disposable browser profile.

No data schema, cloud deployment, permission, capture protocol, or subtitle serialization changes. Shared UI changes also apply to the fork's local player client. Internal `asbplayer` message identifiers and asset paths remain compatibility contracts.

## Verification evidence

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

## Review and rollout

The unpacked Chromium extension is in `extension/.output/chrome-mv3`; the Firefox build is in `extension/.output/firefox-mv2`. Build outputs are ignored by Git. The user's installed extension has not been replaced, and no branch has been merged or production site deployed.

New interface copy currently uses English fallbacks in other locales; existing translated settings remain translated. Live authenticated Netflix/YouTube playback and real audio capture require a separate smoke check before rollout. The redesign does not change their backend paths.

To run the browser check, build the extension first, then run `node scripts/savi-redesign-qa.cjs` with Playwright installed. `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can point to a host-provided Playwright installation and Chromium executable.
