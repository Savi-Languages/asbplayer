import { SaviHoverDictionary, lookupTermFor, rangeForCharSpan, tokenAtOffset, tokenSpanAtOffset } from './hover-dict';
import { SaviToken } from './daemon-client';
import { SaviSegmentLineResponse } from './messages';

const tok = (text: string, lemma?: string): SaviToken => ({ text, lemma });

// 容疑(0-1) 者(2) は(3) 黙秘(4-5) を(6) — concatenates to 容疑者は黙秘を
const tokens = [tok('容疑', '容疑'), tok('者'), tok('は'), tok('黙秘', '黙秘'), tok('を')];

describe('tokenAtOffset', () => {
    it('finds the token whose range contains the offset', () => {
        expect(tokenAtOffset(tokens, 0)?.text).toBe('容疑');
        expect(tokenAtOffset(tokens, 1)?.text).toBe('容疑');
        expect(tokenAtOffset(tokens, 2)?.text).toBe('者');
        expect(tokenAtOffset(tokens, 3)?.text).toBe('は');
        expect(tokenAtOffset(tokens, 4)?.text).toBe('黙秘');
        expect(tokenAtOffset(tokens, 5)?.text).toBe('黙秘');
        expect(tokenAtOffset(tokens, 6)?.text).toBe('を');
    });

    it('returns null past the end', () => {
        expect(tokenAtOffset(tokens, 7)).toBeNull();
        expect(tokenAtOffset([], 0)).toBeNull();
    });

    it('carries the lemma only for content words (drives the lookup)', () => {
        expect(tokenAtOffset(tokens, 4)?.lemma).toBe('黙秘');
        expect(tokenAtOffset(tokens, 2)?.lemma).toBeUndefined();
    });
});

describe('tokenSpanAtOffset', () => {
    it('returns the token plus its [start, end) span (drives the highlight box)', () => {
        expect(tokenSpanAtOffset(tokens, 0)).toEqual({ token: tokens[0], start: 0, end: 2 });
        expect(tokenSpanAtOffset(tokens, 1)).toEqual({ token: tokens[0], start: 0, end: 2 });
        expect(tokenSpanAtOffset(tokens, 2)).toEqual({ token: tokens[1], start: 2, end: 3 });
        expect(tokenSpanAtOffset(tokens, 4)).toEqual({ token: tokens[3], start: 4, end: 6 });
        expect(tokenSpanAtOffset(tokens, 6)).toEqual({ token: tokens[4], start: 6, end: 7 });
    });

    it('returns null past the end', () => {
        expect(tokenSpanAtOffset(tokens, 7)).toBeNull();
        expect(tokenSpanAtOffset([], 0)).toBeNull();
    });

    it('aligns across a gap (space) token so post-space words map correctly', () => {
        // 思う(0-1) [space](2) です(3-4) — the daemon's gap token keeps offsets honest.
        const withGap = [tok('思う', '思う'), tok(' '), tok('です')];
        expect(tokenSpanAtOffset(withGap, 0)).toEqual({ token: withGap[0], start: 0, end: 2 });
        expect(tokenSpanAtOffset(withGap, 2)).toEqual({ token: withGap[1], start: 2, end: 3 });
        expect(tokenSpanAtOffset(withGap, 3)).toEqual({ token: withGap[2], start: 3, end: 5 });
    });
});

describe('lookupTermFor', () => {
    it('uses the lemma to un-inflect verbs/adjectives', () => {
        expect(lookupTermFor(tok('続け', '続ける'))).toBe('続ける');
        expect(lookupTermFor(tok('国立', '国立'))).toBe('国立');
    });

    it('falls back to the surface for words with no lemma (the しかし bug)', () => {
        // Conjunctions/pronouns/proper nouns are not "reportable", so they
        // carry no lemma — but they ARE in the dictionary. Look up the surface.
        expect(lookupTermFor(tok('しかし'))).toBe('しかし');
        expect(lookupTermFor(tok('そこ'))).toBe('そこ');
        expect(lookupTermFor(tok('東京'))).toBe('東京');
    });
});

