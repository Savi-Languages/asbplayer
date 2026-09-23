/** Automatic capture belongs to the page the learner intentionally opened,
 *  never to a third-party player embedded inside it. Manual capture requests
 *  can still be handled by a frame with loaded subtitles. */
export const isTopLevelFrame = (context: Window = window): boolean => {
    try {
        return context.top === context;
    } catch {
        return false;
    }
};
