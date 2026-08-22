/**
 * @jest-environment node
 *
 * Static server rendering — no DOM needed, and jsdom lacks the MessageChannel
 * react-dom's browser server build reaches for.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '@mui/material/styles';
import SaviSettingsTab from './SaviSettingsTab';
import { defaultSettings } from '../settings/settings-provider';
import { createTheme } from '../theme';

// The blacklist section shipped invisible twice: once because it only rendered
// when the list was non-empty, and once because a sync bug emptied the list
// before it painted. Both looked identical from the outside — "the feature
// isn't there" — and nothing in this package could render a component in a
// test to tell them apart. That is what this file is for.
// Wrapped in the same ThemeProvider the real hosts use — the tab's styled
// components read `theme.palette`, exactly as they do in the options page.
const render = (props: Partial<Parameters<typeof SaviSettingsTab>[0]> = {}) =>
    renderToStaticMarkup(
        <ThemeProvider theme={createTheme('dark')}>
            <SaviSettingsTab settings={defaultSettings} onSettingChanged={() => {}} {...(props as any)} />
        </ThemeProvider>
    );

const HEADING = 'Sites Savi is switched off for';

describe('SaviSettingsTab — the site blacklist section', () => {
    it('renders the section for an extension host even with an EMPTY list', () => {
        // The case the user actually hits first. Hiding it here made "nothing
        // is blacklisted" indistinguishable from "the feature is missing".
        const html = render({ saviMutedSites: [], onSaviUnmuteSite: () => {} });

        expect(html).toContain(HEADING);
        expect(html).toContain('No sites yet');
    });

    it('lists a blacklisted site with a control to remove it', () => {
        const html = render({ saviMutedSites: ['youtube.com'], onSaviUnmuteSite: () => {} });

        expect(html).toContain(HEADING);
        expect(html).toContain('youtube.com');
        // The un-blacklist affordance, identified the way a screen reader finds it.
        expect(html).toContain('Use Savi on youtube.com again');
    });

    it('names local files readably rather than showing the raw key', () => {
        const html = render({ saviMutedSites: ['file://'], onSaviUnmuteSite: () => {} });

        expect(html).toContain('Local files (file://)');
    });

    it('renders nothing for a host that cannot supply the list (the web app)', () => {
        // The web app has no browser.storage, so it passes neither prop and
        // must not advertise a list it cannot show or edit.
        expect(render()).not.toContain(HEADING);
    });
});
