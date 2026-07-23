// Watch-time exposure reporting (SV-18): each primary-track subtitle line
// becomes one watched event carrying per-word encounter context — bare
// (unaided), glossed (inline label shown), hover_glossed (revealed on
// demand). A line OPENS when it starts showing and FINALIZES when the next
// line starts (or on flush/teardown), NOT at willStopShowing: the hover-hold
// pauses AT line end precisely so the user can hover, and sampling any
// earlier would lose those reveals — and would also mislabel glosses that
// resolve a beat after the line appears (the settled HTML is sampled at
// finalize, when it has long stabilized).
//
// Deliberately fire-and-forget with no queue: the daemon is the outbox, and
// a lost line costs one line's exposure, never playback smoothness.

import { SaviWatchedLineMessage } from './messages';

/** The displayed-line slice the reporter needs (matches asbplayer's SubtitleModel). */
export interface ShownLine {
    readonly text: string;
    readonly start: number; // ms, media time
    readonly track?: number;
}

const PRIMARY_TRACK = 0; // track 0 is the target-language track, like glossing

interface PendingLine {
    readonly text: string;
    readonly track: number;
    readonly lineStartMs: number;
    readonly occurredAtMs: number;
    /** Captured at open — an SPA episode change must not re-attribute a
     *  pending line to the next episode at flush time. */
    readonly episodeId: string;
    readonly lang: string;
    /** Lowercased words the user hover-revealed while this line displayed. */
    readonly hovered: Set<string>;
}

// Injected so the reporter is testable without extension APIs; the binding
// supplies the real settings/roaming/gloss/messaging implementations.
export interface EncounterReporterDeps {
    /** The saviEncounterRecording setting. */
    enabled: () => Promise<boolean>;
    /** The account-roaming target language ('' = not set → don't report). */
    targetLanguage: () => Promise<string>;
    /** Platform-stable episode id for the current page. */
    episodeId: () => string;
    /** Lowercased words of the line currently displayed WITH an inline gloss
     *  label (the gloss controller's settled render truth). Sampled at
     *  FINALIZE time, so late-resolving labels are still counted. */
    glossedLemmas: (text: string, track?: number) => string[];
    /** Deliver the message to the background (browser.runtime.sendMessage). */
    send: (message: SaviWatchedLineMessage) => Promise<unknown>;
    now?: () => number;
}

export class SaviEncounterReporter {
    private readonly _deps: EncounterReporterDeps;
    private _armed = false;
    private _lang = '';
    // Track-0 lines are sequential in practice; overlapping cues are the rare
    // exception and finalize slightly early (accepted). Keyed by start+text so
    // a seek-back re-show opens a fresh encounter.
    private _pending: PendingLine[] = [];

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

    /** Flush pending lines and disarm (unbind / teardown). */
    stop(): void {
        this.flush();
        this._armed = false;
    }

    /** Finalize everything pending with the current gloss/hover state. */
    flush(): void {
        const pending = this._pending;
        this._pending = [];
        for (const line of pending) {
            this._finalize(line);
        }
    }

    /** A line started showing: finalize what came before it, open its record. */
    report(subtitle: ShownLine): void {
        if (!this._armed || (subtitle.track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            return;
        }

        const text = subtitle.text?.trim();

        if (!text) {
            return;
        }

        // The previous line's display window is over — its gloss HTML has
        // settled and its hover window has closed (incl. the hover-hold, which
        // ends with playback resuming into this line).
        this.flush();

        this._pending.push({
            text,
            track: subtitle.track ?? PRIMARY_TRACK,
            lineStartMs: Math.round(subtitle.start),
            occurredAtMs: (this._deps.now ?? Date.now)(),
            episodeId: this._deps.episodeId(),
            lang: this._lang,
            hovered: new Set(),
        });
    }

    /** The hover-gloss feature revealed a gloss for `word` on `lineText`. */
    noteHoverReveal(lineText: string, word: string): void {
        if (!this._armed) {
            return;
        }
        const key = word.toLowerCase();
        for (const line of this._pending) {
            if (line.text === lineText.trim()) {
                line.hovered.add(key);
            }
        }
    }

    private _finalize(line: PendingLine): void {
        this._deps
            .send({
                command: 'savi-watched-line',
                lang: line.lang,
                text: line.text,
                episodeId: line.episodeId,
                lineStartMs: line.lineStartMs,
                occurredAtMs: line.occurredAtMs,
                glossedWords: this._deps.glossedLemmas(line.text, line.track),
                hoverGlossedWords: [...line.hovered],
            })
            .catch((e) => console.debug('savi: watched-line dropped', e));
    }
}
