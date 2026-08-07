// The language choices offered in savi's target/native language pickers.
//
// These settings are BCP-47 tags because that is what streaming sites label
// their subtitle tracks with, and matching happens on the primary subtag. But a
// tag is a terrible thing to ask someone to type from memory, so the UI offers
// this list with real language names and keeps the tag as the stored value.
//
// The list is deliberately NOT exhaustive — it covers what streaming services
// actually ship subtitles in. Anything missing is still reachable: the picker
// accepts a typed tag, so an unusual or regional variant keeps working. That is
// also why nothing here may be treated as the set of *valid* values; it is a
// convenience list, not a validation whitelist.

/** Regional variants worth offering separately, because learners genuinely pick
 *  between them (Latin-American vs European Spanish, Brazilian vs European
 *  Portuguese, Simplified vs Traditional Chinese). */
export const SUBTITLE_LANGUAGE_CODES: readonly string[] = [
    'ar',
    'bn',
    'bg',
    'my',
    'ca',
    'zh-Hans',
    'zh-Hant',
    'hr',
    'cs',
    'da',
    'nl',
    'en',
    'en-GB',
    'et',
    'fil',
    'fi',
    'fr',
    'fr-CA',
    'de',
    'el',
    'gu',
    'he',
    'hi',
    'hu',
    'is',
    'id',
    'it',
    'ja',
    'kn',
    'kk',
    'km',
    'ko',
    'lo',
    'lv',
    'lt',
    'ms',
    'ml',
    'mr',
    'mn',
    'ne',
    'no',
    'fa',
    'pl',
    'pt',
    'pt-BR',
    'pa',
    'ro',
    'ru',
    'sr',
    'si',
    'sk',
    'sl',
    'es',
    'es-419',
    'es-ES',
    'sw',
    'sv',
    'ta',
    'te',
    'th',
    'tr',
    'uk',
    'ur',
    'uz',
    'vi',
];

/**
 * A human label for a BCP-47 tag — `ja` → `Japanese (ja)`.
 *
 * The tag stays visible because it is what subtitle tracks are labelled with
 * and what the setting actually stores; someone comparing the picker against a
 * player's track list should be able to see they match.
 *
 * Unknown or malformed tags fall back to the tag itself rather than throwing,
 * so a value typed by hand (or set on another device) always renders.
 */
export const languageLabel = (code: string, uiLocale?: string): string => {
    const tag = (code ?? '').trim();

    if (tag.length === 0) {
        return '';
    }

    try {
        // `fallback: 'none'` returns undefined for a tag it has no data for.
        // Without it, `of('zz-QQ')` synthesizes "zz (QQ)" — a fake name that
        // would render as `zz (QQ) (zz-QQ)` and read like a real language.
        const names = new Intl.DisplayNames([uiLocale || 'en'], { type: 'language', fallback: 'none' });
        const name = names.of(tag);
        return name && name.toLowerCase() !== tag.toLowerCase() ? `${name} (${tag})` : tag;
    } catch (e) {
        // Intl.DisplayNames is ES2021; on a webview that lacks it the tag alone
        // is still a usable label.
        return tag;
    }
};

/**
 * The picker's options: the curated list, plus `current` when it isn't already
 * in it.
 *
 * Including the current value matters — a stored tag that predates this list
 * (or came from another device) must remain selectable rather than silently
 * appearing to be unset.
 */
export const languageOptions = (current?: string): string[] => {
    const options = [...SUBTITLE_LANGUAGE_CODES];
    const tag = (current ?? '').trim();

    if (tag.length > 0 && !options.some((o) => o.toLowerCase() === tag.toLowerCase())) {
        options.unshift(tag);
    }

    return options;
};
