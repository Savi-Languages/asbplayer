import { subtitleTokens } from './token-cache';
import { decorateTargetTokens, SaviTargetDecorator } from './target-decorator';
import { baseTextOf, baseRangeForSpan } from './gloss-hover';
import { rangeForCharSpan } from './hover-dict';

it('wraps the matched lemma surface while preserving the hover anchor and gaps', () => {
    const root = document.createElement('span');
    root.innerHTML = '<span>彼は </span>関与した。';
    const tokens = [{ text: '彼は ' }, { text: '関与した', lemma: '関与' }, { text: '。' }];
    decorateTargetTokens(root, tokens, new Set(['関与']));
    expect(root.textContent).toBe('彼は 関与した。');
    expect(root.querySelector('.savi-target')?.textContent).toBe('関与した');
    expect(rangeForCharSpan(root, 3, 7)?.toString()).toBe('関与した');
    decorateTargetTokens(root, tokens, new Set(['関与']));
    expect(root.querySelectorAll('.savi-target')).toHaveLength(1);
    decorateTargetTokens(root, tokens, new Set());
    expect(root.querySelector('.savi-target')).toBeNull();
});
it('preserves ruby gloss labels and decorates base text only, even across elements', () => {
    const root = document.createElement('span');
    root.innerHTML = 'la <ruby class="asb-gloss">ca<rt>house</rt></ruby><b>sa</b>';
    const original = root.textContent;
    decorateTargetTokens(root, [{ text: 'la ' }, { text: 'casa', lemma: 'casa' }], new Set(['casa']));
    expect(root.textContent).toBe(original);
    expect(baseTextOf(root)).toBe('la casa');
    expect(root.querySelector('rt')?.textContent).toBe('house');
    expect(root.querySelector('rt .savi-target')).toBeNull();
    expect([...root.querySelectorAll('.savi-target')].map((n) => n.textContent).join('')).toBe('casa');
    expect(baseRangeForSpan(root, 3, 5)?.toString()).toBe('ca');
});
it('rejects stale or non-reconciling tokenization rather than wrapping the wrong text', () => {
    const root = document.createElement('span');
    root.textContent = '別の字幕';
    decorateTargetTokens(root, [{ text: '関与', lemma: '関与' }], new Set(['関与']));
    expect(root.querySelector('.savi-target')).toBeNull();
    expect(root.textContent).toBe('別の字幕');
});

it('decorates only the primary track in ordinary and fullscreen containers', async () => {
    document.body.innerHTML =
        '<div class="asbplayer-subtitles"><div data-track="1"><span class="asbplayer-subtitle-text">関与</span></div><div data-track="0"><span class="asbplayer-subtitle-text">関与</span></div></div><div class="asbplayer-fullscreen-subtitles"><div data-track="0"><span class="asbplayer-subtitle-text">関与</span></div></div>';
    const mock = jest.spyOn(subtitleTokens, 'getRaw').mockResolvedValue([{ text: '関与', lemma: '関与' }]);
    const decorator = new SaviTargetDecorator(() => [{ text: '関与', track: 0 }]);
    decorator.setTargets('ja', ['関与']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelectorAll('[data-track="0"] .savi-target')).toHaveLength(2);
    expect(document.querySelector('[data-track="1"] .savi-target')).toBeNull();
    decorator.stop();
    mock.mockRestore();
    document.body.innerHTML = '';
});
