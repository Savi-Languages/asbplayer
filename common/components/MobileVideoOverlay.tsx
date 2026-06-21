import React, { useCallback, useMemo, useRef, useState } from 'react';
import Grid, { GridProps } from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import TuneIcon from '@mui/icons-material/Tune';
import { ControlType, MobileOverlayModel, PlayMode } from '@project/common';
import { makeStyles } from '@mui/styles';
import { useTranslation } from 'react-i18next';
import LogoIcon from './LogoIcon';
import SubtitlesIcon from '@mui/icons-material/Subtitles';
import SubtitlesOffIcon from './SubtitlesOffIcon';
import HoldableIconButton from './HoldableIconButton';
import PlayModeSelector from './PlayModeSelector';
import ScrollableNumberControls from './ScrollableNumberControls';
import Tooltip from './Tooltip';

type Anchor = 'top' | 'bottom';

const useStyles = makeStyles(({ anchor }: { anchor: Anchor }) => ({
    button: {
        color: 'white',
    },
    inactiveButton: {
        color: 'rgba(120, 120, 120, 0.7)',
    },
    recordingButton: {
        color: 'red',
    },
    container: {
        display: 'inline-flex',
        width: 'auto',
        backgroundColor: 'rgba(0, 0, 0, .7)',
        borderRadius: 16,
    },
    playModePopOver: {
        '& .MuiPopover-paper': {
            maxHeight: 'none',
        },
    },
    tooltip: {
        '& .MuiTooltip-tooltipPlacementTop':
            anchor === 'top'
                ? {
                      marginTop: 16,
                  }
                : {},
        '& .MuiTooltip-tooltipPlacementBottom':
            anchor === 'bottom'
                ? {
                      marginBottom: 16,
                  }
                : {},
    },
}));

interface GridContainerProps extends GridProps {
    children: React.ReactNode;
}

const GridContainer = React.forwardRef<HTMLDivElement, GridContainerProps>(function GridContainer(
    { children, ...props }: GridContainerProps,
    ref
) {
    return (
        <Grid ref={ref} container alignItems="center" alignContent="center" justifyContent="center" {...props}>
            {children}
        </Grid>
    );
});

interface Props {
    model?: MobileOverlayModel;
    className?: string;
    anchor: Anchor;
    tooltipsEnabled: boolean;
    initialControlType: ControlType;
    onScrollToControlType: (controlType: ControlType) => void;
    onLoadSubtitles?: () => void;
    onOffset: (offset: number) => void;
    onPlaybackRate: (playbackRate: number) => void;
    onPlayModeSelected: (playMode: PlayMode) => void;
    onSeek: (timestamp: number) => void;
    onToggleSubtitles: () => void;
}

