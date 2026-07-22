// Background-side orchestration for savi capture, registered as one
// extra CommandHandler in asbplayer's background handler list.
//
// SV-18: the daemon records audio through its own system tap, so the
// background owns the whole session lifecycle — daemon start/subtitles,
// relaying playback-state segment cuts (with a persisted monotonic seq),
// and finish. The session record lives in storage.session (capture-session
// module) so it survives MV3 service-worker restarts. No offscreen document
// and no tabCapture are involved anymore.

import { SettingsProvider } from '@project/common/settings';
import { CommandHandler } from '@/handlers/command-handler';
import {
    SaviCaptureEndedToVideoMessage,
    SaviCaptureFrameResponse,
    SaviCaptureState,
    SaviCommand,
    SaviGlossTranslateMessage,
    SaviGlossTranslateResponse,
    SaviWordBucketsMessage,
    SaviWordBucketsResponse,
    SaviDictMessage,
    SaviDictResponse,
    SaviEpisodeTranscriptMessage,
    SaviEpisodeTranscriptResponse,
    SaviMineLineMessage,
    SaviMineLineResponse,
    SaviOpenSubtitlesFetchMessage,
    SaviOpenSubtitlesFetchResponse,
    SaviPlaybackStateMessage,
    SaviPlaybackStateResponse,
    SaviRoamingSettingsResponse,
    SaviRequestStartMessage,
    SaviSegmentLineMessage,
    SaviSegmentLineResponse,
    SaviExplainWordMessage,
    SaviExplainWordResponse,
    SaviKanjiMessage,
    SaviKanjiResponse,
    SaviStartCaptureMessage,
    SaviStartCaptureResponse,
    SaviStopCaptureMessage,
    SaviStopCaptureResponse,
    SaviTokenizeMessage,
    SaviTokenizeResponse,
    SaviWatchedLineMessage,
    SaviWatchedLineResponse,
} from './messages';
import { daemonToken } from './account';
import { resolveCloudBase, translate as cloudTranslate, wordBuckets as cloudWordBuckets } from './cloud-client';
import {
    clearCaptureSession,
    getCaptureSession,
    nextPlaybackSeq,
    setCaptureSession,
    CaptureSessionRecord,
    SaviCaptureAudio,
} from './capture-session';
import {
    browserHintFromUserAgent,
    finishCapture,
    lookupDict,
    mineLine,
    normalizedBaseUrl,
    postEpisodeTranscript,
    postPlaybackState,
    postSubtitles,
    postWatchedLine,
    SaviDaemonConfig,
    segmentLine,
    explainWord,
    lookupKanji,
    startCapture,
    tokenize,
} from './daemon-client';
import {
    getCachedDict,
    getCachedSegment,
    getCachedTokens,
    putCachedDict,
    putCachedSegment,
    putCachedTokens,
} from './persistent-cache';
import { captureVisibleTab } from '@/services/capture-visible-tab';
import { OpenSubtitlesClient } from '@/services/subtitle-sources';
import { getCachedRoamingSettings, loadRoamingSettings } from './cloud-settings';

export default class SaviCommandHandler implements CommandHandler {
    private readonly _settings: SettingsProvider;

    constructor(settings: SettingsProvider) {
        this._settings = settings;
    }

    get sender() {
        return ['savi-video', 'savi-popup'];
    }

    get command() {
        return null;
    }

