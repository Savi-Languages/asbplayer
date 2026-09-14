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
            settings: async () => ({
                lang: (await getCachedRoamingSettings()).targetLanguage,
                enabled: await settings.getSingle('saviEncounterRecording'),
                muted: (await mutedSites()).includes(location.hostname),
            }),
        });
        panel.start();
        const listener = (request: any) => {
            if (request.sender === 'savi-extension-to-video') panel.captureEnded(request.message);
        };
        browser.runtime.onMessage.addListener(listener);
        ctx.onInvalidated(() => {
            browser.runtime.onMessage.removeListener(listener);
            panel.stop();
            media.stop();
        });
    },
});
