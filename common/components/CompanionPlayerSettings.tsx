import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { AsbplayerSettings, SubtitleListPreference } from '../settings';
import SettingsTextField from './SettingsTextField';
import SwitchLabelWithHoverEffect from './SwitchLabelWithHoverEffect';

interface Props {
    settings: Pick<AsbplayerSettings, 'streamingAppUrl' | 'streamingSubtitleListPreference'>;
    onSettingChanged: <K extends keyof AsbplayerSettings>(key: K, value: AsbplayerSettings[K]) => Promise<void>;
    insideApp?: boolean;
}

export default function CompanionPlayerSettings({ settings, onSettingChanged, insideApp }: Props) {
    const autoOpen = settings.streamingSubtitleListPreference !== SubtitleListPreference.noSubtitleList;
    return (
        <Box component="details" sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, my: 2 }}>
            <Box
                component="summary"
                sx={{
                    cursor: 'pointer',
                    fontWeight: 650,
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 4 },
                }}
            >
                Advanced integrations
            </Box>
            <Stack spacing={2} sx={{ mt: 2 }}>
                <Typography component="h3" variant="h6">
                    asbplayer companion player (optional)
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    Opens the separate asbplayer subtitle/player app. This is an optional upstream integration, separate
                    from your Savi account and Savi web app.
                </Typography>
                <SwitchLabelWithHoverEffect
                    control={
                        <Switch
                            checked={autoOpen}
                            onChange={() =>
                                onSettingChanged(
                                    'streamingSubtitleListPreference',
                                    autoOpen ? SubtitleListPreference.noSubtitleList : SubtitleListPreference.app
                                )
                            }
                        />
                    }
                    label="Open the companion subtitle list when loading subtitles"
                    labelPlacement="start"
                />
                {!insideApp && (
                    <SettingsTextField
                        id="companion-player-url"
                        fullWidth
                        label="Companion player URL"
                        value={settings.streamingAppUrl}
                        helperText="Use an asbplayer-compatible player URL. This does not change your Savi connection."
                        onChange={(event) => onSettingChanged('streamingAppUrl', event.target.value)}
                    />
                )}
            </Stack>
        </Box>
    );
}
