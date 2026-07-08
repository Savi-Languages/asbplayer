import React, { useCallback, useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { AsbplayerSettings } from '../settings';
import SettingsSection from './SettingsSection';
import SettingsTextField from './SettingsTextField';
import SwitchLabelWithHoverEffect from './SwitchLabelWithHoverEffect';

// A text field whose value is committed (roamed to the account) on blur rather
// than on every keystroke, so an API key isn't PUT to the cloud character by
// character.
const CommitOnBlurTextField: React.FC<{
    label: string;
    value: string;
    onCommit: (value: string) => void;
    type?: string;
    helperText?: React.ReactNode;
}> = ({ label, value, onCommit, type, helperText }) => {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    return (
        <SettingsTextField
            color="primary"
            fullWidth
            type={type}
            label={label}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
                if (draft !== value) {
                    onCommit(draft);
                }
            }}
            helperText={helperText}
        />
    );
};

interface Props {
    settings: AsbplayerSettings;
    onSettingChanged: <K extends keyof AsbplayerSettings>(key: K, value: AsbplayerSettings[K]) => Promise<void>;
    // Savi account (unified auth): supplied only by extension hosts, which own
    // the session storage. When present, the daemon-token field collapses into a
    // sign-in block and the account-roaming fields below become usable.
    saviAccountEmail?: string;
    onSaviSignIn?: (email: string, password: string) => Promise<{ ok: boolean; errorMessage?: string }>;
    onSaviSignOut?: () => Promise<void>;
    // Account-roaming settings (extension hosts only — cloud-backed).
    saviTargetLanguage?: string;
    onSaviTargetLanguageChange?: (value: string) => void;
    saviOpenSubtitlesApiKey?: string;
    onSaviOpenSubtitlesApiKeyChange?: (value: string) => void;
}

