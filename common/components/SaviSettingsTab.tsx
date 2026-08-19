import React, { useCallback, useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
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
import { languageLabel, languageOptions, resolveLanguageInput } from '../languages/languages';

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

// A language picker over the curated list, still accepting a typed tag.
//
// `freeSolo` is not decoration: the list is a convenience, not a whitelist, and
// locking the field to it would drop support for any tag it omits — including
// values already stored from before this picker existed. Commits on selection
// and on blur, matching CommitOnBlurTextField, so the account isn't written
// once per keystroke.
const LanguageAutocomplete: React.FC<{
    label: string;
    value: string;
    onCommit: (value: string) => void;
    helperText?: React.ReactNode;
}> = ({ label, value, onCommit, helperText }) => {
    const options = languageOptions(value);
    // The box shows a NAME; the setting stores a TAG. `draft` is what's on
    // screen, so it is display text, and every commit resolves it back.
    const [draft, setDraft] = useState(() => languageLabel(value));
    useEffect(() => setDraft(languageLabel(value)), [value]);

    const commit = useCallback(
        (text: string) => {
            const tag = resolveLanguageInput(text, options);
            if (tag !== value) {
                onCommit(tag);
            }
            // Re-render the canonical label, so a name typed by hand ("Japanese")
            // settles into the same text a picked option would show.
            setDraft(languageLabel(tag));
        },
        [onCommit, options, value]
    );

    return (
        <Autocomplete
            freeSolo
            autoHighlight
            selectOnFocus
            handleHomeEndKeys
            options={options}
            inputValue={draft}
            onInputChange={(_, next) => setDraft(next)}
            onChange={(_, next) => commit(typeof next === 'string' ? next : '')}
            getOptionLabel={(option) => (typeof option === 'string' ? languageLabel(option) : '')}
            filterOptions={(opts, { inputValue }) => {
                const needle = inputValue.trim().toLowerCase();
                // A freshly-focused field holds the current label; filtering by
                // it would show one row and hide the rest of the list.
                if (needle.length === 0 || needle === languageLabel(value).toLowerCase()) {
                    return opts;
                }
                // Match the name as well as the tag — someone looking for
                // Japanese should find it by typing "jap", not just "ja".
                return opts.filter(
                    (o) => o.toLowerCase().includes(needle) || languageLabel(o).toLowerCase().includes(needle)
                );
            }}
            renderInput={(params) => (
                <SettingsTextField
                    {...params}
                    color="primary"
                    fullWidth
                    label={label}
                    helperText={helperText}
                    onBlur={() => commit(draft)}
                />
            )}
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
    saviNativeLanguage?: string;
    onSaviNativeLanguageChange?: (value: string) => void;
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
    saviNativeLanguage,
    onSaviNativeLanguageChange,
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

            {/* Rendered whenever the host supplies the props (i.e. the extension —
                the web app has no browser.storage and passes neither), INCLUDING
                when the list is empty. Hiding an empty list made the feature
                invisible to anyone who had not already muted something, so
                there was no way to tell "nothing is blacklisted" apart from
                "the list is broken" — which is exactly the confusion a silent
                wipe bug produced. */}
            {saviMutedSites !== undefined && onSaviUnmuteSite !== undefined && (
                <>
                    <SettingsSection>{'Sites Savi is switched off for'}</SettingsSection>
                    <FormHelperText>
                        {saviMutedSites.length === 0
                            ? 'No sites yet. Press “Don’t use Savi on this site” on a site to add one — it will be listed here, ' +
                              'saved to your Savi account, and removable at any time.'
                            : 'You pressed “Don’t use Savi on this site” on these. Remove one to let Savi run there again. ' +
                              'The list is saved to your Savi account, so it follows you to your other browsers and devices.'}
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
                    'Auto-timed tracks often end a line before the speaker stops, so the last line is ' +
                    'held briefly. 2000 (default) caps the hold in ms; 0 turns it off; -1 holds until ' +
                    'the next line is due — best for auto-timed tracks (YouTube ASR), but on a ' +
                    'human-timed track it parks a finished line over real silence. It never overlaps ' +
                    'the next line either way.'
                }
            />
            {roamingSupported && (
                <LanguageAutocomplete
                    label={'Target language'}
                    value={saviTargetLanguage ?? ''}
                    onCommit={(value) => onSaviTargetLanguageChange?.(value)}
                    helperText={`The language you're learning. ${roamingHint}`}
                />
            )}
            {roamingSupported && onSaviNativeLanguageChange !== undefined && (
                <LanguageAutocomplete
                    label={'Native language (second subtitle line)'}
                    value={saviNativeLanguage ?? ''}
                    onCommit={(value) => onSaviNativeLanguageChange(value)}
                    helperText={`Shown under the target line when the video has that track. Leave blank for a single line. ${roamingHint}`}
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
