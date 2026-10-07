import React from 'react';
import Typography from '@mui/material/Typography';
import Link from '@mui/material/Link';
import IconButton from '@mui/material/IconButton';
import InfoIcon from '@mui/icons-material/Info';

interface Props {
    children: React.ReactNode;
    docs?: string;
}

const SettingsSection = React.forwardRef<HTMLSpanElement, Props>(function SettingsSection({ children, docs }, ref) {
    return (
        <Typography ref={ref} variant="h6" sx={{ fontWeight: 650, pb: 1.5, pt: 2 }}>
            {children}
            {docs && (
                <Link href={`https://docs.asbplayer.dev/${docs}`} target="_blank">
                    <IconButton>
                        <InfoIcon />
                    </IconButton>
                </Link>
            )}
        </Typography>
    );
});

export default SettingsSection;