    handle(command: any, sender: Browser.runtime.MessageSender, sendResponse: (response?: any) => void) {
        switch (command.message.command) {
            case 'savi-start-capture':
                this._startCapture(command.message as SaviStartCaptureMessage, sender)
                    .then(sendResponse)
                    .catch((e) => {
                        console.error('savi: start capture failed', e);
                        sendResponse({
                            started: false,
                            errorCode: 'other',
                            errorMessage: e instanceof Error ? e.message : String(e),
                        } as SaviStartCaptureResponse);
                    });
                return true;
            case 'savi-stop-capture':
                this._stopCapture().then(sendResponse);
                return true;
            case 'savi-playback-state':
                this._playbackState(command.message as SaviPlaybackStateMessage, sender)
                    .then(sendResponse)
                    .catch(() => sendResponse({ ok: false } as SaviPlaybackStateResponse));
                return true;
            case 'savi-capture-state':
                this._captureState().then(sendResponse);
                return true;
            case 'savi-request-start':
                this._requestStart(command.message as SaviRequestStartMessage).then(sendResponse);
                return true;
            case 'savi-tokenize':
                this._tokenize(command.message as SaviTokenizeMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({ tokens: [] }));
                return true;
            case 'savi-segment-line':
                this._segment(command.message as SaviSegmentLineMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({ ai: false, tokens: [] }));
                return true;
            case 'savi-explain-word':
                this._explain(command.message as SaviExplainWordMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({ explanation: null }));
                return true;
            case 'savi-kanji':
                this._kanji(command.message as SaviKanjiMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({ kanji: [] }));
                return true;
            case 'savi-dict':
                this._lookupDict(command.message as SaviDictMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({ entries: [], kanji: [] }));
                return true;
            case 'savi-episode-transcript':
                this._storeEpisodeTranscript(command.message as SaviEpisodeTranscriptMessage).then(sendResponse);
                return true;
            case 'savi-watched-line':
                this._watchedLine(command.message as SaviWatchedLineMessage).then(sendResponse);
                return true;
            case 'savi-mine-line':
                this._mineLine(command.message as SaviMineLineMessage)
                    .then(sendResponse)
                    .catch((e) =>
                        sendResponse({
                            ok: false,
                            errorMessage: e instanceof Error ? e.message : String(e),
                        } as SaviMineLineResponse)
                    );
                return true;
            case 'savi-capture-frame':
                this._captureFrame(sender)
                    .then(sendResponse)
                    .catch(() => sendResponse({} as SaviCaptureFrameResponse));
                return true;
            case 'savi-opensubtitles-fetch':
                this._fetchOpenSubtitles(command.message as SaviOpenSubtitlesFetchMessage)
                    .then(sendResponse)
                    .catch((e) =>
                        sendResponse({
                            ok: false,
                            errorMessage: e instanceof Error ? e.message : String(e),
                        } as SaviOpenSubtitlesFetchResponse)
                    );
                return true;
            case 'savi-roaming-settings':
                this._roamingSettings()
                    .then(sendResponse)
                    .catch(() => sendResponse(undefined));
                return true;
            case 'savi-gloss-translate':
                this._glossTranslate(command.message as SaviGlossTranslateMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({} as SaviGlossTranslateResponse));
                return true;
            case 'savi-word-buckets':
                this._wordBuckets(command.message as SaviWordBucketsMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({ buckets: {} } as SaviWordBucketsResponse));
                return true;
        }

        return false;
    }

    // Bearer preference: the signed-in account's JWT, else the legacy LAN
    // token setting (the transition fallback). Resolved per request — JWTs
    // expire ~hourly.
    private async _daemonConfig(): Promise<SaviDaemonConfig | null> {
        const { saviDaemonUrl, saviDaemonToken } = await this._settings.get(['saviDaemonUrl', 'saviDaemonToken']);
        const token = await daemonToken(saviDaemonToken);
        if (!saviDaemonUrl.trim() || !token) {
            return null;
        }
        return { baseUrl: normalizedBaseUrl(saviDaemonUrl), token };
    }

