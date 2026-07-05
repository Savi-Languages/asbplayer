// The savi account session as React state for the settings UIs (options page
// + popup): who is signed in, plus sign-in/out actions that keep the state in
// step with the stored session (savi/account.ts owns the storage + refresh).

import { useCallback, useEffect, useState } from 'react';
import { signIn, signOut, storedAccount, SaviSignInResult } from '@/savi/account';

export interface SaviAccountHook {
    readonly email?: string;
    readonly signIn: (email: string, password: string) => Promise<SaviSignInResult>;
    readonly signOut: () => Promise<void>;
}

export const useSaviAccount = (): SaviAccountHook => {
    const [email, setEmail] = useState<string>();
    const refresh = useCallback(() => {
        void storedAccount().then((account) => setEmail(account?.email));
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

    return { email, signIn: handleSignIn, signOut: handleSignOut };
};
