import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useLocationHash } from './use-location-hash';

it('follows settings deep links when the hash changes without a page reload', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, '', '#savi-settings');
    const container = document.createElement('div');
    const root = createRoot(container);
    const Probe = () => <span>{useLocationHash().hash}</span>;
    try {
        await act(async () => root.render(<Probe />));
        expect(container.textContent).toBe('savi-settings');
        await act(async () => {
            window.history.replaceState(null, '', '#keyboard-shortcuts');
            window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        expect(container.textContent).toBe('keyboard-shortcuts');
    } finally {
        await act(async () => root.unmount());
    }
});
