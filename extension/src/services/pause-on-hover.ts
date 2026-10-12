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
