// Popup panel for savi capture: shows whether an episode capture is
// running and offers explicit start/stop. Auto-capture (the
// saviCaptureEnabled setting) makes this optional in the common case,
// but an explicit stop affordance is required and manual start covers
// auto-capture being disabled.

import { useCallback, useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import StopIcon from '@mui/icons-material/Stop';
import { useTranslation } from 'react-i18next';
import { AsbplayerSettings } from '@project/common/settings';
import { SaviCaptureState, SaviCommand, SaviCaptureStateMessage, SaviRequestStartMessage } from '../messages';

interface Props {
    settings: AsbplayerSettings;
}

const queryCaptureState = async (): Promise<SaviCaptureState> => {
    const command: SaviCommand<SaviCaptureStateMessage> = {
        sender: 'savi-popup',
        message: { command: 'savi-capture-state' },
    };

    try {
        return ((await browser.runtime.sendMessage(command)) as SaviCaptureState) ?? { active: false };
    } catch (e) {
        return { active: false };
    }
};

const SaviCapturePanel = ({ settings }: Props) => {
    const { t } = useTranslation();
    const [captureState, setCaptureState] = useState<SaviCaptureState>({ active: false });
    const [lastResult, setLastResult] = useState<string>();

    const refreshState = useCallback(() => {
        queryCaptureState().then(setCaptureState);
    }, []);

    useEffect(() => {
        refreshState();
        const interval = setInterval(refreshState, 1000);
        return () => clearInterval(interval);
    }, [refreshState]);

    const handleStart = useCallback(async () => {
        setLastResult(undefined);
        const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });

        if (currentTab?.id === undefined) {
            return;
        }

        const command: SaviCommand<SaviRequestStartMessage> = {
            sender: 'savi-popup',
            message: { command: 'savi-request-start', tabId: currentTab.id },
        };
        const response = await browser.runtime.sendMessage(command);

        if (response?.requested !== true) {
            setLastResult(t('savi.noSubtitles')!);
        }

        refreshState();
    }, [refreshState, t]);

    const handleStop = useCallback(async () => {
        const command: SaviCommand<{ command: 'savi-stop-capture' }> = {
            sender: 'savi-popup',
            message: { command: 'savi-stop-capture' },
        };
        const response = await browser.runtime.sendMessage(command);

        if (response?.stopped) {
            // The episode summary is shown as a toast in the captured tab
            // once the daemon finishes stitching.
            setLastResult(t('savi.captureFinishing')!);
        } else {
            setLastResult(t('savi.captureFailed', { message: response?.errorMessage ?? 'unknown error' })!);
        }

        refreshState();
    }, [refreshState, t]);

    if (!settings.saviDaemonUrl.trim() || !settings.saviDaemonToken.trim()) {
        return null;
    }

    return (
        <Paper variant="outlined" sx={{ padding: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
                <FiberManualRecordIcon color={captureState.active ? 'error' : 'disabled'} fontSize="small" />
                <Typography variant="body2" sx={{ flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} noWrap>
                    {captureState.active
                        ? (t('savi.capturing', { title: captureState.title ?? '' }) as string)
                        : (lastResult ?? (t('savi.idle') as string))}
                </Typography>
                {captureState.active ? (
                    <Button size="small" variant="contained" startIcon={<StopIcon />} onClick={handleStop}>
                        {t('savi.stop')}
                    </Button>
                ) : (
                    <Button size="small" variant="outlined" startIcon={<FiberManualRecordIcon />} onClick={handleStart}>
                        {t('savi.start')}
                    </Button>
                )}
            </Stack>
        </Paper>
    );
};

export default SaviCapturePanel;
