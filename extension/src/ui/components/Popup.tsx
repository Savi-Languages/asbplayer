import { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import ArrowForward from '@mui/icons-material/ArrowForward';
import Launch from '@mui/icons-material/Launch';
import Translate from '@mui/icons-material/Translate';
import { isMobile } from 'react-device-detect';
import { AsbplayerSettings, Profile } from '@project/common/settings';
import { DictionaryProvider } from '@project/common/dictionary-db';
import SaviBrand from '@project/common/components/SaviBrand';
import Tooltip from '@project/common/components/Tooltip';
import { useI18n } from '../hooks/use-i18n';
import { useTranslation } from 'react-i18next';
import { useSaviAccount } from '../hooks/use-savi-account';
import SaviCapturePanel from '@/savi/ui/SaviCapturePanel';

interface Props {
    dictionaryProvider: DictionaryProvider;
    settings: AsbplayerSettings;
    commands: any;
    onSettingsChanged: (settings: Partial<AsbplayerSettings>) => void;
    onOpenApp: () => void;
    onOpenSidePanel: () => void;
    onOpenExtensionShortcuts: () => void;
    onOpenUserGuide: () => void;
    profiles: Profile[];
    activeProfile?: string;
    onNewProfile: (name: string) => void;
    onRemoveProfile: (name: string) => void;
    onSetActiveProfile: (name: string | undefined) => void;
}

export default function Popup({ settings, onSettingsChanged, onOpenApp, onOpenSidePanel, onOpenUserGuide }: Props) {
    const { initialized } = useI18n({ language: settings.language });
    const { t } = useTranslation();
    const account = useSaviAccount(settings.saviCloudUrl ?? '');
    const [error, setError] = useState<string>();
    const openSettings = useCallback((section = 'savi-settings') => {
        browser.tabs.create({ active: true, url: `${browser.runtime.getURL('/options.html')}#${section}` });
    }, []);
    if (!initialized) return null;
    return (
        <Box component="main" sx={{ p: 2.5, bgcolor: 'background.paper' }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 3 }}>
                <SaviBrand caption={t('saviUi.watchingCompanion')} />
                <Tooltip title={t('settings.title')}>
                    <IconButton aria-label={t('settings.title')} onClick={() => openSettings()}>
                        <SettingsOutlined />
                    </IconButton>
                </Tooltip>
            </Stack>
            <Typography variant="overline" color="primary" sx={{ fontSize: 10, letterSpacing: '0.14em' }}>
                {t('saviUi.makeItYours')}
            </Typography>
            <Typography component="h1" variant="h4" sx={{ fontSize: 29, mt: 0.5 }}>
                {t('saviUi.keepWatching')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 2.5 }}>
                {t('saviUi.popupIntro')}
            </Typography>
            <Button
                fullWidth
                variant="contained"
                endIcon={<ArrowForward />}
                sx={{ minHeight: 46 }}
                onClick={async () => {
                    try {
                        await (isMobile ? onOpenApp() : onOpenSidePanel());
                    } catch {
                        setError(t('saviUi.panelError'));
                    }
                }}
            >
                {isMobile ? t('saviUi.openPlayer') : t('saviUi.openStudyPanel')}
            </Button>
            {error && (
                <Typography role="alert" color="error" variant="body2" sx={{ mt: 1 }}>
                    {error}
                </Typography>
            )}
            <Box sx={{ my: 2 }}>
                <SaviCapturePanel settings={settings} />
            </Box>
            <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Translate color="primary" fontSize="small" />
                    <Typography variant="subtitle2">{t('saviUi.whileWatching')}</Typography>
                </Stack>
                <FormControlLabel
                    sx={{ display: 'flex', m: 0, justifyContent: 'space-between' }}
                    labelPlacement="start"
                    label={<Typography variant="body2">{t('saviUi.pauseToExplore')}</Typography>}
                    control={
                        <Switch
                            checked={settings.pauseOnHoverMode !== 0}
                            onChange={(_, checked) => onSettingsChanged({ pauseOnHoverMode: checked ? 1 : 0 })}
                        />
                    }
                />
                <Typography variant="caption" color="text.secondary">
                    {t('saviUi.pauseDescription')}
                </Typography>
                <Button
                    fullWidth
                    variant="text"
                    sx={{ mt: 1, justifyContent: 'space-between' }}
                    endIcon={<ArrowForward fontSize="small" />}
                    onClick={() => openSettings('subtitle-appearance')}
                >
                    {t('settings.subtitleAppearance')}
                </Button>
            </Paper>
            <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                <Button variant="outlined" fullWidth startIcon={<Launch />} onClick={onOpenApp}>
                    {t('saviUi.openPlayer')}
                </Button>
                <Button variant="outlined" fullWidth onClick={onOpenUserGuide}>
                    {t('saviUi.watchGuide')}
                </Button>
            </Stack>
            <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box
                    sx={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        bgcolor: account.email ? 'success.main' : 'text.secondary',
                        flexShrink: 0,
                    }}
                />
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                    {account.email ?? t('saviUi.connectAccount')}
                </Typography>
                <Button size="small" onClick={() => openSettings()}>
                    {account.email ? t('saviUi.account') : t('saviUi.signIn')}
                </Button>
            </Box>
        </Box>
    );
}
