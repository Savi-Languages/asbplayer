import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import ThemeProvider from '@mui/material/styles/ThemeProvider';
import CssBaseline from '@mui/material/CssBaseline';
import Paper from '@mui/material/Paper';
import { useI18n } from '../hooks/use-i18n';
import { createTheme } from '@project/common/theme';
import SaviBrand from '@project/common/components/SaviBrand';
import React, { useEffect, useState } from 'react';
import Tutorial from './Tutorial';
import { ExtensionSettingsStorage } from '@/services/extension-settings-storage';
import { SettingsProvider } from '@project/common/settings';
import { type PaletteMode } from '@mui/material';

const settingsProvider = new SettingsProvider(new ExtensionSettingsStorage());
export default function FtueUi() {
    const [themeType, setThemeType] = useState<PaletteMode>('dark');
    const [showTutorial, setShowTutorial] = useState(false);
    const { t } = useTranslation();
    const language = new URLSearchParams(window.location.search).get('lang') ?? browser.i18n.getUILanguage();
    const { initialized } = useI18n({ language });
    useEffect(() => {
        settingsProvider.getSingle('themeType').then(setThemeType);
    }, []);
    if (!initialized) return null;
    return (
        <ThemeProvider theme={createTheme(themeType)}>
            <CssBaseline />
            <Paper square sx={{ minHeight: '100dvh', p: { xs: 3, md: 6 } }}>
                <Box sx={{ maxWidth: 920, mx: 'auto' }}>
                    <SaviBrand caption={t('saviUi.watchingCompanion')} />
                    {showTutorial ? (
                        <Tutorial show className="savi-watching-tutorial" />
                    ) : (
                        <Box component="main" sx={{ pt: { xs: 7, md: 10 } }}>
                            <Typography variant="overline" color="primary" sx={{ letterSpacing: '0.16em' }}>
                                {t('saviUi.makeItYours')}
                            </Typography>
                            <Typography
                                component="h1"
                                variant="h4"
                                sx={{ fontSize: { xs: 38, md: 60 }, maxWidth: 640, lineHeight: 1.08, mt: 2 }}
                            >
                                {t('saviUi.welcome')}
                            </Typography>
                            <Typography color="text.secondary" sx={{ fontSize: 18, mt: 3, maxWidth: 530 }}>
                                {t('saviUi.welcomeIntro')}
                            </Typography>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ my: 4 }}>
                                <Button
                                    variant="contained"
                                    onClick={() =>
                                        browser.tabs.create({
                                            active: true,
                                            url: `${browser.runtime.getURL('/options.html')}#savi-settings`,
                                        })
                                    }
                                >
                                    {t('saviUi.getStarted')}
                                </Button>
                                <Button variant="outlined" onClick={() => setShowTutorial(true)}>
                                    {t('saviUi.tryWatching')}
                                </Button>
                            </Stack>
                            <Box
                                sx={{
                                    display: 'grid',
                                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
                                    gap: 2,
                                    mt: 7,
                                }}
                            >
                                {['followAlong', 'exploreWords', 'keepTheMoment'].map((key, i) => (
                                    <Paper key={key} variant="outlined" sx={{ p: 3 }}>
                                        <Typography color="primary" variant="overline">
                                            0{i + 1}
                                        </Typography>
                                        <Typography variant="h6" sx={{ my: 1 }}>
                                            {t(`saviUi.${key}`)}
                                        </Typography>
                                        <Typography variant="body2" color="text.secondary">
                                            {t(`saviUi.${key}Description`)}
                                        </Typography>
                                    </Paper>
                                ))}
                            </Box>
                        </Box>
                    )}
                </Box>
            </Paper>
        </ThemeProvider>
    );
}
