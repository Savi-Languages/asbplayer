// Run against a production build in a disposable profile. No personal browser
// state or signed-in account is used. PLAYWRIGHT_MODULE/CHROMIUM_PATH allow a
// host-provided browser runtime without adding it to the extension bundle.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
    const root = path.resolve(__dirname, '..');
    const extensionPath = path.join(root, 'extension/.output/chrome-mv3');
    const output = path.join(root, 'docs/design/screenshots');
    fs.mkdirSync(output, { recursive: true });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'savi-ui-qa-'));
    const context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.CHROMIUM_PATH,
        headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
        viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    try {
        const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
        const id = worker.url().split('/')[2];
        const url = (name, hash = '') => `chrome-extension://${id}/${name}.html${hash}`;
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(url('popup-ui'));
        // Simulate an upgrade with old upstream localization already cached.
        await page.evaluate(() =>
            chrome.storage.local.set({
                'locStrings-en': { about: { title: 'About asbplayer' } },
                pauseOnHoverMode: 1,
                themeType: 'dark',
            })
        );
        await page.reload();
        await page.getByRole('heading', { name: 'Stay with the story.' }).waitFor();
        assert(!(await page.locator('body').innerText()).includes('saviUi.'));
        const pause = page.getByRole('checkbox', { name: 'Pause on subtitle hover' });
        assert(await pause.isChecked());
        await pause.uncheck();
        await page.waitForFunction(
            async () => (await chrome.storage.local.get('pauseOnHoverMode')).pauseOnHoverMode === 0
        );
        await page.reload();
        assert(!(await page.getByRole('checkbox', { name: 'Pause on subtitle hover' }).isChecked()));
        await page.getByRole('checkbox', { name: 'Pause on subtitle hover' }).check();
        await page.screenshot({ path: path.join(output, 'popup.png'), clip: { x: 0, y: 0, width: 380, height: 600 } });
        const optionsPromise = context.waitForEvent('page');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const options = await optionsPromise;
        options.on('pageerror', (error) => errors.push(error.message));
        await options.waitForURL(/options.html#savi-settings/);
        await options.getByRole('heading', { name: 'Make Savi feel like you.' }).waitFor();
        assert.equal(
            await options.getByRole('tab', { name: 'Account & languages' }).getAttribute('aria-selected'),
            'true'
        );
        await options.getByLabel('Savi account email', { exact: true }).fill('');
        assert(await options.getByText('Sites Savi is switched off for', { exact: true }).isVisible());
        assert(!(await options.getByLabel('Savi daemon URL', { exact: true }).isVisible()));
        await options.screenshot({ path: path.join(output, 'settings.png') });
        // Every category remains reachable; active panels retain accessible linkage.
        for (const tab of await options.getByRole('tab').all()) {
            await tab.click();
            assert.equal(await tab.getAttribute('aria-selected'), 'true');
            const controls = await tab.getAttribute('aria-controls');
            assert(await options.locator(`[id="${controls}"]`).isVisible());
        }
        await options.getByRole('tab', { name: 'Account & languages' }).click();
        await options.getByRole('tab', { name: 'Account & languages' }).press('ArrowDown');
        assert.equal(
            await options
                .getByRole('tab', { name: 'Subtitle Appearance', exact: true })
                .evaluate((el) => el === document.activeElement),
            true
        );
        await options.goto(url('options', '#keyboard-shortcuts'));
        await options.getByRole('tab', { name: 'Keyboard Shortcuts', exact: true }).waitFor();
        await options.waitForFunction(
            () => document.querySelector('#keyboard-shortcuts')?.getAttribute('aria-selected') === 'true'
        );
        await options.goto(url('options', '#savi-settings'));
        await options.getByText('Advanced connections', { exact: true }).click();
        assert(await options.getByLabel('Savi daemon URL', { exact: true }).isVisible());
        await options.getByText('Advanced connections', { exact: true }).click();
        await options.setViewportSize({ width: 390, height: 844 });
        await options.evaluate(() => window.scrollTo(0, 0));
        assert(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await options.screenshot({ path: path.join(output, 'settings-narrow.png') });
        await options.evaluate(() => chrome.storage.local.set({ themeType: 'light' }));
        await options.setViewportSize({ width: 1280, height: 900 });
        await options.reload();
        await options.getByRole('heading', { name: 'Make Savi feel like you.' }).waitFor();
        await options.screenshot({ path: path.join(output, 'settings-light.png') });
        await options.evaluate(() => chrome.storage.local.set({ themeType: 'dark' }));
        await page.goto(url('sidepanel'));
        await page.setViewportSize({ width: 380, height: 900 });
        await page.getByRole('heading', { name: 'Start with a story.' }).waitFor();
        assert(await page.getByRole('button', { name: 'Load Subtitles', exact: true }).isDisabled());
        await page.screenshot({ path: path.join(output, 'study-panel.png') });
        await page.getByRole('button', { name: /Saved cards/ }).click();
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.goto(url('ftue-ui'));
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.getByRole('heading', { name: 'A little closer to the language.' }).waitFor();
        await page.screenshot({ path: path.join(output, 'welcome.png') });
        assert.equal(await page.getByRole('button', { name: 'Set up Savi' }).count(), 1);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log(
            'PASS: stale locale cache, popup preference persistence, settings navigation, all categories, deep links, keyboard navigation, advanced disclosure, narrow/light layouts, empty study panel, saved cards, onboarding; no page errors.'
        );
    } finally {
        await context.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
