// Watch-time exposure reporting (SV-18): as each primary-track subtitle line
// starts showing, post it to the daemon as a word-exposure event — independent
// of whether audio capture is running. Deliberately fire-and-forget with no
// queue: the daemon is the outbox, and a lost line costs one line's exposure,
// never playback smoothness.

import { SaviWatchedLineMessage } from './messages';

/** The displayed-line slice the reporter needs (matches asbplayer's SubtitleModel). */
export interface ShownLine {
    readonly text: string;
    readonly start: number; // ms, media time
    readonly track?: number;
}

const PRIMARY_TRACK = 0; // track 0 is the target-language track, like glossing

// Injected so the reporter is testable without extension APIs; the binding
// supplies the real settings/roaming/messaging implementations.
export interface EncounterReporterDeps {
    /** The saviEncounterRecording setting. */
    enabled: () => Promise<boolean>;
    /** The account-roaming target language ('' = not set → don't report). */
    targetLanguage: () => Promise<string>;
    /** Platform-stable episode id for the current page. */
    episodeId: () => string;
    /** Lowercased words of the line currently displayed WITH a gloss label
     *  (the gloss controller's settled render truth) — aided exposure. */
    glossedLemmas: (text: string, track?: number) => string[];
    /** Deliver the message to the background (browser.runtime.sendMessage). */
    send: (message: SaviWatchedLineMessage) => Promise<unknown>;
    now?: () => number;
}

export class SaviEncounterReporter {
    private readonly _deps: EncounterReporterDeps;
    private _armed = false;
    private _lang = '';

    constructor(deps: EncounterReporterDeps) {
        this._deps = deps;
    }

    /** (Re)read the toggle + target language. Safe to call again on settings
     *  refresh; arming requires both. */
    async start(): Promise<void> {
        try {
            const [enabled, lang] = await Promise.all([this._deps.enabled(), this._deps.targetLanguage()]);
            this._lang = lang;
            this._armed = enabled && lang !== '';
        } catch (e) {
            this._armed = false;
        }
    }

    stop(): void {
        this._armed = false;
    }

    report(subtitle: ShownLine): void {
        if (!this._armed || (subtitle.track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            return;
        }

        const text = subtitle.text?.trim();

        if (!text) {
            return;
        }

        this._deps
            .send({
                command: 'savi-watched-line',
                lang: this._lang,
                text,
                episodeId: this._deps.episodeId(),
                lineStartMs: Math.round(subtitle.start),
                occurredAtMs: (this._deps.now ?? Date.now)(),
                glossedWords: this._deps.glossedLemmas(subtitle.text, subtitle.track),
            })
            .catch((e) => console.debug('savi: watched-line dropped', e));
    }
}
