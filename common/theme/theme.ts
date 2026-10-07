import { createTheme as createMuiTheme, PaletteMode } from '@mui/material/styles';

// Mirrors Savi packages/ui/src/theme.css. Keep page backgrounds transparent:
// several consumers live in iframes over the user's video.
export const saviColors = {
    background: '#0f1115',
    surface: '#171b22',
    raised: '#20262f',
    border: '#2a313c',
    text: '#e8eaed',
    muted: '#98a0ab',
    accent: '#4cc2ff',
    ink: '#06222e',
    accentDim: '#173243',
};

export const createTheme = (mode: PaletteMode) => {
    const dark = mode === 'dark';
    const border = dark ? saviColors.border : '#d8e0e8';
    return createMuiTheme({
        palette: {
            mode,
            primary: { main: dark ? saviColors.accent : '#006b9e', contrastText: dark ? saviColors.ink : '#ffffff' },
            secondary: { main: dark ? '#ffb454' : '#915500' },
            error: { main: dark ? '#ff8b86' : '#bb302b' },
            success: { main: dark ? '#66dba5' : '#187948' },
            warning: { main: dark ? '#ffb454' : '#915500' },
            background: { default: 'transparent', paper: dark ? saviColors.surface : '#ffffff' },
            text: { primary: dark ? saviColors.text : '#172331', secondary: dark ? saviColors.muted : '#526172' },
            divider: border,
            action: { selected: dark ? saviColors.accentDim : '#e1f2fb', hover: dark ? '#20262f' : '#f0f5f9' },
        },
        shape: { borderRadius: 14 },
        typography: {
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif',
            h4: { fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.04em' },
            h5: { fontSize: '1.35rem', fontWeight: 650, letterSpacing: '-0.025em' },
            h6: { fontSize: '1.05rem', fontWeight: 650, letterSpacing: '-0.015em' },
            button: { textTransform: 'none', fontWeight: 650, letterSpacing: 0 },
            body2: { lineHeight: 1.6 },
        },
        components: {
            MuiCssBaseline: {
                styleOverrides: {
                    body: { WebkitFontSmoothing: 'antialiased' },
                    '*': { scrollbarWidth: 'thin', scrollbarColor: `${border} transparent` },
                    ':focus-visible': {
                        outline: `2px solid ${dark ? saviColors.accent : '#006b9e'}`,
                        outlineOffset: 3,
                    },
                    '@media (prefers-reduced-motion: reduce)': {
                        '*, *::before, *::after': {
                            animationDuration: '0.01ms !important',
                            transitionDuration: '0.01ms !important',
                            scrollBehavior: 'auto !important',
                        },
                    },
                },
            },
            MuiPaper: {
                defaultProps: { elevation: 0 },
                styleOverrides: { root: { backgroundImage: 'none' }, outlined: { borderColor: border } },
            },
            MuiButton: {
                defaultProps: { disableElevation: true },
                styleOverrides: {
                    root: { borderRadius: 10, minHeight: 40, paddingInline: 16 },
                    sizeSmall: { minHeight: 34 },
                    outlined: { borderColor: border },
                },
            },
            MuiIconButton: {
                styleOverrides: {
                    root: {
                        borderRadius: 10,
                        '&.Mui-focusVisible': { outline: '2px solid currentColor', outlineOffset: 2 },
                    },
                },
            },
            MuiDialog: {
                styleOverrides: {
                    paper: { border: `1px solid ${border}`, borderRadius: 20, boxShadow: '0 24px 80px #0006' },
                },
            },
            MuiDialogTitle: { styleOverrides: { root: { padding: '24px 24px 16px', fontSize: 22, fontWeight: 650 } } },
            MuiDialogActions: {
                styleOverrides: { root: { padding: '16px 24px', gap: 8, borderTop: `1px solid ${border}` } },
            },
            MuiOutlinedInput: {
                styleOverrides: {
                    root: { borderRadius: 10, backgroundColor: dark ? '#11161d' : '#f8fafc' },
                    notchedOutline: { borderColor: border },
                },
            },
            MuiTab: {
                styleOverrides: {
                    root: {
                        textTransform: 'none',
                        fontWeight: 550,
                        borderRadius: 10,
                        '&.Mui-selected': { backgroundColor: dark ? saviColors.accentDim : '#e1f2fb' },
                    },
                },
            },
            MuiTabs: { styleOverrides: { indicator: { display: 'none' }, flexContainer: { gap: 5 } } },
            MuiTooltip: {
                styleOverrides: {
                    tooltip: {
                        background: dark ? '#2a313c' : '#172331',
                        color: '#fff',
                        borderRadius: 8,
                        padding: '8px 12px',
                        fontSize: 12,
                    },
                },
            },
            MuiSwitch: { defaultProps: { color: 'primary' } },
            MuiChip: { styleOverrides: { root: { borderRadius: 8 } } },
            MuiTableCell: {
                styleOverrides: {
                    root: { borderColor: border },
                    head: { color: dark ? saviColors.muted : '#526172', fontSize: 12 },
                },
            },
            MuiAccordion: {
                styleOverrides: { root: { border: `1px solid ${border}`, '&:before': { display: 'none' } } },
            },
            MuiAlert: { styleOverrides: { root: { borderRadius: 12 } } },
        },
    });
};
