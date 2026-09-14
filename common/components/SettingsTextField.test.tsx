/** @jest-environment node */
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsTextField from './SettingsTextField';

it('associates the visible setting label with its input', () => {
    const html = renderToStaticMarkup(<SettingsTextField id="account-email" label="Account email" />);
    expect(html).toContain('for="account-email"');
    expect(html).toContain('id="account-email"');
});
