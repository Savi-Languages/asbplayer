import { SpotifyPanel } from '@/savi/spotify-panel';
import { SpotifyMediaBridge } from '@/savi/spotify-media';
import { getCachedRoamingSettings } from '@/savi/cloud-settings';
import { SettingsProvider } from '@project/common/settings';
import { ExtensionSettingsStorage } from '@/services/extension-settings-storage';
import { mutedSites } from '@/savi/muted-sites';
export default defineContentScript({
    matches: ['https://open.spotify.com/*'],
    runAt: 'document_idle',
    main(ctx) {
        const media = new SpotifyMediaBridge(window);
        media.start();
        const settings = new SettingsProvider(new ExtensionSettingsStorage());
        const panel = new SpotifyPanel({
            media: media.media,
            send: (message) => browser.runtime.sendMessage({ sender: 'savi-video', message }),
            settings: async () => {
                const roaming = await getCachedRoamingSettings();
                return {
                    lang: roaming.targetLanguage,
                    nativeLanguage: roaming.nativeLanguage,
                    translate: await settings.getSingle('saviSpotifyTranslations'),
                    enabled: await settings.getSingle('saviEncounterRecording'),
                    pauseOnHoverMode: await settings.getSingle('pauseOnHoverMode'),
                    autoCapture:
                        (await settings.getSingle('saviCaptureEnabled')) &&
                        (await settings.getSingle('saviAudioRecording')),
                    muted: (await mutedSites()).includes(location.hostname),
                };
            },
        });
        panel.start();
        const listener = (request: any, _sender: unknown, sendResponse: (response?: any) => void) => {
            if (request.sender !== 'savi-extension-to-video') return;
            if (request.message?.command === 'savi-capture-ping') {
                // Answer only while capturing — silence is how the background
                // recognises a session record nobody owns (capture-staleness.ts).
                if (panel.isCapturing()) {
                    sendResponse({ capturing: true });
                    return true;
                }
                return;
            }
            panel.captureEnded(request.message);
        };
        browser.runtime.onMessage.addListener(listener);
        ctx.onInvalidated(() => {
            browser.runtime.onMessage.removeListener(listener);
            panel.stop();
            media.stop();
        });
    },
});
