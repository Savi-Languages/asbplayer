// React state for the sites savi has been switched off for (SV-44).
//
// The list lives in browser.storage.local (muted-sites.ts) because the in-page
// button that writes it runs in a content script. This hook is what makes the
// button undoable: without it, one click would take savi off a site silently
// and permanently, with nothing anywhere to say why.

import { useCallback, useEffect, useState } from 'react';
import { mutedSites, resetMutedSitesMemo, unmuteSite } from '@/savi/muted-sites';

export interface SaviMutedSitesHook {
    readonly sites: string[];
    readonly unmute: (siteKey: string) => void;
}

export const useSaviMutedSites = (): SaviMutedSitesHook => {
    const [sites, setSites] = useState<string[]>([]);

    const refresh = useCallback(() => {
        // The content script that wrote the entry has its own in-process mirror;
        // this page is a different context, so drop ours before reading or an
        // options page left open would show a stale list.
        resetMutedSitesMemo();
        void mutedSites().then(setSites);
    }, []);

    useEffect(refresh, [refresh]);

    const unmute = useCallback(
        (siteKey: string) => {
            void unmuteSite(siteKey).then(refresh);
        },
        [refresh]
    );

    return { sites, unmute };
};