describe('rangeForCharSpan', () => {
    it('maps a char span to a Range, walking across nested text nodes', () => {
        document.body.innerHTML = '<span class="line"><span>変形</span>性関節症</span>';
        const root = document.querySelector('.line') as HTMLElement;
        expect(rangeForCharSpan(root, 0, 2)?.toString()).toBe('変形');
        expect(rangeForCharSpan(root, 2, 6)?.toString()).toBe('性関節症');
        expect(rangeForCharSpan(root, 4, 6)?.toString()).toBe('節症');
        // A single character mid-line.
        expect(rangeForCharSpan(root, 3, 4)?.toString()).toBe('関');
    });

    it('returns null when the span runs past the available text', () => {
        document.body.innerHTML = '<span class="line">あい</span>';
        const root = document.querySelector('.line') as HTMLElement;
        expect(rangeForCharSpan(root, 0, 5)).toBeNull();
    });
});

describe('SaviHoverDictionary._segment — the reason travels, the fallback is not cached', () => {
    // The content script's segment call sits between the background (which
    // knows WHY segmentation fell back to rule-based) and the tap panel (which
    // says so). It used to collapse the response to `SaviToken[] | null` — the
    // reason died here and the panel could only print "unavailable". It also
    // cached the null, so a fallback outlived its cause: sign in, retap the
    // same line, still told to sign in. The background is faked at the
    // browser.runtime seam, the way hover-dict actually reaches it.
    let responses: SaviSegmentLineResponse[];
    let sent: unknown[];

    beforeEach(() => {
        responses = [];
        sent = [];
        (globalThis as any).browser = {
            runtime: {
                sendMessage: async (command: unknown) => {
                    sent.push(command);
                    const next = responses.shift();
                    if (!next) throw new Error('unexpected savi-segment-line call');
                    return next;
                },
            },
        };
    });

    afterEach(() => {
        delete (globalThis as any).browser;
    });

    const segment = (dict: SaviHoverDictionary, text: string) =>
        (dict as any)._segment(text) as Promise<{ tokens: SaviToken[] | null; unavailable?: string }>;

    it('passes the background reason through with a null result on ai:false', async () => {
        const dict = new SaviHoverDictionary();
        responses.push({ ai: false, tokens: [tok('改善', '改善'), tok('を')], unavailable: 'accountMismatch' });
        const res = await segment(dict, '改善を');
        // The rule-based tokens the daemon returned are NOT the AI breakdown —
        // the caller keeps its own rule-based render, so tokens is null and the
        // reason rides beside it.
        expect(res).toEqual({ tokens: null, unavailable: 'accountMismatch' });
        expect(sent).toHaveLength(1);
        expect((sent[0] as any).message.command).toBe('savi-segment-line');
    });

    it('does NOT cache the fallback — the retap after signing in gets the real split', async () => {
        const dict = new SaviHoverDictionary();
        responses.push({ ai: false, tokens: [], unavailable: 'noAccount' });
        expect(await segment(dict, '改善を')).toEqual({ tokens: null, unavailable: 'noAccount' });
        // Now the user has signed in and taps the same line again.
        const aiTokens = [{ ...tok('改善', '改善'), gloss: 'improvement', grammar: 'noun' }, tok('を')];
        responses.push({ ai: true, tokens: aiTokens });
        expect(await segment(dict, '改善を')).toEqual({ tokens: aiTokens });
        expect(sent).toHaveLength(2); // asked again — the null was never remembered
    });

    it('DOES cache a success — a second tap on the line asks nothing', async () => {
        const dict = new SaviHoverDictionary();
        const aiTokens = [{ ...tok('改善', '改善'), gloss: 'improvement' }, tok('を')];
        responses.push({ ai: true, tokens: aiTokens });
        expect(await segment(dict, '改善を')).toEqual({ tokens: aiTokens });
        expect(await segment(dict, '改善を')).toEqual({ tokens: aiTokens });
        expect(sent).toHaveLength(1);
    });

    it('treats ai:true with no tokens as a fallback too, with whatever reason came along', async () => {
        // Defensive: an "AI" answer that segments into nothing is not a
        // breakdown the panel can draw. Not cached either.
        const dict = new SaviHoverDictionary();
        responses.push({ ai: true, tokens: [] });
        expect(await segment(dict, '改善を')).toEqual({ tokens: null, unavailable: undefined });
        responses.push({ ai: true, tokens: [tok('改善', '改善')] });
        expect((await segment(dict, '改善を')).tokens).toHaveLength(1);
        expect(sent).toHaveLength(2);
    });
});

