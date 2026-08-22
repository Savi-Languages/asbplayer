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

import { GlossedWordEntry, SaviWatchedLineMessage } from './messages';

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
    /** Lowercased word → what its on-demand reveal did while this line
     *  displayed. A later reveal of the same word (e.g. the AI in-context
     *  gloss landing after the dictionary one) overwrites the label. */
    readonly hovered: Map<string, HoverReveal>;
}

/** One word's reveal history within a single displayed line.
 *
 *  Dwell is what separates a deliberate lookup from a cursor crossing the
 *  subtitle on its way somewhere else — Level 2 reads a reveal held past a
 *  threshold as a partial "Again" rather than as reinforcement, so the number
 *  has to mean something. */
interface HoverReveal {
    /** The label as shown ('' when the text wasn't captured). */
    gloss: string;
    /** Start of the reveal currently on screen; null when nothing is showing. */
    openedAtMs: number | null;
    /** Longest SINGLE continuous reveal so far, in ms.
     *
     *  Longest rather than total on purpose: three 400ms passes over a word
     *  are three flicks, not a 1.2s study, and summing them would hand the
     *  very gesture the threshold exists to filter a way through it. */
    longestMs: number;
    /** The user mined this word (added a card, or opened the study panel).
     *  That makes the hover COLLECTION, not failed recall, so no dwell is
     *  claimed for it at all — see `_finalize`. */
    retracted: boolean;
}

// Injected so the reporter is testable without extension APIs; the binding
// supplies the real settings/roaming/gloss/messaging implementations.
export interface EncounterReporterDeps {
    /** The saviEncounterRecording setting. */
    enabled: () => Promise<boolean>;
    /** The account-roaming target language ('' = not set → don't report). */
    targetLanguage: () => Promise<string>;
    /** Platform-stable episode id for the current page. */
    /** Platform-stable episode id, or `undefined` while the page has not
     *  settled onto one. Lines are dropped rather than filed under a
     *  throwaway id — see `deriveEpisodeId`. */
    episodeId: () => string | undefined;
    /** The words of the line currently displayed WITH an inline gloss label,
     *  each with the shown label text (the gloss controller's settled render
     *  truth, SV-20). Sampled at FINALIZE time, so late-resolving labels are
     *  still counted. */
    glossedEntries: (text: string, track?: number) => GlossedWordEntry[];
    /** Deliver the message to the background (browser.runtime.sendMessage). */
    send: (message: SaviWatchedLineMessage) => Promise<unknown>;
    /** A watched line could not be delivered — almost always the daemon being
     *  off, since it is the outbox. `consecutive` counts unbroken failures.
     *
     *  Fire-and-forget is right for ONE line, but a dead daemon silently eats
     *  an entire episode of exposure, and the user finds out days later when
     *  the words never appear. The host wires this to a visible banner. */
    onDeliveryFailure?: (consecutive: number) => void;
    /** Delivery worked again after at least one failure — clear the banner. */
    onDeliveryRecovered?: () => void;
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
    /** Unbroken delivery failures. Drives the "your daemon is off" banner —
     *  reset by the first success, so a one-off hiccup doesn't nag. */
    private _consecutiveFailures = 0;

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

        // No stable id yet (Netflix mid-navigation): drop the line rather than
        // file it under a throwaway episode. One line of exposure is a cheaper
        // loss than a duplicate library entry, and the id settles within a
        // beat.
        const episodeId = this._deps.episodeId();
        if (episodeId === undefined) {
            return;
        }