    // SV-8 fallback: search OpenSubtitles for the target-language subtitle when
    // the streaming player exposed none. The consumer API key comes from the
    // roaming account settings; an absent key or no result is a soft ok:false.
    private async _fetchOpenSubtitles(message: SaviOpenSubtitlesFetchMessage): Promise<SaviOpenSubtitlesFetchResponse> {
        const { openSubtitlesApiKey } = await getCachedRoamingSettings();

        if (openSubtitlesApiKey.trim().length === 0) {
            return { ok: false };
        }

        const client = new OpenSubtitlesClient({ apiKey: openSubtitlesApiKey });
        const subtitle = await client.fetchBestSubtitle({
            query: message.query,
            languages: message.languages,
            seasonNumber: message.seasonNumber,
            episodeNumber: message.episodeNumber,
        });

        if (subtitle === undefined) {
            return { ok: false };
        }

        return { ok: true, name: subtitle.fileName, content: subtitle.content };
    }

    // Fresh roaming settings from the cloud (refreshing the local cache), so a
    // target language changed on another device takes effect on the next video.
    // loadRoamingSettings already falls back to the cache when signed out /
    // offline, so this never blocks the auto-load on the network.
    private async _roamingSettings(): Promise<SaviRoamingSettingsResponse> {
        const { saviCloudUrl } = await this._settings.get(['saviCloudUrl']);
        // Dev builds roam against the local cloud too (resolveCloudBase), so the
        // target language the desktop wrote to localhost actually reaches here.
        const { targetLanguage, openSubtitlesApiKey } = await loadRoamingSettings(resolveCloudBase(saviCloudUrl));
        return { targetLanguage, openSubtitlesApiKey };
    }

    // Glossing (SV-12): translate ONE word into the user's known language, with
    // the whole line as DeepL context. Straight to the cloud with the account
    // JWT (added in cloud-client) — CORS blocks this from the content script.
    // Empty response = signed out / all providers failed → the label is skipped.
    private async _glossTranslate(message: SaviGlossTranslateMessage): Promise<SaviGlossTranslateResponse> {
        try {
            const { saviCloudUrl } = await this._settings.get(['saviCloudUrl']);
            // cloud-client.translate(cloudUrl, text, targetLang=INTO, sourceLang=FROM, context):
            // the word is FROM the learning language, translated INTO the gloss language.
            const result = await cloudTranslate(
                saviCloudUrl,
                message.word,
                message.glossLang,
                message.targetLang,
                message.context
            );
            return { text: result.text, provider: result.provider };
        } catch (e) {
            return {};
        }
    }

    // Glossing (SV-13): the Known-inclusive per-lemma buckets for the target
    // language, so the content script glosses a word iff its lemma is not yet
    // Known. Empty map = signed out / unreachable → gloss all content words.
    private async _wordBuckets(message: SaviWordBucketsMessage): Promise<SaviWordBucketsResponse> {
        try {
            const { saviCloudUrl } = await this._settings.get(['saviCloudUrl']);
            return { buckets: await cloudWordBuckets(saviCloudUrl, message.lang) };
        } catch (e) {
            return { buckets: {} };
        }
    }