describe('hover overlays follow subtitle layout without mouse movement', () => {
    let dict: any;
    let line: HTMLElement;
    let rect: DOMRect;
    let frames: Map<number, FrameRequestCallback>;
    let frameId: number;
    const makeRect = (x: number, y: number, width: number, height: number) =>
        ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }) as DOMRect;
    const result = { entries: [], kanji: [{ kanji: '裏', keyword: 'back' }] };
    const frame = () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(0));
    };
    const show = (offset = 0) =>
        dict._applyTokens(
            line,
            line.textContent,
            offset,
            210,
            410,
            [
                { text: '裏工作', lemma: '裏工作' },
                { text: '裏工作', lemma: '裏工作' },
            ],
            dict._generation
        );
    const surface = (name: string) => document.querySelector(`.savi-dict-${name}`) as HTMLElement;

    beforeEach(() => {
        document.body.innerHTML = '<span>裏工作裏工作</span>';
        line = document.querySelector('span')!;
        rect = makeRect(200, 400, 120, 40);
        frames = new Map();
        frameId = 0;
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
            frames.set(++frameId, cb);
            return frameId;
        });
        jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
            frames.delete(id);
        });
        // jsdom has no layout; keep real DOM ranges and supply measured geometry.
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: () => rect,
        });
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return makeRect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0, 300, 180);
        });
        dict = new SaviHoverDictionary();
        dict.start();
        jest.spyOn(dict, '_lookupDict').mockResolvedValue(result);
    });
    afterEach(() => {
        dict.stop();
        jest.restoreAllMocks();
        delete (Range.prototype as any).getBoundingClientRect;
        document.body.innerHTML = '';
    });

    it('renders a prepared word during the mouse event, without timers or pending promises', () => {
        line.className = 'asbplayer-subtitle-text';
        const caret = document.createRange();
        caret.setStart(line.firstChild!, 0);
        Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: () => caret });
        jest.spyOn(dict, '_tokenize').mockReturnValue([{ text: '裏工作裏工作', lemma: '裏工作' }]);
        dict._lookupDict.mockReturnValue(result);
        try {
            line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 210, clientY: 410 }));
            expect(surface('popup')?.style.display).toBe('block');
            expect(surface('popup')?.textContent).toContain('裏工作');
        } finally {
            delete (document as any).caretRangeFromPoint;
        }
    });

    it('moves the outline, popup and bridge with controls hiding and showing', async () => {
        await show();
        const initial = ['highlight', 'popup', 'bridge'].map((name) => parseFloat(surface(name).style.top));
        rect = makeRect(200, 500, 120, 40);
        frame();
        ['highlight', 'popup', 'bridge'].forEach((name, i) =>
            expect(parseFloat(surface(name).style.top)).toBe(initial[i] + 100)
        );
        rect = makeRect(200, 400, 120, 40);
        frame();
        ['highlight', 'popup', 'bridge'].forEach((name, i) =>
            expect(parseFloat(surface(name).style.top)).toBe(initial[i])
        );
        expect(dict._lookupDict).toHaveBeenCalledTimes(1);
    });

    it('measures again when a delayed dictionary response arrives', async () => {
        let resolve!: (value: typeof result) => void;
        dict._lookupDict.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            })
        );
        const pending = show();
        rect = makeRect(200, 500, 120, 40);
        frame();
        resolve(result);
        await pending;
        expect(parseFloat(surface('popup').style.top)).toBe(500 - 180 - 12 - 7);
    });

    it('reanchors the same dictionary term at a different position', async () => {
        await show();
        rect = makeRect(350, 400, 120, 40);
        await show(3);
        frame();
        expect(parseFloat(surface('popup').style.left)).toBe(350 + 60 - 150);
        expect(dict._lookupDict).toHaveBeenCalledTimes(1);
    });

    it.each(['removed', 'replaced', 'hidden'])('clears overlays when the cue is %s', async (change) => {
        await show();
        if (change === 'removed') line.remove();
        if (change === 'replaced') line.textContent = '別の字幕です';
        if (change === 'hidden') rect = makeRect(0, 0, 0, 0);
        frame();
        ['highlight', 'popup', 'bridge'].forEach((name) => expect(surface(name).style.display).toBe('none'));
        expect(frames.size).toBe(0);
    });

    it('cancels tracking on stop', async () => {
        await show();
        expect(frames.size).toBe(1);
        dict.stop();
        expect(frames.size).toBe(0);
    });
});

