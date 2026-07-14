// React state for the account-roaming savi settings (target language +
// OpenSubtitles key) in the options page / popup. The cloud is the source of
// truth (extension/src/savi/cloud-settings.ts): we seed from the local cache,
// refresh from the cloud on mount, and write through (optimistically) on every
// change. Writes while signed out still update the local cache — they just don't
// reach the account until the next sign-in — so we swallow that error here.

import { useCallback, useEffect, useState } from 'react';
import {
    DEFAULT_ROAMING_SETTINGS,
    getCachedRoamingSettings,
    loadRoamingSettings,
    putRoamingSetting,
    SaviRoamingSettings,
} from '@/savi/cloud-settings';
import { resolveCloudBase } from '@/savi/cloud-client';

export interface SaviRoamingSettingsHook {
    readonly targetLanguage: string;
    readonly openSubtitlesApiKey: string;
    readonly loaded: boolean;
    readonly setTargetLanguage: (value: string) => void;
    readonly setOpenSubtitlesApiKey: (value: string) => void;
}

export const useSaviRoamingSettings = (cloudUrl: string): SaviRoamingSettingsHook => {
    const [state, setState] = useState<SaviRoamingSettings>(DEFAULT_ROAMING_SETTINGS);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;

        // Show the cached values instantly, then reconcile with the cloud. Until
        // the cloud URL is known (settings still loading), stay on the cache.
        void getCachedRoamingSettings().then((cached) => {
            if (!cancelled) {
                setState(cached);
            }
        });

        if (cloudUrl.trim().length === 0) {
            return () => {
                cancelled = true;
            };
        }

        // Dev builds roam against the local cloud too, so this page reads/writes
        // the same target language the desktop app and glossing use.
        void loadRoamingSettings(resolveCloudBase(cloudUrl)).then((settings) => {
            if (!cancelled) {
                setState(settings);
                setLoaded(true);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [cloudUrl]);

    const update = useCallback(
        (key: keyof SaviRoamingSettings, value: string) => {
            setState((prev) => ({ ...prev, [key]: value }));
            void putRoamingSetting(resolveCloudBase(cloudUrl), key, value).catch((e) =>
                // Signed out / offline: the local cache still has the value.
                console.warn('savi: could not sync roaming setting to the account', e)
            );
        },
        [cloudUrl]
    );

    return {
        targetLanguage: state.targetLanguage,
        openSubtitlesApiKey: state.openSubtitlesApiKey,
        loaded,
        setTargetLanguage: useCallback((value: string) => update('targetLanguage', value), [update]),
        setOpenSubtitlesApiKey: useCallback((value: string) => update('openSubtitlesApiKey', value), [update]),
    };
};
