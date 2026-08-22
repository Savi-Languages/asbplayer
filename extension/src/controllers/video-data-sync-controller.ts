import {
    ActiveProfileMessage,
    ConfirmedVideoDataSubtitleTrack,
    OpenAsbplayerSettingsMessage,
    SerializedSubtitleFile,
    SettingsUpdatedMessage,
    VideoData,
    VideoDataSubtitleTrack,
    VideoDataUiBridgeConfirmMessage,
    VideoDataUiBridgeDownloadOnlineSubtitleMessage,
    VideoDataUiBridgeSearchOnlineSubtitlesMessage,
    VideoDataUiBridgeOpenFileMessage,
    VideoDataUiBridgeSetOnlineSubtitleSourceConfigMessage,
    VideoDataUiModel,
    VideoDataUiOpenReason,
    VideoToExtensionCommand,
} from '@project/common';
import { AsbplayerSettings, SettingsProvider } from '@project/common/settings';
import { base64ToBlob, bufferToBase64 } from '@project/common/base64';
import Binding from '../services/binding';
import { currentPageDelegate } from '../services/pages';
import UiFrame, { uiFrameForHtml } from '../services/ui-frame';
import { fetchLocalization } from '../services/localization-fetcher';
import i18n from 'i18next';
import { ExtensionGlobalStateProvider } from '@/services/extension-global-state-provider';
import { isOnTutorialPage } from '@/services/tutorial';
import { extractExtension } from '@/pages/util';
import { parseShowQuery, primarySubtag, selectNativeTrack, selectTrackForLanguage } from '@/savi/track-select';
import { decideLanguageGate } from '@/savi/language-gate';
import { titlesOverlap } from '@/savi/subtitle-relevance';
import { mutedEpisodes } from '@/savi/muted-episodes';
import { mutedSites, siteKeyForUrl } from '@/savi/muted-sites';
import { deriveEpisodeId } from '@/savi/episode';
import { displayNameFor, localVideoName, videoFilenameFromUrl, type ParsedVideoName } from '@/savi/local-video';
import { getCachedRoamingSettings, SaviRoamingSettings } from '@/savi/cloud-settings';
import {
    SaviCommand,
    SaviOpenSubtitlesFetchMessage,
    SaviOpenSubtitlesFetchResponse,
    SaviOpenSubtitlesSearchMessage,
    SaviOpenSubtitlesSearchResponse,
    SaviOpenSubtitlesDownloadMessage,
    SaviOpenSubtitlesDownloadResponse,
    SaviRoamingSettingsMessage,
    SaviRoamingSettingsResponse,
} from '@/savi/messages';

declare global {
    function cloneInto(obj: any, targetScope: any, options?: any): any;
}

