// The savi account session as React state for the settings UIs (options page
// + popup): who is signed in, plus sign-in/out actions that keep the state in
// step with the stored session (savi/account.ts owns the storage + refresh).

import { useCallback, useEffect, useState } from 'react';
import { signIn, signOut, storedAccount, SaviSignInResult } from '@/savi/account';
import { requestNativeSession } from '@/savi/native-session';

export interface SaviAccountHook {
    readonly email?: string;
    /** True when `email` came from the DESKTOP APP over native messaging rather
     *  than a sign-in here. The UI says so and hides sign-out: this session
     *  isn't ours to end — the app owns it, and signing out there ends it. */
    readonly fromDesktopApp: boolean;
    readonly signIn: (email: string, password: string) => Promise<SaviSignInResult>;
    readonly signOut: () => Promise<void>;
}

export const useSaviAccount = (): SaviAccountHook => {
    const [email, setEmail] = useState<string>();
    const [fromDesktopApp, setFromDesktopApp] = useState(false);
    const refresh = useCallback(() => {
        void (async () => {
            const account = await storedAccount();

            if (account?.email) {
                setEmail(account.email);
                setFromDesktopApp(false);
                return;
            }

            // No sign-in here — but the desktop app may be publishing one, in
            // which case every request already carries it. Without this the UI
            // shows a sign-in form while the extension is, in fact, signed in.
            const native = await requestNativeSession();
            setEmail(native?.email || undefined);
            setFromDesktopApp(native !== undefined);
        })();
    }, []);
    useEffect(refresh, [refresh]);

    const handleSignIn = useCallback(
        async (email: string, password: string) => {
            const result = await signIn(email, password);
            refresh();
            return result;
        },
        [refresh]
    );

    const handleSignOut = useCallback(async () => {
        await signOut();
        refresh();
    }, [refresh]);

    return { email, fromDesktopApp, signIn: handleSignIn, signOut: handleSignOut };
};
