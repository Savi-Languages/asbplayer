import { forwardRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import MoreHoriz from '@mui/icons-material/MoreHoriz';
import HistoryIcon from '@mui/icons-material/History';
import BarChartIcon from '@mui/icons-material/BarChart';
import LoadSubtitlesIcon from '@project/common/components/LoadSubtitlesIcon';
import SaviBrand from '@project/common/components/SaviBrand';
import { useTranslation } from 'react-i18next';

interface Props {
    show: boolean;
    canDownloadSubtitles: boolean;
    onLoadSubtitles: () => void;
    onDownloadSubtitles: () => void;
    onBulkExportSubtitles: () => void;
    onShowMiningHistory: () => void;
    miningHistoryCount: number;
    onShowStatistics: () => void;
    disableBulkExport?: boolean;
}

// Everyday actions stay visible. Export utilities live in the overflow menu.
const SidePanelTopControls = forwardRef<HTMLDivElement, Props>(function SidePanelTopControls(
    {
        canDownloadSubtitles,
        onLoadSubtitles,
        onDownloadSubtitles,
        onBulkExportSubtitles,
        onShowMiningHistory,
        miningHistoryCount,
        onShowStatistics,
        disableBulkExport,
    },
    ref
) {
    const { t } = useTranslation();
    const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
    return (
        <Box
            ref={ref}
            component="header"
            sx={{
                flexShrink: 0,
                zIndex: 2,
                bgcolor: 'background.paper',
                borderBottom: 1,
                borderColor: 'divider',
                p: 1.5,
            }}
        >
            <Stack direction="row" justifyContent="space-between" alignItems="center">
                <SaviBrand caption={t('saviUi.studyPanel')} />
                {canDownloadSubtitles && (
                    <IconButton
                        aria-label={t('saviUi.moreTools')}
                        aria-haspopup="menu"
                        aria-expanded={Boolean(menuAnchor)}
                        onClick={(e) => setMenuAnchor(e.currentTarget)}
                    >
                        <MoreHoriz />
                    </IconButton>
                )}
            </Stack>
            <Stack
                direction="row"
                spacing={0.5}
                sx={{ mt: 1.5, '& .MuiButton-root': { flex: 1, minWidth: 0, px: 0.75, fontSize: 12 } }}
            >
                <Button startIcon={<LoadSubtitlesIcon />} onClick={onLoadSubtitles}>
                    {t('saviUi.subtitles')}
                </Button>
                <Button startIcon={<HistoryIcon />} onClick={onShowMiningHistory}>
                    {t('saviUi.saved')} · {miningHistoryCount}
                </Button>
                <Button startIcon={<BarChartIcon />} onClick={onShowStatistics}>
                    {t('saviUi.progress')}
                </Button>
            </Stack>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                <MenuItem
                    onClick={() => {
                        setMenuAnchor(null);
                        onDownloadSubtitles();
                    }}
                >
                    {t('action.downloadSubtitlesAsSrt')}
                </MenuItem>
                <MenuItem
                    disabled={disableBulkExport}
                    onClick={() => {
                        setMenuAnchor(null);
                        onBulkExportSubtitles();
                    }}
                >
                    {t('action.bulkExportSubtitles')}
                </MenuItem>
            </Menu>
        </Box>
    );
});
export default SidePanelTopControls;