describe('hover dictionary preparation', () => {
    let dict: any;
    let send: jest.Mock;
    const response = { entries: [], kanji: [{ kanji: '猫', keyword: 'cat', components: [] }] };
    beforeEach(() => {
        send = jest.fn().mockResolvedValue(response);
        (globalThis as any).browser = { runtime: { sendMessage: send } };
        dict = new SaviHoverDictionary();
    });
    afterEach(() => {
        dict.stop();
        jest.restoreAllMocks();
        delete (globalThis as any).browser;
    });
    it('shares an outstanding dictionary request and serves its result synchronously', async () => {
        const first = dict._lookupDict('猫');
        const second = dict._lookupDict('猫');
        expect(send).toHaveBeenCalledTimes(1);
        expect(await first).toEqual(await second);
        expect(dict._lookupDict('猫')).toEqual(response);
    });
    it('retries an empty dictionary response after its short expiry', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1000);
        send.mockResolvedValueOnce({ entries: [], kanji: [] });
        await dict._lookupDict('猫');
        (Date.now as jest.Mock).mockReturnValue(7000);
        expect(await dict._lookupDict('猫')).toEqual(response);
        expect(send).toHaveBeenCalledTimes(2);
    });
    it('prepares only the current and near next primary cues, without showing a popup', async () => {
        const video = document.createElement('video');
        video.currentTime = 10;
        const cues = [
            { text: '猫', track: 0, start: 9000, end: 11000 },
            { text: '犬', track: 0, start: 12000, end: 13000 },
            { text: '鳥', track: 0, start: 14000, end: 15000 },
            { text: '魚', track: 0, start: 9000, end: 11000 },
            { text: '英語', track: 1, start: 9000, end: 11000 },
            { text: '昔', track: 0, start: 0, end: 1000 },
        ];
        dict = new SaviHoverDictionary(
            () => video,
            () => cues
        );
        const tokenize = jest.spyOn(dict, '_tokenize').mockImplementation((text: any) => [{ text }]);
        // Start the lifecycle manually so the test can await the actual prefetch.
        dict._bound = true;
        await dict._prefetch();
        expect(tokenize.mock.calls.map((args) => args[0])).toEqual(['猫', '魚']);
        expect(send.mock.calls.map((args) => args[0].message.term)).toEqual(['猫', '魚']);
        expect(document.querySelector('.savi-dict-popup')).toBeNull();
        dict.stop();
        await dict._prefetch();
        expect(send).toHaveBeenCalledTimes(2);
    });
    it('does not start more preparation requests after stopping', async () => {
        let finish!: (tokens: any[]) => void;
        const video = document.createElement('video');
        dict = new SaviHoverDictionary(
            () => video,
            () => [{ text: '猫', track: 0, start: 0, end: 1000 }]
        );
        jest.spyOn(dict, '_tokenize').mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        dict._bound = true;
        const preparing = dict._prefetch();
        dict.stop();
        finish([{ text: '猫' }]);
        await preparing;
        expect(send).not.toHaveBeenCalled();
    });
});