async function html(lang: string) {
    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>asbplayer - Video Data Sync</title>
                <style>
                    @import url(${browser.runtime.getURL('/fonts/fonts.css')});
                </style>
            </head>
            <body>
                <div id="root" style="width:100%;height:100vh;"></div>
                <script type="application/json" id="loc">${JSON.stringify(await fetchLocalization(lang))}</script>
                <script type="module" src="${browser.runtime.getURL('/video-data-sync-ui.js')}"></script>
            </body>
            </html>`;
}

interface ShowOptions {
    reason: VideoDataUiOpenReason;
    fromAsbplayerId?: string;
}

const fetchDataForLanguageOnDemand = (language: string): Promise<VideoData> => {
    return new Promise((resolve, reject) => {
        const listener = (event: Event) => {
            const data = (event as CustomEvent).detail as VideoData;
            resolve(data);
            document.removeEventListener('asbplayer-synced-language-data', listener, false);
        };
        document.addEventListener('asbplayer-synced-language-data', listener, false);
        document.dispatchEvent(new CustomEvent('asbplayer-get-synced-language-data', { detail: language }));
    });
};

const globalStateProvider = new ExtensionGlobalStateProvider();

export default class VideoDataSyncController {
    private readonly _context: Binding;
    private readonly _domain: string;
    private readonly _frame: UiFrame;
    private readonly _settings: SettingsProvider;

    private _autoSync?: boolean;
    private _lastLanguagesSynced: { [key: string]: string[] };
    private _emptySubtitle: VideoDataSubtitleTrack;
    private _syncedData?: VideoData;
    /** Filename-derived identity for a delegate-less page (SV-44). Set only on
     *  that path; a streaming page leaves it undefined and keeps using the
     *  site's own basename. */
    private _localVideo?: ParsedVideoName;
    /** Whether the delegate-less page's URL actually named a video FILE, as
     *  opposed to a title scraped off an ordinary page. Gates the failure
     *  prompt — see `_syncGenericVideoPage`. */
    private _localVideoIsAFile = false;
    private _wasPaused?: boolean;
    private _playBlocker?: () => void;
    private _openedLocation?: string;
    private _fullscreenElement?: Element;
    private _activeElement?: Element;
    private _autoSyncAttempted: boolean = false;
    private _saviAutoLoadAttempted: boolean = false;
    private _dataReceivedListener?: (event: Event) => void;
    private _isTutorial: boolean;

    constructor(context: Binding, settings: SettingsProvider) {
        this._context = context;
        this._settings = settings;
        this._autoSync = false;
        this._lastLanguagesSynced = {};
        this._emptySubtitle = {
            id: '-',
            language: '-',
            url: '-',
            label: i18n.t('extension.videoDataSync.emptySubtitleTrack'),
            extension: 'srt',
        };
        this._domain = new URL(window.location.href).host;
        this._frame = uiFrameForHtml(html);
        this._isTutorial = isOnTutorialPage();
    }

    private get lastLanguagesSynced(): string[] {
        return this._lastLanguagesSynced[this._domain] ?? [];
    }

    private set lastLanguagesSynced(value: string[]) {
        this._lastLanguagesSynced[this._domain] = value;
    }

    unbind() {
        if (this._dataReceivedListener) {
            document.removeEventListener('asbplayer-synced-data', this._dataReceivedListener, false);
        }

        this._dataReceivedListener = undefined;
        this._syncedData = undefined;
        this._cleanupPlayBlocker();
        this._openedLocation = undefined;
    }

    updateSettings({ streamingAutoSync, streamingLastLanguagesSynced }: AsbplayerSettings) {
        this._autoSync = streamingAutoSync;
        this._lastLanguagesSynced = streamingLastLanguagesSynced;

        if (this._frame.clientIfLoaded !== undefined) {
            this._context.settings.getSingle('themeType').then((themeType) => {
                const profilesPromise = this._context.settings.profiles();
                const activeProfilePromise = this._context.settings.activeProfile();
                Promise.all([profilesPromise, activeProfilePromise]).then(([profiles, activeProfile]) => {
                    this._frame.clientIfLoaded?.updateState({
                        settings: {
                            themeType,
                            profiles,
                            activeProfile: activeProfile?.name,
                        },
                    });
                });
            });
        }
    }

    get pickerVisible(): boolean {
        return !this._frame.hidden;
    }

    get openedLocation(): string | undefined {
        return this._openedLocation;
    }

    async requestSubtitles() {
        // While the picker is open on the same location, skip refresh so
        // player events do not clobber an in-progress user selection. On a
        // true soft-navigation, dismiss the stale picker and continue.
        if (this.pickerVisible) {
            if (this.openedLocation !== undefined && window.location.href !== this.openedLocation) {
                this._hideAndResume();
            } else {
                return;
            }
        }

        const pageDelegate = await currentPageDelegate();

        // SV-44: a video played from disk (or on any site we have no delegate
        // for) has no page script to ask for tracks — which is exactly why
        // both gates below used to return here, taking the savi auto-load and
        // the picker with them. There is still a video and still a filename,
        // so it gets its own path rather than nothing.
        if (!this._context.hasPageScript || !pageDelegate?.isVideoPage()) {
            await this._syncGenericVideoPage();
            return;
        }

        this._localVideo = undefined;
        this._localVideoIsAFile = false;
        this._syncedData = undefined;
        this._autoSyncAttempted = false;
        this._saviAutoLoadAttempted = false;

        if (!this._dataReceivedListener) {
            this._dataReceivedListener = (event: Event) => {
                const data = (event as CustomEvent).detail as VideoData;
                this._setSyncedData(data);
            };
            document.addEventListener('asbplayer-synced-data', this._dataReceivedListener, false);
        }

        if (pageDelegate.config.key === 'youtube') {
            const targetTranslationLanguageCodes =
                (await this._settings.getSingle('streamingPages')).youtube.targetLanguages ?? [];
            let payload = { targetTranslationLanguageCodes };
            if (typeof cloneInto === 'function') {
                payload = cloneInto(payload, document.defaultView);
            }
            document.dispatchEvent(new CustomEvent('asbplayer-get-synced-data', { detail: payload }));
        } else {
            document.dispatchEvent(new CustomEvent('asbplayer-get-synced-data'));
        }
    }

    /**
     * Subtitle sync for a page with no delegate: a `file://` video, or any site
     * asbplayer does not know (SV-44).
     *
     * There is no page script to ask for tracks, so instead of dispatching
     * `asbplayer-get-synced-data` and awaiting a reply, we synthesize the same
     * `VideoData` locally from the filename and feed it through the identical
     * `_setSyncedData` path. Everything downstream — the savi auto-load, the
     * OpenSubtitles fallback, the picker — then works unchanged.
     *
     * `subtitles: []` (not `undefined`) is load-bearing: `undefined` means
     * "still loading" to `_setSyncedData` and the picker, and would leave both
     * waiting for a reply that is never coming. An empty array is the truth —
     * we looked, and a bare video element offers no tracks.
     */
    private async _syncGenericVideoPage() {
        this._syncedData = undefined;
        this._localVideo = undefined;
        this._localVideoIsAFile = false;
        this._autoSyncAttempted = false;
        this._saviAutoLoadAttempted = false;

        // Only bother when the page is actually playing something. Without
        // this, every ordinary web page with a stray <video> would mint an
        // episode out of its document title.
        if (!this._hasPlayableVideo()) {
            return;
        }

        const parsed = localVideoName(window.location.href, document.title);

        if (parsed.title.trim().length === 0) {
            console.info('[savi local video] no usable name from the URL or page title — not searching');
            return;
        }

        // Provenance decides whether a failed search is worth interrupting for.
        // A URL that names a video FILE means the user deliberately opened one
        // thing to watch; a name scraped from document.title could be any page
        // that happens to contain a <video>, and prompting on those would fire
        // on every news-site clip and autoplaying banner. See `_promptable`.
        this._localVideoIsAFile = videoFilenameFromUrl(window.location.href) !== undefined;
        this._localVideo = parsed;
        await this._setSyncedData({ basename: displayNameFor(parsed), subtitles: [] });
    }

    /** Whether this binding's video is a real, playing-capable media element —
     *  it has a source and a duration the browser could read. */
    private _hasPlayableVideo(): boolean {
        const video = this._context.video;
        if (!video) {
            return false;
        }
        const hasSource = Boolean(video.currentSrc || video.src);
        return hasSource && (Number.isFinite(video.duration) ? video.duration > 0 : true);
    }

    async show({ reason, fromAsbplayerId }: ShowOptions) {
        const client = await this._client();
        const additionalFields: Partial<VideoDataUiModel> = {
            open: true,
            openReason: reason,
        };

        if (fromAsbplayerId !== undefined) {
            additionalFields.openedFromAsbplayerId = fromAsbplayerId;
        }

        const model = await this._buildModel(additionalFields);
        this._prepareShow();
        client.updateState(model);
    }

    private async _buildModel(additionalFields: Partial<VideoDataUiModel>) {
        const subtitleTrackChoices = this._syncedData?.subtitles ?? [];
        const subs = this._matchLastSyncedWithAvailableTracks();
        const autoSelectedTracks: VideoDataSubtitleTrack[] = subs.autoSelectedTracks;
        const autoSelectedTrackIds = this._isTutorial
            ? // '1' is the ID of the non-empty track in the tutorial
              // See asbplayer-tutorial-page.ts
              ['1', '-', '-']
            : autoSelectedTracks.map((subtitle) => subtitle.id || '-');
        const defaultCheckboxState = !this._isTutorial && subs.completeMatch;
        const themeType = await this._context.settings.getSingle('themeType');
        const profilesPromise = this._context.settings.profiles();
        const activeProfilePromise = this._context.settings.activeProfile();
        const globalState = await globalStateProvider.get([
            'ftueHasSeenSubtitleTrackSelector',
            'onlineSubtitleSourceConfig',
        ]);
        const hasSeenFtue = globalState.ftueHasSeenSubtitleTrackSelector;
        const onlineSubtitleSourceConfig = globalState.onlineSubtitleSourceConfig;
        const hideRememberTrackPreferenceToggle = this._isTutorial || (await this._pageHidesTrackPrefToggle());
        return this._syncedData
            ? {
                  isLoading: this._syncedData.subtitles === undefined,
                  suggestedName: this._syncedData.basename,
                  selectedSubtitle: autoSelectedTrackIds,
                  subtitles: subtitleTrackChoices,
                  error: this._syncedData.error,
                  defaultCheckboxState: defaultCheckboxState,
                  openedFromAsbplayerId: '',
                  settings: {
                      themeType: themeType,
                      profiles: await profilesPromise,
                      activeProfile: (await activeProfilePromise)?.name,
                  },
                  hasSeenFtue,
                  hideRememberTrackPreferenceToggle,
                  onlineSubtitleSourceConfig,
                  ...additionalFields,
              }
            : {
                  isLoading: this._context.hasPageScript,
                  suggestedName: document.title,
                  selectedSubtitle: autoSelectedTrackIds,
                  error: '',
                  showSubSelect: true,
                  subtitles: subtitleTrackChoices,
                  defaultCheckboxState: defaultCheckboxState,
                  openedFromAsbplayerId: '',
                  settings: {
                      themeType: themeType,
                      profiles: await profilesPromise,
                      activeProfile: (await activeProfilePromise)?.name,
                  },
                  hasSeenFtue,
                  hideRememberTrackPreferenceToggle,
                  onlineSubtitleSourceConfig,
                  ...additionalFields,
              };
    }

    private _matchLastSyncedWithAvailableTracks() {
        const subtitleTrackChoices = this._syncedData?.subtitles ?? [];
        let tracks = {
            autoSelectedTracks: [this._emptySubtitle, this._emptySubtitle, this._emptySubtitle],
            completeMatch: false,
        };

        const emptyChoice = this.lastLanguagesSynced.some((lang) => lang !== '-') === undefined;

        if (!subtitleTrackChoices.length && emptyChoice) {
            tracks.completeMatch = true;
        } else {
            let matches: number = 0;
            for (let i = 0; i < this.lastLanguagesSynced.length; i++) {
                const language = this.lastLanguagesSynced[i];
                for (let j = 0; j < subtitleTrackChoices.length; j++) {
                    if (language === '-') {
                        matches++;
                        break;
                    } else if (language === subtitleTrackChoices[j].language) {
                        tracks.autoSelectedTracks[i] = subtitleTrackChoices[j];
                        matches++;
                        break;
                    }
                }
            }
            if (matches === this.lastLanguagesSynced.length) {
                tracks.completeMatch = true;
            }
        }

        return tracks;
    }

    private _defaultVideoName(basename: string | undefined, subtitleTrack: VideoDataSubtitleTrack) {
        if (subtitleTrack.url === '-') {
            return basename ?? '';
        }

        if (basename) {
            return `${basename} - ${subtitleTrack.label}`;
        }

        return subtitleTrack.label;
    }

    private async _setSyncedData(data: VideoData) {
        const wasLoading = this._syncedData?.subtitles === undefined;
        this._syncedData = data;

        // Savi (SV-8): before the upstream remembered-language auto-sync, try to
        // auto-load the streaming player's own track in the learner's target
        // language (or an OpenSubtitles fallback). Runs once per request cycle and
        // only with the picker closed; on success we're done. On failure we fall
        // through to the unchanged upstream behavior below.
        if (this._syncedData?.subtitles !== undefined && !this.pickerVisible && !this._saviAutoLoadAttempted) {
            this._saviAutoLoadAttempted = true;

            if (await this._trySaviAutoLoad()) {
                return;
            }

            // SV-44: on a local video file, a failed auto-load used to be a
            // console line and nothing else — leaving a video playing with no
            // subtitles and no hint that anything could be done about it. A
            // streaming page still has its own tracks to fall back on; a file
            // on disk has nothing, so open the picker with the parsed name
            // filled in and let the user search for it by hand.
            if (this._localVideoIsAFile && !this.pickerVisible) {
                console.info('[savi local video] no subtitles found automatically — opening the picker to search');
                await this.show({ reason: VideoDataUiOpenReason.failedToAutoLoadPreferredTrack });
                return;
            }
        }

        if (this._syncedData?.subtitles !== undefined && (await this._canAutoSync())) {
            if (!this._autoSyncAttempted) {
                this._autoSyncAttempted = true;
                const subs = this._matchLastSyncedWithAvailableTracks();

                if (subs.completeMatch && !this.pickerVisible) {
                    const autoSelectedTracks: VideoDataSubtitleTrack[] = subs.autoSelectedTracks;
                    await this._syncData(autoSelectedTracks);
                } else if (!subs.completeMatch && !this.pickerVisible) {
                    const shouldPrompt = await this._settings.getSingle('streamingAutoSyncPromptOnFailure');

                    if (shouldPrompt) {
                        await this.show({ reason: VideoDataUiOpenReason.failedToAutoLoadPreferredTrack });
                    }
                } else if (wasLoading) {
                    // Picker is open in loading state. Populate it now that tracks have arrived.
                    this._frame.clientIfLoaded?.updateState(await this._buildModel({}));
                }
            }
        } else if (!this.pickerVisible || wasLoading) {
            this._frame.clientIfLoaded?.updateState(await this._buildModel({}));
        }
    }

    // SV-8: auto-load the target-language subtitle without the picker. Returns
    // true when a track was loaded. Path A = the streaming player's own track in
    // the target language; Path B = an OpenSubtitles search (fallback, only when
    // a key is configured). Any failure is swallowed so we fall back cleanly.
    // The roaming target language / OpenSubtitles key, fetched FRESH from the
    // cloud (via the background) on each video so a language set on another device
    // — e.g. the desktop app — applies here without reopening the extension. The
    // local cache is the fallback when the cloud is unreachable / signed out.
    private async _saviRoamingSettings(): Promise<SaviRoamingSettings> {
        try {
            const command: SaviCommand<SaviRoamingSettingsMessage> = {
                sender: 'savi-video',
                message: { command: 'savi-roaming-settings' },
            };
            const response = (await browser.runtime.sendMessage(command)) as SaviRoamingSettingsResponse | undefined;

            if (response && typeof response.targetLanguage === 'string') {
                return {
                    targetLanguage: response.targetLanguage,
                    nativeLanguage: response.nativeLanguage ?? '',
                    openSubtitlesApiKey: response.openSubtitlesApiKey ?? '',
                    mutedSites: response.mutedSites ?? [],
                };
            }
        } catch (e) {
            // No background / offline — fall back to the cache.
        }

        return await getCachedRoamingSettings();
    }

    /**
     * Decide whether savi should run on this video at all (SV-41), and apply it.
     *
     * Runs BEFORE the auto-load attempt: when the answer is no, there is nothing
     * to load either — savi should leave the page alone entirely.
     *
     * The judgement uses the SPOKEN language (`spokenLanguage`, from YouTube's
     * asr caption track), never the list of available subtitle tracks. YouTube
     * offers auto-translated tracks in many languages, so "a Spanish track
     * exists" is true for most English videos and is exactly the false signal
     * that made savi switch itself on over English speech.
     */
    private async _applySaviLanguageGate(targetLanguage: string): Promise<boolean> {
        try {
            const episodeId = deriveEpisodeId(window.location.href, document.title);
            const verdict = decideLanguageGate({
                spokenLanguage: this._syncedData?.spokenLanguage,
                targetLanguage,
                episodeId,
                mutedEpisodes: await mutedEpisodes(),
                siteKey: siteKeyForUrl(window.location.href),
                mutedSites: await mutedSites(),
            });
            this._context.applySaviLanguageGate?.(verdict);
            return verdict.active;
        } catch (e) {
            // Fail open, loudly. A broken gate must never be the reason savi
            // went quiet — that failure is invisible to the user and costs real
            // exposure, which is the whole reason this gate fails open by design.
            console.warn('[savi language-gate] gate failed, leaving savi on', e);
            return true;
        }
    }

    private async _trySaviAutoLoad(): Promise<boolean> {
        try {
            if (!(await this._settings.getSingle('saviAutoLoadSubtitles'))) {
                console.info('[savi auto-load] disabled in Settings → Savi');
                return false;
            }

            const roaming = await this._saviRoamingSettings();
            const { targetLanguage, openSubtitlesApiKey } = roaming;

            // The SV-41 gate runs FIRST and decides from the SPOKEN language
            // alone. It must stay independent of the native line below: a
            // native-language subtitle track existing on an English video is
            // exactly the "a track exists" false signal the gate was built to
            // ignore, so the second line never gets a vote on whether savi runs.
            if (!(await this._applySaviLanguageGate(targetLanguage))) {
                return false;
            }
            // Tolerate a settings object without the key: a cache written by a
            // build older than the native line has no `nativeLanguage`, and
            // letting that throw here would be swallowed by the catch below and
            // reported as "auto-load failed" — silently costing the user their
            // subtitles entirely over an optional second line.
            const nativeLanguage = roaming.nativeLanguage ?? '';
            const detected = this._syncedData?.subtitles ?? [];
            const detectedLangs = detected.map((s) => s.language ?? '?');

            if (targetLanguage.trim().length === 0) {
                console.info(
                    '[savi auto-load] no target language set — set one in Settings → Savi (detected tracks: %s)',
                    detectedLangs.join(', ') || 'none yet'
                );
                return false;
            }

            // Path A: the streaming player's own track in the target language.
            const track = selectTrackForLanguage(this._syncedData?.subtitles, targetLanguage);

            if (track !== undefined) {
                // The native line rides along when one is configured and the site
                // has it. Target stays FIRST: asbplayer renders in array order and
                // treats track 0 as the mining source, so flipping these would mine
                // the translation instead of the language being learned.
                const nativeTrack = selectNativeTrack(
                    this._syncedData?.subtitles,
                    nativeLanguage,
                    targetLanguage,
                    track
                );

                if (nativeTrack !== undefined) {
                    console.info(
                        '[savi auto-load] loading "%s" (%s) for target %s + "%s" (%s) as the native line',
                        track.label,
                        track.language,
                        targetLanguage,
                        nativeTrack.label,
                        nativeTrack.language
                    );
                } else {
                    console.info(
                        '[savi auto-load] loading "%s" (%s) for target %s%s',
                        track.label,
                        track.language,
                        targetLanguage,
                        nativeLanguage.trim().length === 0
                            ? ''
                            : ` — no ${nativeLanguage} track among [${detectedLangs.join(', ') || 'none'}] for the native line`
                    );
                }

                await this._syncData(nativeTrack === undefined ? [track] : [track, nativeTrack]);
                await this._rememberSaviLanguageForCapture(targetLanguage);
                return true;
            }

            // Path B: OpenSubtitles fallback — only when the user configured a key.
            if (openSubtitlesApiKey.trim().length > 0) {
                console.info(
                    '[savi auto-load] no %s track among [%s] — trying OpenSubtitles',
                    targetLanguage,
                    detectedLangs.join(', ') || 'none'
                );
                const loaded = await this._trySaviOpenSubtitlesFallback(targetLanguage);

                if (loaded) {
                    await this._rememberSaviLanguageForCapture(targetLanguage);
                }

                return loaded;
            }

            console.info(
                '[savi auto-load] no %s track among [%s], and no OpenSubtitles key set — add one in Savi Settings',
                targetLanguage,
                detectedLangs.join(', ') || 'none'
            );
            return false;
        } catch (e) {
            console.error('[savi auto-load] failed', e);
            return false;
        }
    }

    // savi capture reads the episode language from streamingLastLanguagesSynced
    // (see extension/src/savi/capture-controller.ts) — the same place the picker's
    // "remember track choices" writes it. An auto-load never opens the picker, so
    // record the target language here too, or a captured episode would reach the
    // daemon with no language and skip tokenization. Best-effort: the subtitle is
    // already loaded, so a failed write must not fail the auto-load.
    private async _rememberSaviLanguageForCapture(language: string) {
        try {
            const trimmed = language.trim();

            if (trimmed.length === 0) {
                return;
            }

            this.lastLanguagesSynced = [trimmed];
            await this._context.settings.set({ streamingLastLanguagesSynced: this._lastLanguagesSynced });
        } catch (e) {
            // Auto-load already succeeded; remembering the language is best-effort.
        }
    }

    private async _trySaviOpenSubtitlesFallback(targetLanguage: string): Promise<boolean> {
        // OpenSubtitles is a FILM/TV database. YouTube titles are not in it, so
        // every search is a fuzzy miss that still returns its nearest match —
        // which is how a comedy song loaded an unrelated film's subtitles. Skip
        // the whole path there rather than pay an API call to be wrong.
        const pageDelegate = await currentPageDelegate();
        if (pageDelegate?.config.key === 'youtube') {
            console.info('[savi auto-load] skipping OpenSubtitles on YouTube (not a film/TV catalogue)');
            return false;
        }

        const { query, seasonNumber, episodeNumber } = this._openSubtitlesQuery();

        if (query.trim().length === 0) {
            return false;
        }

        return await this.fetchAndLoadOpenSubtitles({
            query,
            seasonNumber,
            episodeNumber,
            language: targetLanguage,
            // Automatic search: the query is our guess, so the result has to be
            // checked against it.
            verifyAgainstQuery: true,
        });
    }

    /**
     * What to ask OpenSubtitles for. Prefers the filename parse on a local
     * video (SV-44) — it already separated title from season/episode and knows
     * the release year — and otherwise re-reads the site's basename, which is
     * all a streaming page gives us.
     */
    private _openSubtitlesQuery(): { query: string; seasonNumber?: number; episodeNumber?: number } {
        const local = this._localVideo;

        if (local !== undefined && local.title.trim().length > 0) {
            return {
                query: local.title,
                seasonNumber: local.seasonNumber,
                episodeNumber: local.episodeNumber,
            };
        }

        return parseShowQuery(this._syncedData?.basename ?? document.title);
    }

    /**
     * Search OpenSubtitles and load the best result. Shared by the automatic
     * auto-load and the picker's manual search (SV-44).
     *
     * `verifyAgainstQuery` is the difference between the two. The search is
     * fuzzy and never returns "nothing" — given a title it does not have, it
     * returns its nearest match — so an AUTOMATIC search must check the result
     * against what it asked for, or a wrong-but-plausible subtitle gets loaded
     * and every line of it feeds glossing and counts as exposure. A MANUAL
     * search is the user telling us what this is, so the same check would be
     * us overriding them with a worse guess; there it stays off.
     */
    async fetchAndLoadOpenSubtitles({
        query,
        seasonNumber,
        episodeNumber,
        language,
        verifyAgainstQuery,
    }: {
        query: string;
        seasonNumber?: number;
        episodeNumber?: number;
        language: string;
        verifyAgainstQuery: boolean;
    }): Promise<boolean> {
        const command: SaviCommand<SaviOpenSubtitlesFetchMessage> = {
            sender: 'savi-video',
            message: {
                command: 'savi-opensubtitles-fetch',
                query,
                languages: primarySubtag(language),
                seasonNumber,
                episodeNumber,
            },
        };

        const response = (await browser.runtime.sendMessage(command)) as SaviOpenSubtitlesFetchResponse | undefined;

        if (!response?.ok || !response.content) {
            return false;
        }

        if (verifyAgainstQuery && !titlesOverlap(query, response.name)) {
            console.info(
                '[savi auto-load] discarding unrelated OpenSubtitles result "%s" for "%s"',
                response.name ?? '(unnamed)',
                query
            );
            return false;
        }

        const name = /\.(srt|ass|ssa|vtt)$/i.test(response.name ?? '') ? response.name! : `${query}.srt`;
        this._context.loadSubtitles([new File([response.content], name)], false);
        return true;
    }

    private async _canAutoSync(): Promise<boolean> {
        const page = await currentPageDelegate();

        if (page === undefined) {
            return this._autoSync ?? false;
        }

        return this._autoSync === true && page.canAutoSync(this._context.video);
    }

    private async _pageHidesTrackPrefToggle() {
        return (await currentPageDelegate())?.config?.hideRememberTrackPreferenceToggle ?? false;
    }

    private async _client() {
        this._frame.language = await this._settings.getSingle('language');
        const isNewClient = await this._frame.bind();
        const client = await this._frame.client();

        if (isNewClient) {
            client.onMessage(async (message) => {
                if ('openSettings' === message.command) {
                    const openSettingsCommand: VideoToExtensionCommand<OpenAsbplayerSettingsMessage> = {
                        sender: 'asbplayer-video',
                        message: {
                            command: 'open-asbplayer-settings',
                        },
                        src: this._context.registeredVideoSrc,
                    };
                    browser.runtime.sendMessage(openSettingsCommand);
                    return;
                }

                if ('activeProfile' === message.command) {
                    const activeProfileMessage = message as ActiveProfileMessage;
                    await this._context.settings.setActiveProfile(activeProfileMessage.profile);
                    const settingsUpdatedCommand: VideoToExtensionCommand<SettingsUpdatedMessage> = {
                        sender: 'asbplayer-video',
                        message: {
                            command: 'settings-updated',
                        },
                        src: this._context.registeredVideoSrc,
                    };
                    browser.runtime.sendMessage(settingsUpdatedCommand);
                    return;
                }

                if ('dismissFtue' === message.command) {
                    globalStateProvider.set({ ftueHasSeenSubtitleTrackSelector: true }).catch(console.error);
                    return;
                }

                if ('setOnlineSubtitleSourceConfig' === message.command) {
                    const setOnlineSubtitleSourceConfigMessage =
                        message as VideoDataUiBridgeSetOnlineSubtitleSourceConfigMessage;
                    const currentOnlineSubtitleSourceConfig = (
                        await globalStateProvider.get(['onlineSubtitleSourceConfig'])
                    ).onlineSubtitleSourceConfig;

                    await globalStateProvider.set({
                        onlineSubtitleSourceConfig: {
                            ...currentOnlineSubtitleSourceConfig,
                            ...setOnlineSubtitleSourceConfigMessage.state,
                        },
                    });
                    return;
                }

                // SV-44: OpenSubtitles on behalf of the picker.
                //
                // The picker is a `srcdoc` iframe, so it inherits the PAGE's
                // origin and has no extension APIs — `browser.runtime` is
                // undefined there. It asks over the bridge and this content
                // script, which does have them, makes the call and replies on
                // the message id.
                if ('searchOnlineSubtitles' === message.command) {
                    const searchMessage = message as VideoDataUiBridgeSearchOnlineSubtitlesMessage;
                    // The target language is resolved HERE, not in the picker:
                    // it lives in the roaming settings, which that frame also
                    // cannot read. Empty means "every language" — better than
                    // silently filtering to nothing.
                    let languages = '';
                    try {
                        const { targetLanguage } = await this._saviRoamingSettings();
                        languages = primarySubtag(targetLanguage ?? '');
                    } catch {
                        // Search unfiltered rather than not at all.
                    }

                    const command: SaviCommand<SaviOpenSubtitlesSearchMessage> = {
                        sender: 'savi-video',
                        message: {
                            command: 'savi-opensubtitles-search',
                            query: searchMessage.query,
                            languages,
                            seasonNumber: searchMessage.seasonNumber,
                            episodeNumber: searchMessage.episodeNumber,
                        },
                    };

                    let response: SaviOpenSubtitlesSearchResponse;
                    try {
                        response = ((await browser.runtime.sendMessage(command)) as
                            | SaviOpenSubtitlesSearchResponse
                            | undefined) ?? { ok: false };
                    } catch (e) {
                        response = { ok: false, errorMessage: e instanceof Error ? e.message : String(e) };
                    }

                    // Always reply, even on failure: the picker awaits this id
                    // and would otherwise sit on a spinner until the bridge
                    // timeout, which reads as a hung button.
                    client.sendMessage({ messageId: searchMessage.messageId, ...response });
                    return;
                }

                if ('downloadOnlineSubtitle' === message.command) {
                    const downloadMessage = message as VideoDataUiBridgeDownloadOnlineSubtitleMessage;
                    const command: SaviCommand<SaviOpenSubtitlesDownloadMessage> = {
                        sender: 'savi-video',
                        message: {
                            command: 'savi-opensubtitles-download',
                            fileId: downloadMessage.fileId,
                            fileName: downloadMessage.fileName,
                        },
                    };

                    let response: SaviOpenSubtitlesDownloadResponse;
                    try {
                        response = ((await browser.runtime.sendMessage(command)) as
                            | SaviOpenSubtitlesDownloadResponse
                            | undefined) ?? { ok: false };
                    } catch (e) {
                        response = { ok: false, errorMessage: e instanceof Error ? e.message : String(e) };
                    }

                    client.sendMessage({ messageId: downloadMessage.messageId, ...response });
                    return;
                }

                if ('cancel' === message.command) {
                    this._hideAndResume();
                    return;
                }

                let dataWasSynced = true;

                if ('confirm' === message.command) {
                    const confirmMessage = message as VideoDataUiBridgeConfirmMessage;

                    if (confirmMessage.shouldRememberTrackChoices) {
                        this.lastLanguagesSynced = confirmMessage.data
                            .map((track) => track.language)
                            .filter((language) => language !== undefined) as string[];
                        await this._context.settings
                            .set({ streamingLastLanguagesSynced: this._lastLanguagesSynced })
                            .catch(() => {});
                    }

                    const data = confirmMessage.data as ConfirmedVideoDataSubtitleTrack[];

                    dataWasSynced = await this._syncDataArray(data, confirmMessage.syncWithAsbplayerId);
                } else if ('openFile' === message.command) {
                    const openFileMessage = message as VideoDataUiBridgeOpenFileMessage;
                    const subtitles = openFileMessage.subtitles as SerializedSubtitleFile[];

                    try {
                        await this._syncSubtitles(subtitles, false);
                        dataWasSynced = true;
                    } catch (e) {
                        if (e instanceof Error) {
                            await this._reportError(e.message);
                        }
                    }
                }

                if (dataWasSynced) {
                    this._hideAndResume();
                }
            });
        }

        this._frame.show();
        return client;
    }

    private _prepareShow() {
        this._openedLocation = window.location.href;
        this._wasPaused = this._wasPaused ?? this._context.video.paused;
        this._context.pause();

        // Some players (e.g. Hulu) call video.play() on an internal timer that
        // ignores the picker being open. Re-pause on any play event until the
        // picker is dismissed.
        if (!this._playBlocker) {
            this._playBlocker = () => {
                this._context.pause();
            };
            this._context.video.addEventListener('play', this._playBlocker);
        }

        if (document.fullscreenElement) {
            this._fullscreenElement = document.fullscreenElement;
            document.exitFullscreen();
        }

        if (document.activeElement) {
            this._activeElement = document.activeElement;
        }

        this._context.keyBindings.unbind();
        this._context.subtitleController.forceHideSubtitles = true;
        this._context.mobileVideoOverlayController.forceHide = true;
    }

    private _cleanupPlayBlocker() {
        if (this._playBlocker) {
            this._context.video.removeEventListener('play', this._playBlocker);
            this._playBlocker = undefined;
        }
    }

    private _hideAndResume() {
        this._cleanupPlayBlocker();
        this._openedLocation = undefined;
        this._context.keyBindings.bind(this._context);
        this._context.subtitleController.forceHideSubtitles = false;
        this._context.mobileVideoOverlayController.forceHide = false;
        this._frame?.hide();

        if (this._fullscreenElement) {
            this._fullscreenElement.requestFullscreen();
            this._fullscreenElement = undefined;
        }

        if (this._activeElement) {
            if (typeof (this._activeElement as HTMLElement).focus === 'function') {
                (this._activeElement as HTMLElement).focus();
            }

            this._activeElement = undefined;
        } else {
            window.focus();
        }

        if (!this._wasPaused) {
            this._context.play();
        }

        this._wasPaused = undefined;
    }

    private async _syncData(data: VideoDataSubtitleTrack[]) {
        try {
            let subtitles: SerializedSubtitleFile[] = [];

            for (let i = 0; i < data.length; i++) {
                const { extension, url, language, localFile } = data[i];
                const subtitleFiles = await this._subtitlesForUrl(
                    this._defaultVideoName(this._syncedData?.basename, data[i]),
                    language,
                    extension,
                    url,
                    localFile
                );
                if (subtitleFiles !== undefined) {
                    subtitles.push(...subtitleFiles);
                }
            }

            await this._syncSubtitles(
                subtitles,
                data.some((track) => typeof track.url === 'object')
            );
            return true;
        } catch (error) {
            if (typeof (error as Error).message !== 'undefined') {
                await this._reportError(`Data Sync failed: ${(error as Error).message}`);
            }

            return false;
        }
    }

    private async _syncDataArray(data: ConfirmedVideoDataSubtitleTrack[], syncWithAsbplayerId?: string) {
        try {
            let subtitles: SerializedSubtitleFile[] = [];

            for (let i = 0; i < data.length; i++) {
                const { name, language, extension, url, localFile } = data[i];
                const subtitleFiles = await this._subtitlesForUrl(name, language, extension, url, localFile);
                if (subtitleFiles !== undefined) {
                    subtitles.push(...subtitleFiles);
                }
            }

            await this._syncSubtitles(
                subtitles,
                data.some((track) => typeof track.url === 'object'),
                syncWithAsbplayerId
            );
            return true;
        } catch (error) {
            if (typeof (error as Error).message !== 'undefined') {
                await this._reportError(`Data Sync failed: ${(error as Error).message}`);
            }

            return false;
        }
    }

    private async _syncSubtitles(
        serializedFiles: SerializedSubtitleFile[],
        flatten: boolean,
        syncWithAsbplayerId?: string
    ) {
        const files: File[] = await Promise.all(
            serializedFiles.map(async (f) => new File([base64ToBlob(f.base64, 'text/plain')], f.name))
        );
        this._context.loadSubtitles(files, flatten, syncWithAsbplayerId);
    }

    private async _subtitlesForUrl(
        name: string,
        language: string | undefined,
        extension: string,
        url: string | string[],
        localFile: boolean | undefined
    ): Promise<SerializedSubtitleFile[] | undefined> {
        if (url === '-') {
            return [
                {
                    name: `${name}.${extension}`,
                    base64: '',
                },
            ];
        }

        if (url === 'lazy') {
            if (language === undefined) {
                await this._reportError('Unable to determine language');
                return undefined;
            }

            const data = await fetchDataForLanguageOnDemand(language);

            if (data.error) {
                await this._reportError(data.error);
                return undefined;
            }

            const lazilyFetchedUrl = data.subtitles?.find((t) => t.language === language)?.url;

            if (lazilyFetchedUrl === undefined) {
                await this._reportError('Failed to fetch subtitles for specified language');
                return undefined;
            }

            url = lazilyFetchedUrl;
        }

        if (typeof url === 'string') {
            const response = await fetch(url)
                .catch((error) => this._reportError(error.message))
                .finally(() => {
                    if (localFile) {
                        URL.revokeObjectURL(url);
                    }
                });

            if (!response) {
                return undefined;
            }

            if (!response.ok) {
                throw new Error(`Subtitle Retrieval failed with Status ${response.status}/${response.statusText}...`);
            }

            return [
                {
                    name: `${name}.${extension}`,
                    base64: response ? bufferToBase64(await response.arrayBuffer()) : '',
                },
            ];
        }

        // `url` is an array

        const firstUri = url[0];
        const partExtension = extractExtension(firstUri, extension);
        const fileName = `${name}.${partExtension}`;
        const promises = url.map((u) => fetch(u));
        const tracks = [];
        let totalPromises = promises.length;
        let finishedPromises = 0;

        for (const p of promises) {
            const response = await p;

            if (!response.ok) {
                throw new Error(`Subtitle Retrieval failed with Status ${response.status}/${response.statusText}...`);
            }

            ++finishedPromises;
            this._context.subtitleController.notification(
                `${fileName} (${Math.floor((finishedPromises / totalPromises) * 100)}%)`
            );

            tracks.push({
                name: fileName,
                base64: bufferToBase64(await response.arrayBuffer()),
            });
        }

        return tracks;
    }

    private async _reportError(error: string) {
        const client = await this._client();
        const themeType = await this._context.settings.getSingle('themeType');

        this._prepareShow();

        return client.updateState({
            open: true,
            isLoading: false,
            showSubSelect: true,
            error,
            themeType: themeType,
        });
    }
}
