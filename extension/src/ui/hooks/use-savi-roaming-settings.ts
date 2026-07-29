// React state for the account-roaming savi settings (target language) in the
// options page / popup. The cloud is the source of truth
// (extension/src/savi/cloud-settings.ts): we seed from the local cache,
// refresh from the cloud on mount, and write through (optimistically) on every
// change. Writes while signed out still update the local cache — they just don't
// reach the account until the next sign-in — so we swallow that error here.
// (The OpenSubtitles key is no longer edited here — it is managed in SAVI's
// Settings as api_keys rows; the background's fallback fetch reads it from the
// roaming cache, refreshed alongside these values.)

import { useCallback, useEffect, useState } from 'react';
import {
    DEFAULT_ROAMING_SETTINGS,
    getCachedRoamingSettings,
    loadRoamingSettings,
    putRoamingSetting,
    SaviRoamingSettings,
    WritableRoamingKey,
} from '@/savi/cloud-settings';
import { resolveCloudBase } from '@/savi/cloud-client';

export interface SaviRoamingSettingsHook {
    readonly targetLanguage: string;
    readonly loaded: boolean;
    readonly setTargetLanguage: (value: string) => void;
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
        (key: WritableRoamingKey, value: string) => {
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
        loaded,
        setTargetLanguage: useCallback((value: string) => update('targetLanguage', value), [update]),
    };
};