    private async _tokenize(message: SaviTokenizeMessage): Promise<SaviTokenizeResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            // No daemon configured — serve anything we tokenized before.
            return { tokens: (await getCachedTokens(message.lang, message.text)) ?? [] };
        }
        try {
            const tokens = await tokenize(config, message.lang, message.text);
            if (tokens.length > 0) {
                await putCachedTokens(message.lang, message.text, tokens);
            }
            return { tokens };
        } catch (e) {
            // Daemon unreachable — fall back to the persistent cache so a
            // previously-seen line still hovers offline.
            return { tokens: (await getCachedTokens(message.lang, message.text)) ?? [] };
        }
    }

    // AI context-aware segmentation. Gated on the `saviAiSegmentation` setting:
    // off → empty so the content script keeps its rule-based tokens. Cache-first
    // (a previously AI-segmented line still upgrades while the daemon is offline).
    private async _segment(message: SaviSegmentLineMessage): Promise<SaviSegmentLineResponse> {
        const { saviAiSegmentation } = await this._settings.get(['saviAiSegmentation']);
        if (!saviAiSegmentation) {
            return { ai: false, tokens: [] };
        }
        const config = await this._daemonConfig();
        if (!config) {
            return (await getCachedSegment(message.lang, message.text)) ?? { ai: false, tokens: [] };
        }
        try {
            const result = await segmentLine(config, message.lang, message.text, {
                prevLines: message.prevLines,
                nextLines: message.nextLines,
                episodeId: message.episodeId,
            });
            if (result.ai && result.tokens.length > 0) {
                await putCachedSegment(message.lang, message.text, result.ai, result.tokens);
            }
            return result;
        } catch (e) {
            return (await getCachedSegment(message.lang, message.text)) ?? { ai: false, tokens: [] };
        }
    }

    // Professor-style in-context explanation of one word (the tap panel's teaching
    // note). Gated on saviAiSegmentation; null when off / no daemon / all fail. The
    // daemon disk-caches explanations, so a repeat is instant without an LLM call.
    private async _explain(message: SaviExplainWordMessage): Promise<SaviExplainWordResponse> {
        const { saviAiSegmentation } = await this._settings.get(['saviAiSegmentation']);
        if (!saviAiSegmentation) {
            return { explanation: null };
        }
        const config = await this._daemonConfig();
        if (!config) {
            return { explanation: null };
        }
        try {
            const explanation = await explainWord(config, message.lang, message.term, message.text, {
                reading: message.reading,
                prevLines: message.prevLines,
                nextLines: message.nextLines,
                episodeId: message.episodeId,
            });
            return { explanation };
        } catch (e) {
            return { explanation: null };
        }
    }

    // Full kanji breakdown for the tap panel (offline KANJIDIC/RTK data — no LLM,
    // so it's not gated on the AI setting). Empty on no-daemon/error.
    private async _kanji(message: SaviKanjiMessage): Promise<SaviKanjiResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            return { kanji: [] };
        }
        try {
            const kanji = await lookupKanji(config, message.lang, message.term);
            return { kanji };
        } catch (e) {
            return { kanji: [] };
        }
    }

    private async _lookupDict(message: SaviDictMessage): Promise<SaviDictResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            const cached = await getCachedDict(message.lang, message.term);
            return cached ?? { entries: [], kanji: [] };
        }
        try {
            const result = await lookupDict(config, message.lang, message.term);
            // Persist non-empty results so they survive reloads + a daemon-down spell.
            if (result.entries.length > 0 || result.kanji.length > 0) {
                await putCachedDict(message.lang, message.term, result.entries, result.kanji);
            }
            return { entries: result.entries, kanji: result.kanji };
        } catch (e) {
            const cached = await getCachedDict(message.lang, message.term);
            return cached ?? { entries: [], kanji: [] };
        }
    }

    private async _storeEpisodeTranscript(
        message: SaviEpisodeTranscriptMessage
    ): Promise<SaviEpisodeTranscriptResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            return { ok: false };
        }
        try {
            await postEpisodeTranscript(config, {
                episodeId: message.episodeId,
                content: message.subtitles,
                format: message.subtitleFormat,
            });
            return { ok: true };
        } catch (e) {
            // Best-effort — without it the card just falls back to the scene window.
            return { ok: false };
        }
    }

    private async _watchedLine(message: SaviWatchedLineMessage): Promise<SaviWatchedLineResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            return { ok: false };
        }
        try {
            await postWatchedLine(config, {
                lang: message.lang,
                text: message.text,
                source: `watch:${message.episodeId}:${message.lineStartMs}`,
                occurredAtMs: message.occurredAtMs,
            });
            return { ok: true };
        } catch (e) {
            // Fire-and-forget contract: a dropped line loses one line's exposure.
            return { ok: false };
        }
    }

    private async _mineLine(message: SaviMineLineMessage): Promise<SaviMineLineResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            return { ok: false, errorMessage: 'savi daemon URL/token not set' };
        }
        try {
            const result = await mineLine(config, {
                episodeId: message.episodeId,
                lineText: message.lineText,
                surface: message.surface,
                term: message.term,
                reading: message.reading,
                deck: message.deck,
                imageBase64: message.imageBase64,
            });
            return {
                ok: result.ok,
                noteId: result.noteId,
                hadAudio: result.hadAudio,
                hadImage: result.hadImage,
                enriched: result.enriched,
            };
        } catch (e) {
            return { ok: false, errorMessage: e instanceof Error ? e.message : String(e) };
        }
    }

    // Capture the full visible tab as a JPEG data URL (background-only API).
    // The content script crops it to the video region and forwards the base64
    // to the daemon with the mine request.
    private async _captureFrame(sender: Browser.runtime.MessageSender): Promise<SaviCaptureFrameResponse> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return {};
        }
        try {
            return { dataUrl: await captureVisibleTab(tabId) };
        } catch (e) {
            return {};
        }
    }

    private async _startCapture(
        message: SaviStartCaptureMessage,
        sender: Browser.runtime.MessageSender
    ): Promise<SaviStartCaptureResponse> {
        const tabId = sender.tab?.id;

        if (tabId === undefined) {
            return { started: false, errorCode: 'other', errorMessage: 'no tab id for capture request' };
        }

        const config = await this._daemonConfig();

        if (!config) {
            return {
                started: false,
                errorCode: 'not-configured',
                errorMessage: 'sign in to savi (or set a daemon token) in the extension settings',
            };
        }

        const existing = await getCaptureSession();

        if (existing !== undefined) {
            // One session at a time (the daemon has one tap). A session whose
            // tab is gone is stale bookkeeping — sweep it and continue.
            try {
                await browser.tabs.get(existing.tabId);
                return {
                    started: false,
                    errorCode: 'already-capturing',
                    errorMessage: 'a savi capture is already running',
                };
            } catch (e) {
                await clearCaptureSession();
            }
        }

        const { saviAudioRecording } = await this._settings.get(['saviAudioRecording']);
        let captureId: string;
        let audio: SaviCaptureAudio;

        try {
            const result = await startCapture(config, {
                episodeId: message.episodeId,
                show: message.show,
                title: message.title,
                lang: message.lang,
                audio: saviAudioRecording,
                browser: browserHintFromUserAgent(navigator.userAgent),
            });
            captureId = result.captureId;
            // A pre-SV-18 daemon ignores the audio field entirely — surface
            // that as unavailable so the user knows to update.
            audio = (result.audio as SaviCaptureAudio | undefined) ?? {
                state: 'unavailable',
                reason: 'the savi daemon predates desktop audio capture — update the desktop app',
            };
            await postSubtitles(config, {
                captureId,
                content: message.subtitles,
                format: message.subtitleFormat,
            });
        } catch (e) {
            return {
                started: false,
                errorCode: 'daemon-unreachable',
                errorMessage: e instanceof Error ? e.message : String(e),
            };
        }

        await setCaptureSession({
            tabId,
            src: message.src,
            captureId,
            episodeId: message.episodeId,
            title: message.title,
            seq: 0,
            audio,
        });
        return { started: true, captureId, audio };
    }

    private async _stopCapture(): Promise<SaviStopCaptureResponse> {
        const session = await getCaptureSession();

        if (session === undefined) {
            return { stopped: false, errorMessage: 'no savi capture is running' };
        }

        const config = await this._daemonConfig();
        await clearCaptureSession();

        if (!config) {
            // The daemon keeps the session resumable; nothing to finish now.
            return { stopped: false, errorMessage: 'sign in to savi (or set a daemon token) to finish' };
        }

        // Acknowledge immediately; the finish result (stitching can take a
        // while) travels out-of-band as savi-capture-ended. The pending fetch
        // keeps the service worker alive; if the worker is killed anyway, the
        // daemon still completes the finish — only the toast is lost.
        void this._finishAndNotify(config, session);
        return { stopped: true };
    }

    private async _finishAndNotify(config: SaviDaemonConfig, session: CaptureSessionRecord): Promise<void> {
        let ended: SaviCaptureEndedToVideoMessage;

        try {
            const info = await finishCapture(config, session.captureId);
            ended = { command: 'savi-capture-ended', src: session.src, ok: true, info };
        } catch (e) {
            ended = {
                command: 'savi-capture-ended',
                src: session.src,
                ok: false,
                errorMessage: e instanceof Error ? e.message : String(e),
            };
        }

        const command: SaviCommand<SaviCaptureEndedToVideoMessage> = {
            sender: 'savi-extension-to-video',
            message: ended,
        };
        browser.tabs.sendMessage(session.tabId, command).catch(() => {});
    }

    // Playback-state relay: per-batch seq allocated (and persisted) up front,
    // batches serialized through a promise chain so HTTP ordering matches op
    // ordering, one retry for transient network failures, then drop with a
    // warning (the daemon's stitcher self-heals a lost segment-end).
    private _playbackChain: Promise<unknown> = Promise.resolve();

    private async _playbackState(
        message: SaviPlaybackStateMessage,
        sender: Browser.runtime.MessageSender
    ): Promise<SaviPlaybackStateResponse> {
        const tabId = sender.tab?.id;
        const run = this._playbackChain.then(async (): Promise<SaviPlaybackStateResponse> => {
            const allocated = await nextPlaybackSeq();

            if (allocated === undefined || (tabId !== undefined && allocated.session.tabId !== tabId)) {
                return { ok: false };
            }

            const config = await this._daemonConfig();

            if (!config) {
                return { ok: false };
            }

            const { session, seq } = allocated;
            const post = () =>
                postPlaybackState(config, { captureId: session.captureId, seq, ops: message.ops });

            try {
                const result = await post();
                return { ok: result.ok, audio: result.audio };
            } catch (e) {
                try {
                    // Same seq on retry: the daemon never saw the failed send.
                    const result = await post();
                    return { ok: result.ok, audio: result.audio };
                } catch (e2) {
                    console.warn('savi: playback-state batch dropped', e2);
                    return { ok: false };
                }
            }
        });
        this._playbackChain = run.catch(() => {});
        return run;
    }

    private async _captureState(): Promise<SaviCaptureState> {
        const session = await getCaptureSession();

        if (session === undefined) {
            return { active: false };
        }

        return { active: true, episodeId: session.episodeId, title: session.title, tabId: session.tabId };
    }

    private async _requestStart(message: SaviRequestStartMessage): Promise<{ requested: boolean }> {
        try {
            const command: SaviCommand<{ command: 'savi-request-start' }> = {
                sender: 'savi-extension-to-video',
                message: { command: 'savi-request-start' },
            };
            const response = await browser.tabs.sendMessage(message.tabId, command);
            return { requested: response?.requested === true };
        } catch (e) {
            return { requested: false };
        }
    }

}

/** Finish the in-flight capture when its tab closes (wired to tabs.onRemoved
 *  in the background entrypoint). Best-effort: on any failure the daemon
 *  keeps the session resumable on disk. */
export const finishCaptureForClosedTab = async (tabId: number, settings: SettingsProvider): Promise<void> => {
    const session = await getCaptureSession();

    if (session === undefined || session.tabId !== tabId) {
        return;
    }

    await clearCaptureSession();
    const { saviDaemonUrl, saviDaemonToken } = await settings.get(['saviDaemonUrl', 'saviDaemonToken']);
    const token = await daemonToken(saviDaemonToken);

    if (!saviDaemonUrl.trim() || !token) {
        return;
    }

    try {
        await finishCapture({ baseUrl: normalizedBaseUrl(saviDaemonUrl), token }, session.captureId);
    } catch (e) {
        console.warn('savi: finishing capture for closed tab failed', e);
    }
};
