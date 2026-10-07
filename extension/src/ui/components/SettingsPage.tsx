import SaviBrand from '@project/common/components/SaviBrand';
import Typography from '@mui/material/Typography';
import { CardModel, HttpFetcher } from '@project/common';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import SettingsForm from '@project/common/components/SettingsForm';
import { useCommandKeyBinds } from '../hooks/use-command-key-binds';
import { useLocalFontFamilies } from '@project/common/hooks';
import { useI18n } from '../hooks/use-i18n';
import Paper from '@mui/material/Paper';
import { Anki } from '@project/common/anki';
import { useSupportedLanguages } from '../hooks/use-supported-languages';
import SettingsProfileSelectMenu from '@project/common/components/SettingsProfileSelectMenu';
import { AsbplayerSettings, Profile, testCard } from '@project/common/settings';
import { settingsPageConfigs } from '@/services/pages';
import { DictionaryProvider } from '@project/common/dictionary-db';
import { useLocationHash } from '@project/common/hooks/use-location-hash';
import { useSaviAccount } from '../hooks/use-savi-account';
import { useSaviRoamingSettings } from '../hooks/use-savi-roaming-settings';
import { useSaviMutedSites } from '../hooks/use-savi-muted-sites';
import { useFileUrlAccess } from '../hooks/use-file-url-access';

interface Props {
    dictionaryProvider: DictionaryProvider;
    settings: AsbplayerSettings;
    onSettingsChanged: (settings: Partial<AsbplayerSettings>) => void;
    profiles: Profile[];
    activeProfile?: string;
    inTutorial?: boolean;
    inAnnotationTutorial?: boolean;
    onAnnotationTutorialSeen?: () => void;
    onNewProfile: (name: string) => void;
    onRemoveProfile: (name: string) => void;
    onSetActiveProfile: (name: string | undefined) => void;
}

const extensionTestCard: () => Promise<CardModel> = () => {
    return testCard({
        imageUrl: browser.runtime.getURL('/assets/test-card.jpeg'),
        audioUrl: browser.runtime.getURL('/assets/test-card.mp3'),
    });
};

const SettingsPage = ({
    dictionaryProvider,
    settings,
    inTutorial,
    inAnnotationTutorial,
    onAnnotationTutorialSeen,
    onSettingsChanged,
    ...profileContext
}: Props) => {
    const { t } = useTranslation();
    const anki = useMemo(
        () => (settings === undefined ? undefined : new Anki(settings, new HttpFetcher())),
        [settings]
    );

    const {
        updateLocalFontsPermission,
        updateLocalFonts,
        localFontsAvailable,
        localFontsPermission,
        localFontFamilies,
    } = useLocalFontFamilies();
    const handleUnlockLocalFonts = useCallback(() => {
        updateLocalFontsPermission();
        updateLocalFonts();
    }, [updateLocalFontsPermission, updateLocalFonts]);

    const commands = useCommandKeyBinds();
    const saviAccount = useSaviAccount(settings?.saviCloudUrl ?? '');
    const saviRoaming = useSaviRoamingSettings(settings?.saviCloudUrl ?? '', saviAccount.email ?? '');
    const saviMutedSites = useSaviMutedSites(settings?.saviCloudUrl ?? '', saviAccount.email ?? '');
    const saviFileUrlAccess = useFileUrlAccess();

    const handleOpenExtensionShortcuts = useCallback(() => {
        browser.tabs.create({ active: true, url: 'chrome://extensions/shortcuts' });
    }, []);

    const { initialized: i18nInitialized } = useI18n({ language: settings?.language ?? 'en' });
    const { supportedLanguages } = useSupportedLanguages();

    const { hash: scrollToId } = useLocationHash();

    if (!settings || !anki || !commands || !i18nInitialized) {
        return null;
    }

    return (
        <Box
            component="main"
            sx={{
                minHeight: '100dvh',
                bgcolor: settings.themeType === 'dark' ? '#0f1115' : '#f2f6fa',
                p: { xs: 2, md: 4 },
            }}
        >
            <Box sx={{ maxWidth: 1120, mx: 'auto' }}>
                <Box
                    component="header"
                    sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4, gap: 2 }}
                >
                    <SaviBrand caption={t('saviUi.watchingCompanion')} />
                    <Typography variant="caption" color="text.secondary">
                        {t('saviUi.savedAutomatically')}
                    </Typography>
                </Box>
                <Typography component="h1" variant="h4">
                    {t('saviUi.yourWay')}
                </Typography>
                <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
                    {t('saviUi.settingsIntro')}
                </Typography>
                <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 3 }, minHeight: 560 }}>
                    <SettingsForm
                        anki={anki}
                        extensionInstalled
                        extensionVersion={browser.runtime.getManifest().version}
                        extensionSupportsAppIntegration
                        extensionSupportsOverlay
                        extensionSupportsSidePanel
                        extensionSupportsOrderableAnkiFields
                        extensionSupportsTrackSpecificSettings
                        extensionSupportsSubtitlesWidthSetting
                        extensionSupportsPauseOnHover
                        extensionSupportsExportCardBind
                        extensionSupportsPageSettings
                        extensionSupportsDictionary
                        extensionSupportsDictionaryBrowser
                        extensionSupportsDictionaryWaniKani
                        extensionSupportsDictionaryMatchAcrossScripts
                        extensionSupportsDictionaryTokenAnnotationConfig
                        extensionSupportsSeekableTrackSetting
                        extensionSupportsAutoCopyableTrackSetting
                        extensionSupportsDictionaryTokenStatusDisplayAlpha
                        extensionSupportsDictionaryYomitanMecab
                        chromeKeyBinds={commands}
                        onOpenChromeExtensionShortcuts={handleOpenExtensionShortcuts}
                        onSettingsChanged={onSettingsChanged}
                        dictionaryProvider={dictionaryProvider}
                        settings={settings}
                        profiles={profileContext.profiles}
                        activeProfile={profileContext.activeProfile}
                        pageConfigs={settingsPageConfigs}
                        localFontsAvailable={localFontsAvailable}
                        localFontsPermission={localFontsPermission}
                        localFontFamilies={localFontFamilies}
                        supportedLanguages={supportedLanguages}
                        onUnlockLocalFonts={handleUnlockLocalFonts}
                        inTutorial={inTutorial}
                        inAnnotationTutorial={inAnnotationTutorial}
                        onAnnotationTutorialSeen={onAnnotationTutorialSeen}
                        testCard={extensionTestCard}
                        scrollToId={scrollToId}
                        saviAccountEmail={saviAccount.email}
                        onSaviSignIn={saviAccount.signIn}
                        onSaviSignOut={saviAccount.signOut}
                        saviTargetLanguage={saviRoaming.targetLanguage}
                        onSaviTargetLanguageChange={saviRoaming.setTargetLanguage}
                        saviMutedSites={saviMutedSites.sites}
                        onSaviUnmuteSite={saviMutedSites.unmute}
                        saviFileUrlAccess={saviFileUrlAccess}
                        saviNativeLanguage={saviRoaming.nativeLanguage}
                        onSaviNativeLanguageChange={saviRoaming.setNativeLanguage}
                    />
                </Paper>
                <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
                    <SettingsProfileSelectMenu {...profileContext} />
                </Box>
            </Box>
        </Box>
    );
};

export default SettingsPage;
