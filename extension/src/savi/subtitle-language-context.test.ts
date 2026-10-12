import { SubtitleLanguageContext } from './subtitle-language-context';

const ja = ['Show - Japanese.nfimsc'];
const en = ['Show - English.nfimsc'];
const url = 'https://www.netflix.com/watch/80204509?trackId=123';

describe('subtitle language stays with the loaded files', () => {
    it('survives Netflix tracking-query changes but not an episode change', () => {
        const context = new SubtitleLanguageContext();
        context.begin('ja', ja, url, 'Show');
        context.commit(ja);
        expect(context.language(ja, 'https://www.netflix.com/watch/80204509', 'Show')).toBe('ja');
        expect(context.language(ja, 'https://www.netflix.com/watch/80204510', 'Show')).toBeUndefined();
    });
    it('keeps the old language while new files are loading and then commits the new language', () => {
        const context = new SubtitleLanguageContext();
        context.begin('ja', ja, url, 'Show');
        context.commit(ja);
        context.begin('en', en, url, 'Show');
        expect(context.language(ja, url, 'Show')).toBe('ja');
        context.commit(en);
        expect(context.language(en, url, 'Show')).toBe('en');
        expect(context.language(ja, url, 'Show')).toBeUndefined();
    });
    it('preserves metadata on a repeated app response and clears it for a manual file load', () => {
        const context = new SubtitleLanguageContext();
        context.begin('ja', ja, url, 'Show');
        context.commit(ja);
        context.commit(ja);
        expect(context.language(ja, url, 'Show')).toBe('ja');
        context.begin(undefined, ja, url, 'Show');
        context.commit(ja);
        expect(context.language(ja, url, 'Show')).toBeUndefined();
    });
    it('requires the whole ordered track list, including the native line', () => {
        const context = new SubtitleLanguageContext();
        context.begin('ja', [...ja, ...en], url, 'Show');
        context.commit([...ja, ...en]);
        expect(context.language([...ja, ...en], url, 'Show')).toBe('ja');
        expect(context.language([...en, ...ja], url, 'Show')).toBeUndefined();
        context.commit(['manual.srt']);
        expect(context.language(['manual.srt'], url, 'Show')).toBeUndefined();
    });
    it('does not let an older load consume the newer pending language', () => {
        const context = new SubtitleLanguageContext();
        context.begin('ja', ja, url, 'Show');
        context.begin('en', en, url, 'Show');
        context.commit(ja);
        context.commit(en);
        expect(context.language(en, url, 'Show')).toBe('en');
    });

    it('does not retain language for an empty load', () => {
        const context = new SubtitleLanguageContext();
        context.begin('ja', [], url, 'Show');
        context.commit([]);
        expect(context.language([], url, 'Show')).toBeUndefined();
    });
});
