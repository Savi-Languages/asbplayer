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

const panelDivs = () => Array.from(document.querySelectorAll<HTMLElement>('.savi-word-panel div'));

// The "Sentence breakdown" disclosure: a caret + label header, then the body it
// toggles. Hidden by default (display:none), which is exactly why what it says
// must stay short — it is read on purpose, never at a glance.
const breakdownBody = () => {
    const header = panelDivs().find((el) => el.textContent === '▸Sentence breakdown');
    if (!header) {
        throw new Error('no "Sentence breakdown" section in the panel');
    }
    return header.nextElementSibling as HTMLElement;
};

// The terse "▸ gloss · grammar" line right under the "✦ In this sentence" label.
const contextLine = () => {
    const label = panelDivs().find((el) => el.textContent === '✦ In this sentence');
    if (!label) {
        throw new Error('no "In this sentence" section in the panel');
    }
    return label.nextElementSibling as HTMLElement;
};

afterEach(() => {
    document.body.replaceChildren();
});

describe('SaviWordPanel.setContext — the "Sentence breakdown" section', () => {
    it('renders one row per AI chunk when segmentation succeeded', () => {
        const panel = openPanel();
        panel.setContext({ gloss: 'improvement', grammar: 'noun' }, [
            { text: '改善', reading: 'かいぜん', lemma: '改善', gloss: 'improvement', grammar: 'noun' },
            { text: 'を', lemma: 'を', grammar: 'object particle' },
        ]);
        const text = breakdownBody().textContent ?? '';
        expect(text).toContain('改善（かいぜん）');
        expect(text).toContain('improvement · noun');
        expect(text).toContain('object particle');
        expect(text).not.toContain('segmenting the line');
        expect(contextLine().textContent).toBe('▸ improvement · noun');
    });

    it('never renders the bare word "unavailable" any more', () => {
        // The pre-typed-reason rendering: a lone italic "unavailable" that told
        // the user nothing about which of five different fixes applied. Every
        // path below replaces it with a sentence; this pins the floor.
        const panel = openPanel();
        for (const why of [
            'noAccount',
            'accountMismatch',
            'accountUnverified',
            'disabled',
            'noDaemon',
            'provider',
        ] as const) {
            panel.setContext(null, null, why);
            expect(breakdownBody().textContent?.trim()).not.toBe('unavailable');
        }
        panel.setContext(null, null);
        expect(breakdownBody().textContent?.trim()).not.toBe('unavailable');
    });

    it("provider ⇒ says the AI's split was not usable and the rule-based reading was kept", () => {
        // On /v2/segment `provider` means a verified identity WAS relayed and
        // still no AI split came back that the daemon could reconcile with the
        // line — a cloud failure, an unparseable answer, or a hallucinated
        // boundary. The honest thing to say is what happened to THIS line: no
        // usable split, rule-based kept. Not "provider busy".
        const panel = openPanel();
        panel.setContext(null, null, 'provider');
        const text = breakdownBody().textContent ?? '';
        expect(text).toContain("didn't return a split that matches this line");
        expect(text).toContain('rule-based');
        expect(text.toLowerCase()).not.toContain('busy');
    });

    it('no account ⇒ the same sign-in copy as the explanation section, one line, no hint', () => {
        // Same source of truth as setExplanation (unavailableMessage), so the
        // two sections can never disagree about the account state — but ONLY
        // the note. The hint is the explanation section's job.
        const panel = openPanel();
        panel.setContext(null, null, 'noAccount');
        const body = breakdownBody();
        expect(body.textContent).toContain('Sign in from savi settings');
        expect(body.textContent).not.toContain('dictionary above works without an account');
        expect(body.childElementCount).toBe(1);
        expect(body.textContent?.toLowerCase()).not.toContain('provider');
    });

    it('a wrong account is named as such here too', () => {
        const panel = openPanel();
        panel.setContext(null, null, 'accountMismatch');
        const body = breakdownBody();
        expect(body.textContent).toContain('different savi account');
        expect(body.textContent).not.toContain('Sign into the same account'); // the hint stays with setExplanation
        expect(body.childElementCount).toBe(1);
    });

    it('an unverified account points at the desktop app, in one line', () => {
        const panel = openPanel();
        panel.setContext(null, null, 'accountUnverified');
        const body = breakdownBody();
        expect(body.textContent).toContain("hasn't verified your account");
        expect(body.textContent).not.toContain('Start the desktop app'); // hint, not ours
        expect(body.childElementCount).toBe(1);
    });

    it('disabled / noDaemon name the setting and the app, respectively', () => {
        const panel = openPanel();
        panel.setContext(null, null, 'disabled');
        expect(breakdownBody().textContent).toContain('turned off in savi settings');
        panel.setContext(null, null, 'noDaemon');
        expect(breakdownBody().textContent).toContain("savi desktop app isn't reachable");
    });

    it('no reason ⇒ a neutral note that invents no cause', () => {
        // A pre-typed-reason background sends none, and the promise .catch path
        // has none — the panel must not guess.
        const panel = openPanel();
        panel.setContext(null, null);
        const text = breakdownBody().textContent ?? '';
        expect(text).toContain('No AI breakdown for this line right now.');
        expect(text.toLowerCase()).not.toContain('provider');
        expect(text.toLowerCase()).not.toContain('sign in');
    });

    it('does not double up: the explanation section carries the loud message, the breakdown one line', () => {
        // Both AI calls failed for the same reason. The explanation section is
        // where the user looks (open by default) → note + hint live there. The
        // breakdown (collapsed) says the reason once, and the terse
        // "in this sentence" line stays EMPTY rather than contradict either.
        const panel = openPanel();
        panel.setExplanation(null, 'noAccount');
        panel.setContext(null, null, 'noAccount');
        expect(explainText()).toContain('The dictionary above works without an account'); // the hint, once
        expect(explainText().split('The dictionary above works without an account').length).toBe(2);
        expect(breakdownBody().childElementCount).toBe(1);
        expect(contextLine().textContent).toBe('');
    });

    it('replaces the loading spinner and a previous note instead of stacking', () => {
        const panel = openPanel();
        expect(breakdownBody().textContent).toContain('segmenting the line');
        panel.setContext(null, null, 'noAccount');
        expect(breakdownBody().textContent).not.toContain('segmenting the line');
        panel.setContext({ gloss: 'improvement' }, [{ text: '改善', lemma: '改善', gloss: 'improvement' }]);
        const text = breakdownBody().textContent ?? '';
        expect(text).toContain('improvement');
        expect(text).not.toContain('Sign in from savi settings');
    });
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
