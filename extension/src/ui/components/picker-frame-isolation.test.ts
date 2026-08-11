import { readFileSync } from 'fs';
import { join } from 'path';

// The subtitle picker renders inside a `srcdoc` iframe (services/ui-frame.ts:
// `frame.srcdoc = await html(lang)`). A srcdoc frame inherits the PARENT PAGE's
// origin, so it is a web context, not an extension one: `browser` /
// `chrome.runtime` are undefined there and touching them throws
// "Cannot read properties of undefined (reading 'sendMessage')".
//
// TypeScript cannot catch this. `browser` is declared as an ambient global for
// the whole extension, so every one of these files typechecks perfectly while
// being guaranteed to fail at runtime — which is exactly what happened in
// SV-44: the OpenSubtitles search compiled, shipped, and threw the moment
// somebody pressed Enter.
//
// Anything these components need from the extension has to travel over the
// picker bridge to the content script, which does have the APIs. This test is
// the guard, because a unit test of the components themselves would not catch
// it either — jsdom happily provides whatever global a mock defines.

const FILES_RENDERED_IN_THE_PICKER_FRAME = ['VideoDataSyncUi.tsx', 'OnlineSubtitleSourceDialog.tsx'];

/** Strip comments so prose ABOUT `browser.runtime` (like this file's own
 *  explanations) is not mistaken for a call to it. */
const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('components inside the picker srcdoc frame', () => {
    it.each(FILES_RENDERED_IN_THE_PICKER_FRAME)('%s never touches an extension-only global', (file) => {
        const source = stripComments(readFileSync(join(__dirname, file), 'utf8'));

        // `browser.storage`, `browser.runtime.sendMessage`, `chrome.runtime`, …
        // all undefined in a srcdoc frame.
        expect(source).not.toMatch(/\bbrowser\s*\./);
        expect(source).not.toMatch(/\bchrome\s*\./);
    });

    it('rejects the exact call that broke SV-44', () => {
        // Sanity: the matcher above actually fires on the offending pattern,
        // rather than passing because the regex never matches anything.
        const offending = stripComments(`
            const response = await browser.runtime.sendMessage(command);
        `);
        expect(offending).toMatch(/\bbrowser\s*\./);
    });

    it('does not flag a comment that merely mentions the global', () => {
        const commentary = stripComments(`
            // browser.runtime is undefined here — see the header.
            /* browser.storage too. */
            const x = 1;
        `);
        expect(commentary).not.toMatch(/\bbrowser\s*\./);
    });
});
