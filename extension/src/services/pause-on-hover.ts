export interface AsbplayerHoverPauseState {
    overSubtitleText: boolean;
    pauseOnHoverEnabled: boolean;
    videoPaused: boolean;
    saviGlossHoverActive: boolean;
}

export const shouldPauseForAsbplayerHover = ({
    overSubtitleText,
    pauseOnHoverEnabled,
    videoPaused,
    saviGlossHoverActive,
}: AsbplayerHoverPauseState): boolean =>
    overSubtitleText && pauseOnHoverEnabled && !videoPaused && !saviGlossHoverActive;
