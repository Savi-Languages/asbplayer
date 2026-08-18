// React state for the sites savi has been switched off for (SV-44).
//
// The list lives in browser.storage.local (muted-sites.ts) because the in-page
// button that writes it runs in a content script. This hook is what makes the
// button undoable: without it, one click would take savi off a site silently
// and permanently, with nothing anywhere to say why.
//
// It also roams. The list is mirrored to the account's settings KV, so a site
// blacklisted on the desktop is blacklisted in the browser too — the decision
// is about a website, not about a browser profile. The cloud is the source of
// truth on mount; local edits write through optimistically (last-write-wins,
// like every other mutable setting).

import { useCallback, useEffect, useState } from 'react';
import { mutedSites, resetMutedSitesMemo, unmuteSite } from '@/savi/muted-sites';
import { clearHushDismissal } from '@/savi/hush-dismissed';
import { loadRoamingSettings, putRoamingSetting } from '@/savi/cloud-settings';
import { resolveCloudBase } from '@/savi/cloud-client';

export interface SaviMutedSitesHook {
    readonly sites: string[];
    readonly unmute: (siteKey: string) => void;
}

export const useSaviMutedSites = (
    cloudUrl: string = '',
    // Signing in is what makes the cloud readable at all, so the refresh has to
    // re-run on it — same reason `useSaviRoamingSettings` takes this.
    accountKey: string = ''
): SaviMutedSitesHook => {
    const [sites, setSites] = useState<string[]>([]);

    const readLocal = useCallback(() => {
        // The content script that wrote the entry has its own in-process mirror;
        // this page is a different context, so drop ours before reading or an
        // options page left open would show a stale list.
        resetMutedSitesMemo();
        return mutedSites().then(setSites);
    }, []);

    useEffect(() => {
        let cancelled = false;
        // Local first so the list paints without waiting on the network, then
        // the account's copy (which `loadRoamingSettings` mirrors into local
        // storage, so this second read picks it up). Signed out or offline the
        // refresh short-circuits and the local list simply stands.
        void readLocal().then(async () => {
            await loadRoamingSettings(resolveCloudBase(cloudUrl)).catch(() => undefined);
            if (!cancelled) {
                await readLocal();
            }
        });
        return () => {
            cancelled = true;
        };
    }, [readLocal, cloudUrl, accountKey]);

    // Refresh on every storage change to the list, not only on mount. The
    // in-page button writes from a content script while this page may already
    // be open — mount-only reading meant a settings page opened BEFORE the
    // click never showed the mute, so the button's own "Undo in Settings →
    // Savi" tooltip sent the user somewhere the entry wasn't. Seen live: a
    // site muted, `saviMutedSites: ["netflix.com"]` on disk, and an empty
    // "Sites Savi is switched off for" section.
    useEffect(() => {
        const onChanged = (changes: Record<string, unknown>, area: string) => {
            if (area === 'local' && 'saviMutedSites' in changes) {
                void readLocal();
            }
        };
        browser.storage.onChanged.addListener(onChanged);
        return () => browser.storage.onChanged.removeListener(onChanged);
    }, [readLocal]);

    const unmute = useCallback(
        (siteKey: string) => {
            void unmuteSite(siteKey)
                // Removing the site here is the user re-engaging with the
                // decision, so let the in-page prompt speak again if the gate
                // still cannot tell what language the site is in. Otherwise a
                // site could be un-muted and then never offer the control that
                // muted it.
                .then(() => clearHushDismissal(siteKey))
                .then(readLocal)
                .then(() => mutedSites())
                .then((next) => putRoamingSetting(resolveCloudBase(cloudUrl), 'mutedSites', next))
                // Signed out / offline: the removal already holds locally and
                // roams on the next successful write.
                .catch(() => {});
        },
        [readLocal, cloudUrl]
    );

    return { sites, unmute };
};
