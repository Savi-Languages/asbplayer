export interface AsbplayerHoverPauseState {
    overSubtitleText: boolean;
    pauseOnHoverEnabled: boolean;
    videoPaused: boolean;
    saviHoverPauseActive: boolean;
}

export const shouldPauseForAsbplayerHover = ({
    overSubtitleText,
    pauseOnHoverEnabled,
    videoPaused,
    saviHoverPauseActive,
}: AsbplayerHoverPauseState): boolean =>
    overSubtitleText && pauseOnHoverEnabled && !videoPaused && !saviHoverPauseActive;

/** Notifications reuse track markup, but never represent subtitle hover intent. */
export const isSubtitleHoverTarget = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest('[data-track]') !== null &&
    target.closest('.asbplayer-notification') === null;
