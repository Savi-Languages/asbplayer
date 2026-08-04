// Engaged learning-time reporting (SV-21): the adapter between the pure
// EngagementClock and the daemon.
//
// The clock knows nothing about ids, languages, sources or messaging; this
// stamps all four at flush time. Minting the UUID here (rather than in the
// clock) is what guarantees an id is never reused — the daemon dedupes on it,
// so a reused id would silently discard a real block of learning.
//
// Unlike the watched-line reporter — deliberately fire-and-forget, because a
// dropped line costs one line's exposure — a dropped session costs up to five
// MINUTES of credit. So this retries once. It still doesn't build a persistent
// queue: the daemon IS the outbox, and the only gap is the content→background
// hop, which a queue would cover at real MV3 complexity for a small residual.

import { EngagementClock, type ActivityKind, type ClockInputs, type SessionFlush } from './engagement-clock';
import { SaviEngagementSessionMessage } from './messages';

export interface EngagementReporterDeps {
    /** The saviEncounterRecording setting — one intent: "record what I watch". */
    enabled: () => Promise<boolean>;
    /** The account-roaming target language ('' = not set → don't report). */
    targetLanguage: () => Promise<string>;
    /** Platform-stable episode id for the current page, or `undefined` while
     *  the page has not settled onto one (Netflix mid-navigation). */
    episodeId: () => string | undefined;
    /** Monotonic timestamp of the user's last interaction. */
    lastInteractionAt: () => number;
    /** Called once per flush to DRAIN the speech that played since the last
     *  flush (SV-30 measured WPM). `undefined` = nothing accrued — the block
     *  then carries no speech fields rather than fake zeros. */
    speechStats?: () => { speakingMs: number; spokenTokenCount: number } | undefined;
    /** The session's gloss environment: 'glossed' while auto-gloss labels are
     *  active for the target language, else 'bare'. Sampled at flush time. */
    glossMode?: () => 'bare' | 'glossed' | undefined;
    /** Deliver the message to the background (browser.runtime.sendMessage). */
    send: (message: SaviEngagementSessionMessage) => Promise<unknown>;
    /** Monotonic clock; injected for tests. */
    now?: () => number;
    /** Wall clock; injected for tests. */
    wallNow?: () => number;
    /** Injected for tests (crypto.randomUUID is unavailable in some contexts). */
    newId?: () => string;
}

/** What the page is doing right now, sampled by the binding's heartbeat. */
export interface PlaybackSample {
    playing: boolean;
    visible: boolean;
    focused: boolean;
    /** `video.played.length > 0` and `video.ended` — see `ClockInputs`. These
     *  stop paused-but-present time counting before the first play (browsing a
     *  title) or after the end (the credits). Optional so a caller with no
     *  media is unaffected. */
    everPlayed?: boolean;
    ended?: boolean;
}

export class SaviEngagementReporter {
    private readonly _deps: EngagementReporterDeps;
    private readonly _clock: EngagementClock;
    private _armed = false;
    private _lang = '';
    /** Captured per block, so an SPA episode change mid-block can't
     *  re-attribute already-accrued time to the next episode. */
    private _episodeId = '';

    constructor(deps: EngagementReporterDeps) {
        this._deps = deps;
        this._clock = new EngagementClock({
            foregroundKind: 'watch',
            // A playing video in a hidden or unfocused tab still reaches the
            // user as audio — shallower processing, but real exposure.
            backgroundKind: 'listen',
            onFlush: (session) => this._emit(session),
        });
    }

    /** (Re)read the toggle + target language. Safe to call again on a settings
     *  refresh; arming requires both. */
    async start(): Promise<void> {
        try {
            const [enabled, lang] = await Promise.all([this._deps.enabled(), this._deps.targetLanguage()]);
            this._lang = lang;
            this._armed = enabled && lang !== '';
        } catch (e) {
            this._armed = false;
        }
        if (!this._armed) {
            // Drop rather than emit: time accrued while we were unsure whether
            // recording was even wanted shouldn't be sent.
            this._clock.reset();
        }
    }

    /** Sample the world. Called from the binding's existing 1 s heartbeat —
     *  no new listeners, and no coupling to the capture controller, whose
     *  video listeners only exist while a capture is actually recording. */
    tick(sample: PlaybackSample): void {
        if (!this._armed) {
            return;
        }
        if (this._episodeId === '') {
            this._episodeId = this._deps.episodeId() ?? '';
        }
        const inputs: ClockInputs = {
            playing: sample.playing,
            visible: sample.visible,
            focused: sample.focused,
            lastInteractionAt: this._deps.lastInteractionAt(),
            everPlayed: sample.everPlayed,
            ended: sample.ended,
        };
        this._clock.tick((this._deps.now ?? (() => performance.now()))(), (this._deps.wallNow ?? Date.now)(), inputs);
    }

    /** Emit whatever has accrued — pagehide, or an episode change. */
    flush(): void {
        this._clock.flush();
        this._episodeId = '';
    }

    /** Flush and disarm (unbind / teardown). */
    stop(): void {
        this.flush();
        this._armed = false;
    }

    private _emit(session: SessionFlush): void {
        const episodeId = this._episodeId || this._deps.episodeId() || '';
        this._episodeId = '';
        // Drained unconditionally so cues shown during a discarded block can't
        // leak into the next one.
        const speech = this._deps.speechStats?.();
        const message: SaviEngagementSessionMessage = {
            command: 'savi-engagement-session',
            id: (this._deps.newId ?? (() => crypto.randomUUID()))(),
            kind: session.kind as ActivityKind,
            lang: this._lang,
            source: episodeId ? `watch:${episodeId}` : undefined,
            engagedMs: session.engagedMs,
            startedAtMs: session.startedAtMs,
            endedAtMs: session.endedAtMs,
            // Recorded at capture time because it can never be reconstructed:
            // without it, moving timezones retroactively re-buckets history.
            tzOffsetMin: -new Date().getTimezoneOffset(),
            ...(speech ?? {}),
            glossMode: this._deps.glossMode?.(),
        };
        this._send(message, true);
    }

    private _send(message: SaviEngagementSessionMessage, retry: boolean): void {
        const fail = (reason: unknown) => {
            if (retry) {
                // The id is stable across both attempts, so a first attempt
                // that actually landed is deduped daemon-side rather than
                // double-credited.
                this._send(message, false);
                return;
            }
            console.warn('savi: engagement session dropped', reason);
        };
        // The background answers `{ ok: false }` for a daemon failure instead
        // of rejecting, so checking only for a rejection would miss exactly
        // the case worth retrying.
        this._deps.send(message).then((response) => {
            if ((response as { ok?: boolean } | undefined)?.ok !== true) {
                fail(response);
            }
        }, fail);
    }
}
