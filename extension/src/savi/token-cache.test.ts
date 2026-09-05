import { SharedTokenCache } from './token-cache';

it('shares in-flight tokens between hover and decoration, with language-specific keys', async () => {
    let resolve!: (tokens: any[]) => void;
    const fetch = jest.fn(
        () =>
            new Promise<any[]>((r) => {
                resolve = r;
            })
    );
    const cache = new SharedTokenCache(fetch, 2);
    const hover = cache.get('ja', '猫');
    const decoration = cache.get('ja', '猫');
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve([{ text: '猫', lemma: '猫' }]);
    expect(await hover).toEqual(await decoration);
    expect(await cache.get('ja', '猫')).toEqual([{ text: '猫', lemma: '猫' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const other = cache.get('zh', '猫');
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve([{ text: '猫', lemma: '猫' }]);
    await other;
});
it('does not cache failures or mismatched surfaces; evicts old entries', async () => {
    const fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce([{ text: 'wrong' }])
        .mockImplementation(async (_lang, text) => [{ text }]);
    const cache = new SharedTokenCache(fetch, 1);
    await expect(cache.get('es', 'gato')).rejects.toThrow('offline');
    await expect(cache.get('es', 'gato')).rejects.toThrow('surface');
    await cache.get('es', 'gato');
    await cache.get('es', 'casa');
    await cache.get('es', 'gato');
    expect(fetch).toHaveBeenCalledTimes(5);
});

it('shares one request while preserving raw target lemmas and merged hover compounds', async () => {
    const fetch = jest.fn().mockResolvedValue({
        tokens: [{ text: '理事長', lemma: '理事長' }],
        rawTokens: [
            { text: '理事', lemma: '理事' },
            { text: '長', lemma: '長' },
        ],
    });
    const cache = new SharedTokenCache(fetch);
    const [hover, targets] = await Promise.all([cache.get('ja', '理事長'), cache.getRaw('ja', '理事長')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hover).toHaveLength(1);
    expect(targets.map((t) => t.lemma)).toEqual(['理事', '長']);
});