        this._pending.push({
            text,
            track: subtitle.track ?? PRIMARY_TRACK,
            lineStartMs: Math.round(subtitle.start),
            occurredAtMs: (this._deps.now ?? Date.now)(),
            episodeId,
            lang: this._lang,
            hovered: new Map(),
        });
    }

    /** The hover-gloss / hover-dictionary feature revealed a label for `word`
     *  on `lineText`. `gloss` is the label text as shown (SV-20; '' when not
     *  captured). A repeat reveal overwrites — the latest label wins.
     *
     *  This also STARTS the dwell clock. The hover controllers call it only
     *  once the real label has replaced the `…` placeholder, which is what
     *  excludes translation latency from the measurement — a slow provider
     *  can no longer make a glance look like a study. */
    noteHoverReveal(lineText: string, word: string, gloss: string = ''): void {
        this._eachReveal(lineText, word, (reveal) => {
            reveal.gloss = gloss.trim();
            if (reveal.openedAtMs === null) {
                reveal.openedAtMs = this._now();
            }
        });
    }

    /** The label for `word` stopped showing (cursor left it, popup hidden,
     *  teardown). Closes the current continuous reveal. */
    noteHoverRevealEnd(lineText: string, word: string): void {
        this._eachReveal(lineText, word, (reveal) => this._closeReveal(reveal));
    }

    /** The user mined `word` from its reveal — added a card, or opened the
     *  study panel. The gesture was collection, not a failure to recall, so
     *  the reveal is withdrawn and reports no dwell. */
    noteHoverRetract(lineText: string, word: string): void {
        this._eachReveal(lineText, word, (reveal) => {
            reveal.retracted = true;
            this._closeReveal(reveal);
        });
    }

    private _now(): number {
        return (this._deps.now ?? Date.now)();
    }

    private _closeReveal(reveal: HoverReveal): void {
        if (reveal.openedAtMs !== null) {
            reveal.longestMs = Math.max(reveal.longestMs, this._now() - reveal.openedAtMs);
            reveal.openedAtMs = null;
        }
    }

    /** Apply `apply` to `word`'s reveal record on every pending line matching
     *  `lineText`, creating the record on first contact. */
    private _eachReveal(lineText: string, word: string, apply: (reveal: HoverReveal) => void): void {
        if (!this._armed) {
            return;
        }
        const key = word.toLowerCase();
        for (const line of this._pending) {
            if (line.text === lineText.trim()) {
                let reveal = line.hovered.get(key);
                if (!reveal) {
                    reveal = { gloss: '', openedAtMs: null, longestMs: 0, retracted: false };
                    line.hovered.set(key, reveal);
                }
                apply(reveal);
            }
        }
    }

    private _finalize(line: PendingLine): void {
        // A reveal still on screen has no end event of its own, and the most
        // important reveal there is — the one held through the end-of-line
        // hover-hold, which pauses playback precisely so the line can be
        // finished — is exactly that case. Close it here or lose it.
        for (const reveal of line.hovered.values()) {
            this._closeReveal(reveal);
        }
        this._deps
            .send({
                command: 'savi-watched-line',
                lang: line.lang,
                text: line.text,
                episodeId: line.episodeId,
                lineStartMs: line.lineStartMs,
                occurredAtMs: line.occurredAtMs,
                glossedWords: this._deps.glossedEntries(line.text, line.track),
                // A retracted (mined) reveal sends NO dwell rather than a
                // zero: absent means "no qualifying dwell claimed", which is
                // the case we want, while 0 would be a measurement we
                // deliberately declined to make.
                hoverGlossedWords: [...line.hovered].map(([word, reveal]) =>
                    reveal.retracted
                        ? { word, gloss: reveal.gloss }
                        : { word, gloss: reveal.gloss, dwellMs: reveal.longestMs }
                ),
            })
            .then(() => this._noteDelivered())
            .catch((e) => this._noteFailure(e));
    }

    private _noteDelivered(): void {
        if (this._consecutiveFailures > 0) {
            this._consecutiveFailures = 0;
            this._deps.onDeliveryRecovered?.();
        }
    }

    private _noteFailure(e: unknown): void {
        this._consecutiveFailures += 1;
        console.debug('savi: watched-line dropped', e);
        this._deps.onDeliveryFailure?.(this._consecutiveFailures);
    }
}
