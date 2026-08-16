import React, { useCallback, useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import FormHelperText from '@mui/material/FormHelperText';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import DeleteIcon from '@mui/icons-material/Delete';
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
    // Account-roaming settings (extension hosts only — cloud-backed). The
    // OpenSubtitles API key is deliberately NOT here anymore (SV-30): it is
    // entered and managed in SAVI's Settings (multiple keys, quota rotation);
    // the auto-load fallback reads it from the account automatically.
    saviTargetLanguage?: string;
    onSaviTargetLanguageChange?: (value: string) => void;
    // Sites savi was switched off for from the in-page button (SV-44). Extension
    // hosts only — the list lives in browser.storage, which the web app has no
    // access to, so it passes neither prop and the section simply does not
    // render. Without this the button would be a one-way door: savi goes quiet
    // on a site with nothing anywhere to say why, or to undo it.
    saviMutedSites?: string[];
    onSaviUnmuteSite?: (siteKey: string) => void;
    // Whether Chrome lets the extension see file:// pages (SV-44). Extension
    // hosts only. 'unknown' (the web app, or Firefox, which has no such toggle)
    // renders nothing.
    saviFileUrlAccess?: 'unknown' | 'allowed' | 'blocked';
}

const SaviSettingsTab: React.FC<Props> = ({
    settings,
    onSettingChanged,
    saviMutedSites,
    onSaviUnmuteSite,
    saviFileUrlAccess,
    saviAccountEmail,
    onSaviSignIn,
    onSaviSignOut,
    saviTargetLanguage,
    onSaviTargetLanguageChange,
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
        saviHoverGloss,
        saviEncounterRecording,
        saviAudioRecording,
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

            {saviMutedSites !== undefined && saviMutedSites.length > 0 && onSaviUnmuteSite !== undefined && (
                <>
                    <SettingsSection>{'Sites Savi is switched off for'}</SettingsSection>
                    <FormHelperText>
                        {'You pressed “Don’t use Savi on this site” on these. Remove one to let Savi run there again.'}
                    </FormHelperText>
                    <List dense>
                        {saviMutedSites.map((site) => (
                            <ListItem
                                key={site}
                                secondaryAction={
                                    <IconButton
                                        edge="end"
                                        aria-label={`Use Savi on ${site} again`}
                                        onClick={() => onSaviUnmuteSite(site)}
                                    >
                                        <DeleteIcon fontSize="small" />
                                    </IconButton>
                                }
                            >
                                <ListItemText primary={site === 'file://' ? 'Local files (file://)' : site} />
                            </ListItem>
                        ))}
                    </List>
                </>
            )}

            {saviFileUrlAccess === 'blocked' && (
                <>
                    <SettingsSection>{'Local video files'}</SettingsSection>
                    <FormHelperText>
                        {
                            'Savi cannot see videos you open from disk. Chrome blocks extensions from file:// pages until you allow it per-extension, and while it is off nothing Savi does runs on those pages at all — which is why this notice is here rather than on the video. Open chrome://extensions, find asbplayer, and turn on “Allow access to file URLs”, then reload the video tab.'
                        }
                    </FormHelperText>
                </>
            )}

            <SettingsSection>{'Subtitles'}</SettingsSection>
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviAutoLoadSubtitles}
                        onChange={(e) => onSettingChanged('saviAutoLoadSubtitles', e.target.checked)}
                    />
                }
                label={
                    'Auto-load subtitles in your target language from the player (or OpenSubtitles — key managed in Savi Settings)'
                }
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
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviHoverGloss}
                        onChange={(e) => onSettingChanged('saviHoverGloss', e.target.checked)}
                    />
                }
                label={'Hover a word for its translation, and hold the line at its end while hovering'}
                labelPlacement="start"
            />
            <CommitOnBlurTextField
                label={'Hold subtitles past their cue end'}
                value={String(settings.saviHoldSubtitleMs)}
                type="number"
                onCommit={(value) => {
                    const ms = Number(value);
                    onSettingChanged('saviHoldSubtitleMs', Number.isFinite(ms) ? Math.trunc(ms) : -1);
                }}
                helperText={
                    'Auto-timed tracks often end a line before the speaker stops. -1 (default) keeps ' +
                    'it up until the next line is due; 0 turns this off; a positive number caps it in ' +
                    'ms. It never overlaps the next line either way.'
                }
            />
            {roamingSupported && (
                <CommitOnBlurTextField
                    label={'Target language'}
                    value={saviTargetLanguage ?? ''}
                    onCommit={(value) => onSaviTargetLanguageChange?.(value.trim())}
                    helperText={`Language you're learning, as a BCP-47 code — e.g. es, es-419, ja. ${roamingHint}`}
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
                        checked={saviEncounterRecording}
                        onChange={(e) => onSettingChanged('saviEncounterRecording', e.target.checked)}
                    />
                }
                label={'Count words in displayed subtitles toward your listening stats'}
                labelPlacement="start"
            />
            <SwitchLabelWithHoverEffect
                control={
                    <Switch
                        checked={saviAudioRecording}
                        onChange={(e) => onSettingChanged('saviAudioRecording', e.target.checked)}
                    />
                }
                label={'Record audio during captures (via the desktop app; applies to the next capture)'}
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
