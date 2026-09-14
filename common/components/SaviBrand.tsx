import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LogoIcon from './LogoIcon';

export default function SaviBrand({ caption }: { caption?: string }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <LogoIcon sx={{ width: 34, height: 34 }} />
            <Box>
                <Typography
                    component="span"
                    sx={{ fontSize: 25, fontWeight: 750, letterSpacing: '-1px', lineHeight: 1 }}
                >
                    savi
                </Typography>
                {caption && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.4 }}>{caption}</Typography>}
            </Box>
        </Box>
    );
}
