const youtubeEmbedHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase();
    return (
        host === 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'youtube.googleapis.com' ||
        host.endsWith('.youtube.googleapis.com') ||
        host === 'youtube-nocookie.com' ||
        host.endsWith('.youtube-nocookie.com') ||
        host === 'youtubeeducation.com' ||
        host.endsWith('.youtubeeducation.com')
    );
};

/** YouTube embeds are a second copy of a video owned by the page around them,
 *  so their automatic capture would duplicate the intentional top-level page.
 *  Other services legitimately run their only player in a first-party iframe;
 *  those frames must retain auto-start and idle restart. Manual capture remains
 *  available everywhere. */
export const allowsAutomaticCapture = (context: Window = window): boolean => {
    try {
        if (context.top === context) return true;
    } catch {
        // We can still classify the frame by its own URL below.
    }
    try {
        return !youtubeEmbedHost(context.location.hostname);
    } catch {
        // Unknown frames are not assumed to be YouTube. Failing open here
        // preserves existing first-party iframe players.
        return true;
    }
};
