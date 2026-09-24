import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import { ChromeExtension } from '@project/common/app';
import { useTranslation } from 'react-i18next';
import SaviBrand from '@project/common/components/SaviBrand';
import LoadSubtitlesIcon from '@project/common/components/LoadSubtitlesIcon';
import ArrowForward from '@mui/icons-material/ArrowForward';
import HistoryIcon from '@mui/icons-material/History';
import SubtitlesOutlined from '@mui/icons-material/SubtitlesOutlined';

interface Props {
    extension: ChromeExtension;
    videoElementCount: number;
    miningHistoryCount: number;
    onLoadSubtitles: () => void;
    onShowMiningHistory: () => void;
    onOpenUserGuide: () => void;
}
export default function SidePanelHome({
    videoElementCount,
    miningHistoryCount,
    onLoadSubtitles,
    onShowMiningHistory,
    onOpenUserGuide,
}: Props) {
    const { t } = useTranslation();
    const ready = videoElementCount > 0;
    return (
        <Box component="main" sx={{ p: 2.5, minHeight: '100dvh', bgcolor: 'background.paper' }}>
            <SaviBrand caption={t('saviUi.studyPanel')} />
            <Box sx={{ mt: 5, mb: 4 }}>
                <Box
                    sx={{
                        width: 52,
                        height: 52,
                        display: 'grid',
                        placeItems: 'center',
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 3,
                        color: 'primary.main',
                        mb: 2.5,
                    }}
                >
                    <SubtitlesOutlined />
                </Box>
                <Typography component="h1" variant="h4" sx={{ fontSize: 30 }}>
                    {ready ? t('saviUi.readyWhenYouAre') : t('saviUi.startWithSomethingGood')}
                </Typography>
                <Typography color="text.secondary" variant="body2" sx={{ mt: 1.5 }}>
                    {ready ? t('saviUi.loadToBegin') : t('saviUi.openVideo')}
                </Typography>
                <Button
                    fullWidth
                    variant="contained"
                    disabled={!ready}
                    startIcon={<LoadSubtitlesIcon />}
                    onClick={onLoadSubtitles}
                    sx={{ mt: 2.5, minHeight: 46 }}
                >
                    {t('action.loadSubtitles')}
                </Button>
            </Box>
            <Stack spacing={1.5} sx={{ mb: 3 }}>
                {['followAlong', 'exploreWords', 'keepTheMoment'].map((key, i) => (
                    <Paper
                        key={key}
                        variant="outlined"
                        sx={{ display: 'flex', alignItems: 'flex-start', p: 2, gap: 1.5 }}
                    >
                        <Typography color="primary" sx={{ fontSize: 12, fontWeight: 700, pt: 0.3 }}>
                            0{i + 1}
                        </Typography>
                        <Box>
                            <Typography variant="subtitle2">{t(`saviUi.${key}`)}</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {t(`saviUi.${key}Description`)}
                            </Typography>
                        </Box>
                    </Paper>
                ))}
            </Stack>
            <Button
                fullWidth
                variant="outlined"
                startIcon={<HistoryIcon />}
                endIcon={<ArrowForward />}
                onClick={onShowMiningHistory}
            >
                {t('saviUi.savedCards')} · {miningHistoryCount}
            </Button>
            <Button fullWidth sx={{ mt: 1 }} onClick={onOpenUserGuide}>
                {t('saviUi.watchGuide')}
            </Button>
        </Box>
    );
}
