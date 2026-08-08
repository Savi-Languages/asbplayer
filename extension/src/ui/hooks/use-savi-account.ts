// The savi account session as React state for the settings UIs (options page
// + popup): who is signed in, plus sign-in/out actions that keep the state in
// step with the stored session (savi/account.ts owns the storage + refresh).
//
// SV-38: signing in also has to WAKE THE REST OF THE EXTENSION. Roaming
// settings (the target language) only reach the cloud with a token, so while
// signed out `loadRoamingSettings` short-circuits and the local cache stays
// empty. Content scripts read that cache once, at bind. So a sign-in with a tab
// already open used to leave glossing dead until the page was reloaded — the
// cache was empty when the controller last looked, and nothing told it to look
// again.
//
// Two steps close that, in order: pull the roaming settings so the cache is
// populated, THEN broadcast `settings-updated` so every bound video re-arms
// against it. The order matters — broadcasting first would have the content
// scripts re-read the same empty cache.

import { useCallback, useEffect, useState } from 'react';
import { Command, SettingsUpdatedMessage } from '@project/common';
import { signIn, signOut, storedAccount, SaviSignInResult } from '@/savi/account';
import { loadRoamingSettings } from '@/savi/cloud-settings';
import { resolveCloudBase } from '@/savi/cloud-client';

export interface SaviAccountHook {
    readonly email?: string;
    readonly signIn: (email: string, password: string) => Promise<SaviSignInResult>;
    readonly signOut: () => Promise<void>;
}

const notifySettingsUpdated = () => {
    const command: Command<SettingsUpdatedMessage> = {
        sender: 'asbplayer-settings',
        message: { command: 'settings-updated' },
    };
    browser.runtime.sendMessage(command);
};

export const useSaviAccount = (cloudUrl: string): SaviAccountHook => {
    const [email, setEmail] = useState<string>();
    const refresh = useCallback(() => {
        void storedAccount().then((account) => setEmail(account?.email));
    }, []);
    useEffect(refresh, [refresh]);

    const handleSignIn = useCallback(
        async (email: string, password: string) => {
            const result = await signIn(email, password);
            refresh();
            if (result.ok) {
                // Best-effort: if the pull fails the broadcast still re-arms the
                // content scripts, and the next video-data-sync fetches the
                // language fresh from the cloud anyway.
                try {
                    await loadRoamingSettings(resolveCloudBase(cloudUrl));
                } catch (e) {
                    console.warn('savi: could not pull roaming settings after sign-in', e);
                }
                notifySettingsUpdated();
            }
            return result;
        },
        [refresh, cloudUrl]
    );

    const handleSignOut = useCallback(async () => {
        await signOut();
        refresh();
        // Symmetric: content scripts must stop glossing under an account that
        // is no longer signed in, without waiting for a reload.
        notifySettingsUpdated();
    }, [refresh]);

    return { email, signIn: handleSignIn, signOut: handleSignOut };
};
