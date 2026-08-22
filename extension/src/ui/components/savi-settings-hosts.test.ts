import fs from 'fs';
import path from 'path';

// Every EXTENSION host that renders the settings UI must supply the site
// blacklist, because the Savi tab renders the section only when it is given
// one. The popup shipped without it while passing every other Savi prop —
// account email, target language, native language — so the tab looked complete
// and the blacklist was simply, silently absent. The version number even read
// correctly, which made it look like a stale build rather than missing wiring.
//
// This is a source-level check on purpose. Both hosts are React trees over a
// dozen extension-API hooks, and mocking all of that to assert one prop would
// test the mocks. The invariant is about WIRING, so it is asserted where the
// wiring lives.
//
// The web app (`common/app/components/SettingsDialog.tsx`) is deliberately NOT
// in this list: it has no browser.storage, cannot read or edit the list, and
// correctly renders nothing.
const EXTENSION_SETTINGS_HOSTS = ['Popup.tsx', 'SettingsPage.tsx'];

const REQUIRED_PROPS = ['saviMutedSites=', 'onSaviUnmuteSite='];

describe('extension hosts of the settings UI', () => {
    it.each(EXTENSION_SETTINGS_HOSTS)('%s supplies the site blacklist to SettingsForm', (host) => {
        const source = fs.readFileSync(path.join(__dirname, host), 'utf8');

        // Guard the guard: if the file stops rendering SettingsForm this test
        // is meaningless, and should say so rather than silently pass.
        expect(source).toContain('<SettingsForm');

        for (const prop of REQUIRED_PROPS) {
            expect(source).toContain(prop);
        }
    });
});
