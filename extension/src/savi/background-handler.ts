// Background-side orchestration for savi capture, registered as one
// extra CommandHandler in asbplayer's background handler list.
//
// Responsibilities that can only live here: minting tabCapture stream
// ids, ensuring the offscreen document exists, and talking to the savi
// daemon for capture start (the offscreen document owns chunk upload and
// finish so captures survive service-worker sleep).

import { ExtensionToVideoCommand, RequestActiveTabPermissionMessage } from '@project/common';
import { SettingsProvider } from '@project/common/settings';
import { CommandHandler } from '@/handlers/command-handler';
import { ensureOffscreenAudioServiceDocument } from '@/services/offscreen-document';
import {
    SaviCaptureEndedMessage,
    SaviCaptureEndedToVideoMessage,
    SaviCaptureState,
    SaviCommand,
    SaviOffscreenStartMessage,
    SaviOffscreenStateMessage,
    SaviOffscreenStopMessage,
    SaviDictMessage,
    SaviDictResponse,
    SaviRequestStartMessage,
    SaviStartCaptureMessage,
    SaviStartCaptureResponse,
    SaviStopCaptureResponse,
    SaviTokenizeMessage,
    SaviTokenizeResponse,
} from './messages';
import {
    lookupDict,
    normalizedBaseUrl,
    postSubtitles,
    SaviDaemonConfig,
    startCapture,
    tokenize,
} from './daemon-client';

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
                this._stopCapture().then(sendResponse);
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
            case 'savi-dict':
                this._lookupDict(command.message as SaviDictMessage)
                    .then(sendResponse)
                    .catch(() => sendResponse({ entries: [] }));
                return true;
            case 'savi-capture-ended':
                this._forwardCaptureEnded(command.message as SaviCaptureEndedMessage);
                break;
        }

        return false;
    }

    private async _daemonConfig(): Promise<SaviDaemonConfig | null> {
        const { saviDaemonUrl, saviDaemonToken } = await this._settings.get(['saviDaemonUrl', 'saviDaemonToken']);
        if (!saviDaemonUrl.trim() || !saviDaemonToken.trim()) {
            return null;
        }
        return { baseUrl: normalizedBaseUrl(saviDaemonUrl), token: saviDaemonToken.trim() };
    }

    private async _tokenize(message: SaviTokenizeMessage): Promise<SaviTokenizeResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            return { tokens: [] };
        }
        try {
            return { tokens: await tokenize(config, message.lang, message.text) };
        } catch (e) {
            return { tokens: [] };
        }
    }

    private async _lookupDict(message: SaviDictMessage): Promise<SaviDictResponse> {
        const config = await this._daemonConfig();
        if (!config) {
            return { entries: [] };
        }
        try {
            return { entries: await lookupDict(config, message.lang, message.term) };
        } catch (e) {
            return { entries: [] };
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

        const { saviDaemonUrl, saviDaemonToken } = await this._settings.get(['saviDaemonUrl', 'saviDaemonToken']);

        if (!saviDaemonUrl.trim() || !saviDaemonToken.trim()) {
            return { started: false, errorCode: 'not-configured', errorMessage: 'savi daemon URL/token not set' };
        }

        const config = { baseUrl: normalizedBaseUrl(saviDaemonUrl), token: saviDaemonToken.trim() };

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
                token: config.token,
                requester: { tabId, src: message.src },
            },
        };
        const response = (await browser.runtime.sendMessage(offscreenCommand)) as {
            started: boolean;
            errorCode?: string;
            errorMessage?: string;
        };

        if (!response?.started) {
            // Only nag for the audio-recording permission when the user
            // explicitly started a capture. The auto-start that runs every time
            // subtitles load (i.e. every reload) stays silent — otherwise the
            // "enable audio recording" dialog pops on each page load.
            if (response?.errorCode === 'no-active-tab' && message.manuallyRequested) {
                this._requestActiveTab(tabId, message.src);
            }

            return {
                started: false,
                errorCode: response?.errorCode === 'no-active-tab' ? 'no-active-tab' : 'other',
                errorMessage: response?.errorMessage ?? 'failed to start recording',
            };
        }

        return { started: true, captureId };
    }

    private async _stopCapture(): Promise<SaviStopCaptureResponse> {
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

    private _requestActiveTab(tabId: number, src: string) {
        const command: ExtensionToVideoCommand<RequestActiveTabPermissionMessage> = {
            sender: 'asbplayer-extension-to-video',
            message: {
                command: 'request-active-tab-permission',
            },
            src,
        };
        browser.tabs.sendMessage(tabId, command);
    }
}