const SaviSettingsTab: React.FC<Props> = ({
    settings,
    onSettingChanged,
    saviAccountEmail,
    onSaviSignIn,
    onSaviSignOut,
    saviTargetLanguage,
    onSaviTargetLanguageChange,
    saviOpenSubtitlesApiKey,
    onSaviOpenSubtitlesApiKeyChange,
}) => {
    const {
        saviAutoLoadSubtitles,
        saviCaptureEnabled,
        saviDaemonUrl,
        saviDaemonToken,
        saviCloudUrl,
        saviHideNativeSubtitles,
        saviRecordingGuard,
        saviAiSegmentation,
        saviGlossing,
    } = settings;

    const [saviEmail, setSaviEmail] = useState('');
    const [saviPassword, setSaviPassword] = useState('');
    const [saviSigningIn, setSaviSigningIn] = useState(false);
    const [saviSignInError, setSaviSignInError] = useState<string>();
    const handleSaviSignIn = useCallback(async () => {
        if (onSaviSignIn === undefined) {
            return;
        }
        setSaviSigningIn(true);
        setSaviSignInError(undefined);
        const result = await onSaviSignIn(saviEmail.trim(), saviPassword);
        setSaviSigningIn(false);
        if (result.ok) {
            setSaviPassword('');
        } else {
            setSaviSignInError(result.errorMessage ?? 'sign-in failed');
        }
    }, [onSaviSignIn, saviEmail, saviPassword]);

    const signedIn = onSaviSignIn !== undefined && Boolean(saviAccountEmail);
    const roamingSupported = onSaviTargetLanguageChange !== undefined;
    const roamingHint = signedIn
        ? 'Saved to your savi account and synced across your devices.'
        : 'Sign in to savi above to sync this across your devices; it works on this device meanwhile.';

    return (
        <Stack spacing={1}>
            <SettingsSection>{'Savi account'}</SettingsSection>
            {onSaviSignIn !== undefined && saviAccountEmail ? (
                <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2" sx={{ flexGrow: 1 }}>
                        {`Signed in as ${saviAccountEmail}`}
                    </Typography>
                    <Button variant="outlined" size="small" onClick={() => void onSaviSignOut?.()}>
                        {'Sign out'}
                    </Button>
                </Stack>
            ) : onSaviSignIn !== undefined ? (
                // Signed out: the account sign-in, with the legacy LAN-token field
                // still available as the transition fallback.
                <>
                    <SettingsTextField
                        color="primary"
                        fullWidth
                        type="email"
                        label={'Savi account email'}
                        value={saviEmail}
                        onChange={(e) => setSaviEmail(e.target.value)}
                    />
                    <SettingsTextField
                        color="primary"
                        fullWidth
                        type="password"
                        label={'Savi account password'}
                        value={saviPassword}
                        onChange={(e) => setSaviPassword(e.target.value)}
                        error={saviSignInError !== undefined}
                        helperText={saviSignInError}
                    />
                    <Stack direction="row">
                        <Button
                            variant="contained"
                            disabled={!saviEmail.trim() || !saviPassword || saviSigningIn}
                            onClick={() => void handleSaviSignIn()}
                        >
                            {saviSigningIn ? 'Signing in…' : 'Sign in to savi'}
                        </Button>
                    </Stack>
                    <SettingsTextField
                        color="primary"
                        fullWidth
                        type="password"
                        label={'Savi daemon token (legacy fallback)'}
                        value={saviDaemonToken}
                        onChange={(e) => onSettingChanged('saviDaemonToken', e.target.value)}
                    />
                </>
            ) : (
                // Hosts without account support (no session storage here).
                <SettingsTextField
                    color="primary"
                    fullWidth
                    type="password"
                    label={'Savi daemon token'}
                    value={saviDaemonToken}
                    onChange={(e) => onSettingChanged('saviDaemonToken', e.target.value)}
                />
            )}

            <SettingsSection>{'Subtitles'}</SettingsSection>
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviAutoLoadSubtitles}
                        onChange={(e) => onSettingChanged('saviAutoLoadSubtitles', e.target.checked)}
                    />
                }
                label={'Auto-load subtitles in your target language from the player (or OpenSubtitles)'}
                labelPlacement="start"
            />
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviGlossing}
                        onChange={(e) => onSettingChanged('saviGlossing', e.target.checked)}
                    />
                }
                label={'Show translations above words you haven’t learned yet (requires sign-in)'}
                labelPlacement="start"
            />
            {roamingSupported && (
                <CommitOnBlurTextField
                    label={'Target language'}
                    value={saviTargetLanguage ?? ''}
                    onCommit={(value) => onSaviTargetLanguageChange?.(value.trim())}
                    helperText={`Language you're learning, as a BCP-47 code — e.g. es, es-419, ja. ${roamingHint}`}
                />
            )}
            {roamingSupported && onSaviOpenSubtitlesApiKeyChange !== undefined && (
                <CommitOnBlurTextField
                    label={'OpenSubtitles API key (fallback)'}
                    type="password"
                    value={saviOpenSubtitlesApiKey ?? ''}
                    onCommit={(value) => onSaviOpenSubtitlesApiKeyChange(value.trim())}
                    helperText={
                        <>
                            {'Used only when the player has no track in your language. Get a key at '}
                            <Link
                                href="https://www.opensubtitles.com/vi/consumers"
                                target="_blank"
                                rel="noopener noreferrer"
                                underline="hover"
                            >
                                {'opensubtitles.com/consumers'}
                            </Link>
                            {`. ${roamingHint}`}
                        </>
                    }
                />
            )}

            <SettingsSection>{'Savi capture'}</SettingsSection>
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviCaptureEnabled}
                        onChange={(e) => onSettingChanged('saviCaptureEnabled', e.target.checked)}
                    />
                }
                label={'Auto-capture episodes to savi when subtitles load'}
                labelPlacement="start"
            />
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviHideNativeSubtitles}
                        onChange={(e) => onSettingChanged('saviHideNativeSubtitles', e.target.checked)}
                    />
                }
                label={"Hide the streaming site's own subtitles"}
                labelPlacement="start"
            />
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviRecordingGuard}
                        onChange={(e) => onSettingChanged('saviRecordingGuard', e.target.checked)}
                    />
                }
                label={'Warn me when recording stops (e.g. after a reload)'}
                labelPlacement="start"
            />
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviAiSegmentation}
                        onChange={(e) => onSettingChanged('saviAiSegmentation', e.target.checked)}
                    />
                }
                label={'AI in-context definitions when you tap a word (requires sign-in)'}
                labelPlacement="start"
            />
            <SettingsTextField
                color="primary"
                fullWidth
                label={'Savi daemon URL'}
                value={saviDaemonUrl}
                onChange={(e) => onSettingChanged('saviDaemonUrl', e.target.value)}
            />
            <SettingsTextField
                color="primary"
                fullWidth
                label={'Savi cloud URL'}
                value={saviCloudUrl}
                onChange={(e) => onSettingChanged('saviCloudUrl', e.target.value)}
            />
        </Stack>
    );
};

export default SaviSettingsTab;
