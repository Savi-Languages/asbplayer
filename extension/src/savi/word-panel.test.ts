import { SaviWordPanel } from './word-panel';

// The panel builds its sections in show(), so the explanation body only exists
// after one. Minimal input — the AI sections are what we're asserting on.
const openPanel = () => {
    const panel = new SaviWordPanel();
    panel.show({
        term: '改善',
        token: { text: '改善', lemma: '改善' },
        entries: [],
        kanji: [],
        onMine: () => {},
    });
    return panel;
};

const explainText = () => {
    // The explanation body is the section after "✦ In this sentence" and its
    // context line; read the whole panel and assert on its text.
    const panel = document.querySelector('.savi-word-panel') as HTMLElement;
    return panel.textContent ?? '';
};

afterEach(() => {
    document.body.replaceChildren();
});

describe('SaviWordPanel.setExplanation', () => {
    it('renders the explanation when there is one', () => {
        const panel = openPanel();
        panel.setExplanation('Here 改善 is the noun "improvement".');
        expect(explainText()).toContain('the noun "improvement"');
    });

    it('points at the desktop app — NOT at a busy provider — when there is no account', () => {
        // The whole point of this change. Without an account token the daemon
        // never reaches the cloud, so no provider was ever involved; the old copy
        // blamed one and sent debugging after rate limits that did not exist.
        const panel = openPanel();
        panel.setExplanation(null, 'noAccount');
        const text = explainText();
        expect(text).toContain('Start the savi desktop app');
        expect(text.toLowerCase()).not.toContain('provider');
        expect(text.toLowerCase()).not.toContain('busy');
    });

    it('leads with the app, and only then mentions signing in', () => {
        // The common case is a valid account whose published session went stale
        // because the app that refreshes it is closed. "Sign in" sends that user
        // to fix something that is not broken, so it must not lead the message —
        // it stays available in the hint for someone with no account at all.
        const panel = openPanel();
        panel.setExplanation(null, 'noAccount');
        const text = explainText();
        const app = text.indexOf('Start the savi desktop app');
        const signIn = text.indexOf('Sign in from savi settings');
        expect(app).toBeGreaterThanOrEqual(0);
        expect(signIn).toBeGreaterThan(app);
    });

    it('names the daemon when the desktop app is unreachable', () => {
        const panel = openPanel();
        panel.setExplanation(null, 'noDaemon');
        const text = explainText();
        expect(text).toContain("savi desktop app isn't reachable");
        expect(text.toLowerCase()).not.toContain('provider');
    });

    it('says the setting is off when the feature is disabled', () => {
        const panel = openPanel();
        panel.setExplanation(null, 'disabled');
        expect(explainText()).toContain('turned off in savi settings');
    });

    it('blames the provider ONLY when a provider was actually called', () => {
        const panel = openPanel();
        panel.setExplanation(null, 'provider');
        expect(explainText()).toContain("AI provider didn't respond");
    });

    it('falls back to a neutral note when the reason is unknown', () => {
        // Old background builds send no `unavailable` field; the panel must not
        // invent a cause for them.
        const panel = openPanel();
        panel.setExplanation(null);
        const text = explainText();
        expect(text).toContain('No AI explanation for this word right now.');
        expect(text.toLowerCase()).not.toContain('provider');
    });

    it('replaces a previous message instead of stacking onto it', () => {
        const panel = openPanel();
        panel.setExplanation(null, 'noAccount');
        panel.setExplanation('App running now — 改善 means improvement.');
        const text = explainText();
        expect(text).toContain('means improvement');
        expect(text).not.toContain('Start the savi desktop app');
    });
});
