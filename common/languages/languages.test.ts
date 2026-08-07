import { languageLabel, languageOptions, resolveLanguageInput, SUBTITLE_LANGUAGE_CODES } from './languages';

describe('languageLabel', () => {
    it('names a language and keeps its tag visible', () => {
        expect(languageLabel('ja')).toBe('Japanese (ja)');
        expect(languageLabel('en')).toBe('English (en)');
    });

    it('names regional variants distinctly', () => {
        // The whole reason these are separate options: they must not read as
        // two identical "Spanish" / "Portuguese" rows.
        expect(languageLabel('es-419')).not.toBe(languageLabel('es-ES'));
        expect(languageLabel('pt-BR')).not.toBe(languageLabel('pt'));
    });

    it('falls back to the tag for something it cannot name', () => {
        expect(languageLabel('zz-QQ')).toBe('zz-QQ');
    });

    it('returns empty for an empty value', () => {
        // Empty means "off" for the native line — it must not render as a name.
        expect(languageLabel('')).toBe('');
        expect(languageLabel('   ')).toBe('');
    });

    it('trims and tolerates junk without throwing', () => {
        expect(() => languageLabel('!!!')).not.toThrow();
        expect(languageLabel(undefined as unknown as string)).toBe('');
    });
});

describe('languageOptions', () => {
    it('offers the curated list when nothing is set', () => {
        expect(languageOptions()).toEqual([...SUBTITLE_LANGUAGE_CODES]);
        expect(languageOptions('')).toEqual([...SUBTITLE_LANGUAGE_CODES]);
    });

    it('keeps a stored tag that predates the list selectable', () => {
        // A value set on another device (or by hand) must not look unset.
        const options = languageOptions('haw');
        expect(options[0]).toBe('haw');
        expect(options).toHaveLength(SUBTITLE_LANGUAGE_CODES.length + 1);
    });

    it('does not duplicate a value already in the list', () => {
        expect(languageOptions('ja')).toHaveLength(SUBTITLE_LANGUAGE_CODES.length);
        expect(languageOptions('JA')).toHaveLength(SUBTITLE_LANGUAGE_CODES.length);
    });

    it('has no duplicates and covers the dogfooding languages', () => {
        expect(new Set(SUBTITLE_LANGUAGE_CODES).size).toBe(SUBTITLE_LANGUAGE_CODES.length);
        // Spanish (Leon) and Japanese (Khalifa), plus the native line's default case.
        ['es', 'ja', 'en', 'fr', 'zh-Hans'].forEach((code) => {
            expect(SUBTITLE_LANGUAGE_CODES).toContain(code);
        });
    });

    it('every option renders a label', () => {
        SUBTITLE_LANGUAGE_CODES.forEach((code) => {
            expect(languageLabel(code).length).toBeGreaterThan(0);
        });
    });
});

describe('resolveLanguageInput', () => {
    it('round-trips the label the picker renders', () => {
        // The field shows names but the setting stores tags; every commit goes
        // through here, so this is the path that must not lose the tag.
        expect(resolveLanguageInput('Japanese (ja)')).toBe('ja');
        expect(resolveLanguageInput(languageLabel('es-419'))).toBe('es-419');
    });

    it('accepts a bare tag typed by someone who knows it', () => {
        expect(resolveLanguageInput('ja')).toBe('ja');
        expect(resolveLanguageInput('ES-419')).toBe('es-419');
    });

    it('accepts a language name without its tag', () => {
        expect(resolveLanguageInput('Japanese')).toBe('ja');
        expect(resolveLanguageInput('brazilian portuguese')).toBe('pt-BR');
    });

    it('passes through an unknown tag rather than discarding it', () => {
        // freeSolo escape hatch: a tag this list omits must still be settable.
        expect(resolveLanguageInput('haw')).toBe('haw');
        expect(resolveLanguageInput('  yue-Hant  ')).toBe('yue-Hant');
    });

    it('maps empty to empty, which is how the native line is turned off', () => {
        expect(resolveLanguageInput('')).toBe('');
        expect(resolveLanguageInput('   ')).toBe('');
        expect(resolveLanguageInput(undefined as unknown as string)).toBe('');
    });

    it('never returns a display label as the stored value', () => {
        SUBTITLE_LANGUAGE_CODES.forEach((code) => {
            const resolved = resolveLanguageInput(languageLabel(code));
            expect(resolved).toBe(code);
            expect(resolved).not.toContain('(');
        });
    });
});
