// Background-side orchestration for savi capture, registered as one
// extra CommandHandler in asbplayer's background handler list.
//
// Responsibilities that can only live here: minting tabCapture stream
// ids, ensuring the offscreen document exists, and talking to the savi
// daemon for capture start (the offscreen document owns chunk upload and
// finish so captures survive service-worker sleep).

import { SettingsProvider } from '@project/common/settings';
import { CommandHandler } from '@/handlers/command-handler';
import { ensureOffscreenAudioServiceDocument } from '@/services/offscreen-document';
import {
    SaviCaptureEndedMessage,
    SaviCaptureEndedToVideoMessage,
    SaviCaptureFrameResponse,
    SaviCaptureState,
    SaviCommand,
    SaviGlossTranslateMessage,
    SaviGlossTranslateResponse,
    SaviWordBucketsMessage,
    SaviWordBucketsResponse,
    SaviOffscreenStartMessage,
    SaviOffscreenStateMessage,
    SaviOffscreenStopMessage,
    SaviDictMessage,
    SaviDictResponse,
    SaviEpisodeTranscriptMessage,
    SaviEpisodeTranscriptResponse,
    SaviMineLineMessage,
    SaviMineLineResponse,
    SaviOpenSubtitlesFetchMessage,
    SaviOpenSubtitlesFetchResponse,
    SaviRoamingSettingsResponse,
    SaviRequestStartMessage,
    SaviGetIntentResponse,
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
} from './messages';
import { daemonToken } from './account';
import { translate as cloudTranslate, wordBuckets as cloudWordBuckets } from './cloud-client';
import { clearRecordingIntent, hasRecordingIntent, setRecordingIntent } from './recording-intent';
import {
    lookupDict,
    mineLine,
    normalizedBaseUrl,
    postEpisodeTranscript,
    postSubtitles,
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
        return ['savi-video', 'savi-popup', 'savi-offscreen'];
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
                this._stopCapture(command.message as SaviStopCaptureMessage, sender).then(sendResponse);
                return true;
            case 'savi-get-intent':
                this._getIntent(sender).then(sendResponse);
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
            case 'savi-capture-ended':
                this._forwardCaptureEnded(command.message as SaviCaptureEndedMessage);
                break;
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
        const { targetLanguage, openSubtitlesApiKey } = await loadRoamingSettings(saviCloudUrl);
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

        const { saviDaemonToken } = await this._settings.get(['saviDaemonToken']);
        const config = await this._daemonConfig();

        if (!config) {
            return {
                started: false,
                errorCode: 'not-configured',
                errorMessage: 'sign in to savi (or set a daemon token) in the extension settings',
            };
        }

        const state = await this._captureState();

        if (state.active) {
            return {
                started: false,
                errorCode: 'already-capturing',
                errorMessage: 'a savi capture is already running',
            };
        }

        let captureId: string;

        try {
            captureId = await startCapture(config, {
                episodeId: message.episodeId,
                show: message.show,
                title: message.title,
                lang: message.lang,
            });
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

        await ensureOffscreenAudioServiceDocument();
        const streamId = await this._mediaStreamId(tabId);

        const offscreenCommand: SaviCommand<SaviOffscreenStartMessage> = {
            sender: 'savi-extension-to-offscreen',
            message: {
                command: 'savi-offscreen-start',
                streamId,
                captureId,
                episodeId: message.episodeId,
                show: message.show,
                title: message.title,
                baseUrl: config.baseUrl,
                // The LAN fallback only — the offscreen document re-resolves
                // the account token per chunk (a capture outlives a JWT).
                lanToken: saviDaemonToken.trim(),
                requester: { tabId, src: message.src },
            },
        };
        const response = (await browser.runtime.sendMessage(offscreenCommand)) as {
            started: boolean;
            errorCode?: string;
            errorMessage?: string;
        };

        if (!response?.started) {
            // No heavy "enable audio recording" modal here anymore — the
            // content-side capture controller shows a light toast (pointing at
            // the Ctrl+Shift+S shortcut) only when the user explicitly asked to
            // record, and stays silent on the every-reload auto-start.
            return {
                started: false,
                errorCode: response?.errorCode === 'no-active-tab' ? 'no-active-tab' : 'other',
                errorMessage: response?.errorMessage ?? 'failed to start recording',
            };
        }

        // Capture truly started — mark this tab so a later reload's silently
        // failing auto-start can tell "you were recording" from "never started".
        await setRecordingIntent(tabId);
        return { started: true, captureId };
    }

    private async _stopCapture(
        message: SaviStopCaptureMessage,
        sender: Browser.runtime.MessageSender
    ): Promise<SaviStopCaptureResponse> {
        // A DELIBERATE user stop clears the tab's recording intent so a later
        // reload doesn't nag to resume. A reload / next-episode / video-end stop
        // sends clearIntent=false, keeping intent so the guard can prompt.
        if (message.clearIntent && sender.tab?.id !== undefined) {
            await clearRecordingIntent(sender.tab.id);
        }
        try {
            const command: SaviCommand<SaviOffscreenStopMessage> = {
                sender: 'savi-extension-to-offscreen',
                message: { command: 'savi-offscreen-stop' },
            };
            return (await browser.runtime.sendMessage(command)) as SaviStopCaptureResponse;
        } catch (e) {
            return { stopped: false, errorMessage: e instanceof Error ? e.message : String(e) };
        }
    }

    private async _getIntent(sender: Browser.runtime.MessageSender): Promise<SaviGetIntentResponse> {
        return { intentSet: await hasRecordingIntent(sender.tab?.id) };
    }

    private async _captureState(): Promise<SaviCaptureState> {
        try {
            const command: SaviCommand<SaviOffscreenStateMessage> = {
                sender: 'savi-extension-to-offscreen',
                message: { command: 'savi-offscreen-state' },
            };
            const state = (await browser.runtime.sendMessage(command)) as SaviCaptureState | undefined;
            return state ?? { active: false };
        } catch (e) {
            // No offscreen document; nothing is capturing.
            return { active: false };
        }
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

    private _forwardCaptureEnded(message: SaviCaptureEndedMessage) {
        const command: SaviCommand<SaviCaptureEndedToVideoMessage> = {
            sender: 'savi-extension-to-video',
            message: {
                command: 'savi-capture-ended',
                src: message.requester.src,
                ok: message.ok,
                info: message.info,
                errorMessage: message.errorMessage,
            },
        };
        browser.tabs.sendMessage(message.requester.tabId, command).catch(() => {});
    }

    private _mediaStreamId(tabId: number): Promise<string> {
        return new Promise((resolve) => {
            browser.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => resolve(streamId));
        });
    }
}
