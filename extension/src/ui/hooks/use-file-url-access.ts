// Whether Chrome lets this extension see `file://` pages (SV-44).
//
// Local-video support is worthless without it, and the failure is uniquely
// invisible: when the permission is off the content script is never injected
// into a `file://` page at all, so there is nothing in-page to notice, warn, or
// offer a fix. The user opens a video, savi does nothing, and no console line
// appears anywhere — because no savi code ran.
//
// So the check has to live somewhere that DOES run: an extension page. Hence
// this hook, surfaced in Savi settings.
//
// The permission also cannot be requested programmatically — `permissions.request`
// does not cover it. It is a per-extension toggle the user sets by hand at
// chrome://extensions, which is why the UI explains rather than prompts.

import { useEffect, useState } from 'react';

export type FileUrlAccess = 'unknown' | 'allowed' | 'blocked';

export const useFileUrlAccess = (): FileUrlAccess => {
    const [access, setAccess] = useState<FileUrlAccess>('unknown');

    useEffect(() => {
        let cancelled = false;

        const check = async () => {
            try {
                // Firefox has no equivalent and does not expose this API; there
                // `unknown` is correct and the UI stays quiet rather than
                // showing Chrome instructions that do not apply.
                const isAllowed = (browser as any)?.extension?.isAllowedFileSchemeAccess;

                if (typeof isAllowed !== 'function') {
                    return;
                }

                const allowed = await isAllowed.call((browser as any).extension);

                if (!cancelled) {
                    setAccess(allowed ? 'allowed' : 'blocked');
                }
            } catch {
                // Leave it 'unknown' — a failed check must not produce a scary
                // banner about a permission that may well be fine.
            }
        };

        void check();

        return () => {
            cancelled = true;
        };
    }, []);

    return access;
};
