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

    it('points at signing in — NOT at a busy provider — when there is no account', () => {
        // The whole point of this change. Without an account token the daemon
        // never reaches the cloud, so no provider was ever involved; the old copy
        // blamed one and sent debugging after rate limits that did not exist.
        // The extension owns its sign-in, so signed-out means exactly that and
        // the fix is signing in HERE (docs/auth-architecture-decision.md).
        const panel = openPanel();
        panel.setExplanation(null, 'noAccount');
        const text = explainText();
        expect(text).toContain('Sign in from savi settings');
        expect(text.toLowerCase()).not.toContain('provider');
        expect(text.toLowerCase()).not.toContain('busy');
    });

    it('a wrong account is named as such — a real session, the wrong one', () => {
        // The daemon verified a validly-signed session for a DIFFERENT account
        // than the one the desktop app pinned. Generic signed-out copy would
        // send the user to sign in again into the same wrong account.
        const panel = openPanel();
        panel.setExplanation(null, 'accountMismatch');
        const text = explainText();
        expect(text).toContain('different savi account');
        expect(text).toContain('same account');
        expect(text.toLowerCase()).not.toContain('provider');
    });

    it('an unverified account points at the desktop app, not at sign-in', () => {
        // Trust is provisioned by the desktop app; until it has run and signed
        // in once, even the RIGHT account cannot verify. Both sign-in
        // instructions would be wrong advice here.
        const panel = openPanel();
        panel.setExplanation(null, 'accountUnverified');
        const text = explainText();
        expect(text).toContain("hasn't verified your account");
        expect(text).toContain('Start the desktop app');
        expect(text.toLowerCase()).not.toContain('provider');
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
        panel.setExplanation('Signed in now — 改善 means improvement.');
        const text = explainText();
        expect(text).toContain('means improvement');
        expect(text).not.toContain('Sign in from savi settings');
    });
});