const MobileVideoOverlay = React.forwardRef<HTMLDivElement, Props>(function MobileVideoOverlay(
    {
        model,
        className,
        anchor,
        tooltipsEnabled,
        initialControlType,
        onScrollToControlType,
        onLoadSubtitles,
        onOffset,
        onPlaybackRate,
        onPlayModeSelected,
        onSeek,
        onToggleSubtitles,
    }: Props,
    ref
) {
    const classes = useStyles({ anchor });
    const offsetInputRef = useRef<HTMLInputElement>(undefined);
    const playbackInputRef = useRef<HTMLInputElement>(undefined);
    const [playModeSelectorOpen, setPlayModeSelectorOpen] = useState<boolean>(false);
    const [playModeSelectorAnchorEl, setPlayModeSelectorAnchorEl] = useState<HTMLElement>();
    const [numberControlType, setNumberControlType] = useState<ControlType>(ControlType.timeDisplay);

    const handleScrollToControlType = useCallback(
        (controlType: ControlType) => {
            setNumberControlType(controlType);
            onScrollToControlType(controlType);
        },
        [onScrollToControlType]
    );

    const handleClosePlayModeSelector = useCallback(() => {
        setPlayModeSelectorOpen(false);
        setPlayModeSelectorAnchorEl(undefined);
    }, []);

    const handleOpenPlayModeSelector = useCallback((e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
        setPlayModeSelectorAnchorEl(e.currentTarget);
        setPlayModeSelectorOpen(true);
    }, []);

    const handlePlayModeSelected = useCallback(
        (playMode: PlayMode) => {
            onPlayModeSelected(playMode);
        },
        [onPlayModeSelected]
    );

    const handleOffsetToPrevious = useCallback(() => {
        if (!model || model.previousSubtitleTimestamp === undefined) {
            return;
        }

        onOffset(model.currentTimestamp - model.previousSubtitleTimestamp);
    }, [onOffset, model]);

    const handleOffsetToNext = useCallback(() => {
        if (!model || model.nextSubtitleTimestamp === undefined) {
            return;
        }

        onOffset(model.currentTimestamp - model.nextSubtitleTimestamp);
    }, [onOffset, model]);

    const handleIncrementOffset = useCallback(() => {
        if (!model) {
            return;
        }

        onOffset(model.offset + 100);
    }, [onOffset, model]);

    const handleDecrementOffset = useCallback(() => {
        if (!model) {
            return;
        }

        onOffset(model.offset - 100);
    }, [onOffset, model]);

    const handleDecrementPlaybackRate = useCallback(() => {
        if (!model) {
            return;
        }

        onPlaybackRate(Math.max(0.1, model.playbackRate - 0.1));
    }, [onPlaybackRate, model]);

    const handleIncrementPlaybackRate = useCallback(() => {
        if (!model) {
            return;
        }

        onPlaybackRate(Math.min(5, model.playbackRate + 0.1));
    }, [onPlaybackRate, model]);

    const handleSeekToPreviousSubtitle = useCallback(() => {
        if (!model || model.previousSubtitleTimestamp === undefined) {
            return;
        }

        onSeek(model.previousSubtitleTimestamp);
    }, [onSeek, model]);

    const handleSeekBackwards = useCallback(() => {
        if (!model) {
            return;
        }

        onSeek(Math.max(0, model.currentTimestamp - 10000));
    }, [onSeek, model]);

    const handleSeekToNextSubtitle = useCallback(() => {
        if (!model || model.nextSubtitleTimestamp === undefined) {
            return;
        }

        onSeek(model.nextSubtitleTimestamp);
    }, [onSeek, model]);

    const handleSeekForwards = useCallback(() => {
        if (!model) {
            return;
        }

        onSeek(model.currentTimestamp + 10000);
    }, [onSeek, model]);

    const handleLeftNumberControl = useCallback(() => {
        switch (numberControlType) {
            case ControlType.timeDisplay:
                if (model?.emptySubtitleTrack) {
                    handleSeekBackwards();
                } else {
                    handleSeekToPreviousSubtitle();
                }
                break;
            case ControlType.subtitleOffset:
                handleOffsetToPrevious();
                break;
            case ControlType.playbackRate:
                handleDecrementPlaybackRate();
                break;
        }
    }, [
        numberControlType,
        model?.emptySubtitleTrack,
        handleSeekBackwards,
        handleSeekToPreviousSubtitle,
        handleOffsetToPrevious,
        handleDecrementPlaybackRate,
    ]);

    const handleRightNumberControl = useCallback(() => {
        switch (numberControlType) {
            case ControlType.timeDisplay:
                if (model?.emptySubtitleTrack) {
                    handleSeekForwards();
                } else {
                    handleSeekToNextSubtitle();
                }
                break;
            case ControlType.subtitleOffset:
                handleOffsetToNext();
                break;
            case ControlType.playbackRate:
                handleIncrementPlaybackRate();
                break;
        }
    }, [
        numberControlType,
        model?.emptySubtitleTrack,
        handleSeekForwards,
        handleSeekToNextSubtitle,
        handleOffsetToNext,
        handleIncrementPlaybackRate,
    ]);

    const handleHoldLeftNumberControl = useCallback(() => {
        switch (numberControlType) {
            case ControlType.timeDisplay:
                // ignore
                break;
            case ControlType.subtitleOffset:
                handleIncrementOffset();
                break;
            case ControlType.playbackRate:
                handleDecrementPlaybackRate();
                break;
        }
    }, [numberControlType, handleIncrementOffset, handleDecrementPlaybackRate]);

    const handleHoldRightNumberControl = useCallback(() => {
        switch (numberControlType) {
            case ControlType.timeDisplay:
                // ignore
                break;
            case ControlType.subtitleOffset:
                handleDecrementOffset();
                break;
            case ControlType.playbackRate:
                handleIncrementPlaybackRate();
                break;
        }
    }, [numberControlType, handleDecrementOffset, handleIncrementPlaybackRate]);

    const { t } = useTranslation();
    const { leftNumberControlTitle, numberControlTitle, rightNumberControlTitle } = useMemo(() => {
        switch (numberControlType) {
            case ControlType.timeDisplay:
                return {
                    leftNumberControlTitle: model?.emptySubtitleTrack
                        ? t('binds.seekBackward')
                        : t('binds.seekToPreviousSubtitle'),
                    numberControlTitle: t('controls.currentTimestamp'),
                    rightNumberControlTitle: model?.emptySubtitleTrack
                        ? t('binds.seekForward')
                        : t('binds.seekToNextSubtitle'),
                };
            case ControlType.subtitleOffset:
                return {
                    leftNumberControlTitle: t('action.increaseOffsetButton'),
                    numberControlTitle: t('controls.subtitleOffset'),
                    rightNumberControlTitle: t('action.decreaseOffsetButton'),
                };

            case ControlType.playbackRate:
                return {
                    leftNumberControlTitle: t('binds.decreasePlaybackRate'),
                    numberControlTitle: t('controls.playbackRate'),
                    rightNumberControlTitle: t('binds.increasePlaybackRate'),
                };
        }
    }, [numberControlType, model, t]);

    if (!model) {
        return null;
    }

    let rightNumberControlDisabled: boolean;
    let leftNumberControlDisabled: boolean;

    switch (numberControlType) {
        case ControlType.timeDisplay:
            rightNumberControlDisabled =
                (!model.emptySubtitleTrack && model.nextSubtitleTimestamp === undefined) || model.recording;
            leftNumberControlDisabled =
                (!model.emptySubtitleTrack && model.previousSubtitleTimestamp === undefined) ||
                model.recording ||
                model.currentTimestamp === 0;
            break;
        case ControlType.subtitleOffset:
            rightNumberControlDisabled = model.nextSubtitleTimestamp === undefined || model.recording;
            leftNumberControlDisabled = model.previousSubtitleTimestamp === undefined || model.recording;
            break;
        case ControlType.playbackRate:
            rightNumberControlDisabled = model.playbackRate >= 5 || model.recording;
            leftNumberControlDisabled = model.playbackRate <= 0.1 || model.recording;
            break;
    }

    const defaultTooltipProps = {
        className: classes.tooltip,
        placement: anchor,
        disabled: !tooltipsEnabled,
    };

    const containerClassName = className === undefined ? classes.container : `${className} ${classes.container}`;
    return (
        <>
            <GridContainer ref={ref} direction="row" wrap="nowrap" className={containerClassName}>
                {/* savi: load-subtitles (logo) button + the native Mine button
                    removed per user request — savi has its own Add-to-Anki flow
                    via the hover-dictionary popup, so this one was redundant. */}
                {!model.emptySubtitleTrack && (
                    <Grid item>
                        <Tooltip {...defaultTooltipProps} title={t('binds.toggleSubtitles')!}>
                            <span>
                                <IconButton disabled={model.recording} onClick={onToggleSubtitles}>
                                    {model.subtitlesAreVisible && (
                                        <SubtitlesOffIcon
                                            className={model.recording ? classes.inactiveButton : classes.button}
                                        />
                                    )}
                                    {!model.subtitlesAreVisible && (
                                        <SubtitlesIcon
                                            className={model.recording ? classes.inactiveButton : classes.button}
                                        />
                                    )}
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Grid>
                )}
                {/* savi: "Playback Mode" and the offset/playback-rate number
                    control removed per user request; pick a speed directly. */}
                {!model.recording &&
                    [0.5, 0.75, 1, 1.25, 1.5].map((rate) => {
                        const active = Math.abs(model.playbackRate - rate) < 0.001;
                        return (
                            <Grid item key={rate}>
                                <Button
                                    size="small"
                                    onClick={() => onPlaybackRate(rate)}
                                    style={{
                                        minWidth: 0,
                                        padding: '2px 7px',
                                        fontWeight: active ? 700 : 500,
                                        color: active ? '#fff' : 'rgba(255, 255, 255, 0.6)',
                                        backgroundColor: active ? 'rgba(255, 255, 255, 0.16)' : 'transparent',
                                    }}
                                >
                                    {rate}×
                                </Button>
                            </Grid>
                        );
                    })}
            </GridContainer>
            {playModeSelectorOpen && (
                <PlayModeSelector
                    open={playModeSelectorOpen}
                    anchorEl={playModeSelectorAnchorEl}
                    onClose={handleClosePlayModeSelector}
                    selectedPlayModes={new Set(model.playModes)}
                    onPlayMode={handlePlayModeSelected}
                    listStyle={{
                        display: 'flex',
                        flexDirection: 'row',
                        padding: 0,
                        overflowX: 'auto',
                    }}
                    className={classes.playModePopOver}
                    anchorOrigin={{
                        vertical: 'center',
                        horizontal: 'center',
                    }}
                    transformOrigin={{
                        vertical: 'center',
                        horizontal: 'center',
                    }}
                />
            )}
        </>
    );
});

export default MobileVideoOverlay;
