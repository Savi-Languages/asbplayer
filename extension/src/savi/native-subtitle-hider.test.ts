import { NativeSubtitleHider, nativeSubtitleSelectorForHost } from './native-subtitle-hider';

describe('nativeSubtitleSelectorForHost', () => {
    it('maps netflix hosts to the timedtext container', () => {
        expect(nativeSubtitleSelectorForHost('netflix.com')).toBe('.player-timedtext');
        expect(nativeSubtitleSelectorForHost('www.netflix.com')).toBe('.player-timedtext');
    });

    it('maps youtube hosts to the caption window container', () => {
        expect(nativeSubtitleSelectorForHost('youtube.com')).toBe('.ytp-caption-window-container');
        expect(nativeSubtitleSelectorForHost('www.youtube.com')).toBe('.ytp-caption-window-container');
        expect(nativeSubtitleSelectorForHost('music.youtube.com')).toBe('.ytp-caption-window-container');
    });

    it('returns undefined for unknown hosts', () => {
        expect(nativeSubtitleSelectorForHost('example.com')).toBeUndefined();
        expect(nativeSubtitleSelectorForHost('notnetflix.com.evil.com')).toBeUndefined();
        expect(nativeSubtitleSelectorForHost('')).toBeUndefined();
    });
});

describe('NativeSubtitleHider', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });

    it('apply injects a <style> with the selector and display:none', () => {
        const hider = new NativeSubtitleHider(document);
        hider.apply('.player-timedtext');

        const style = document.getElementById('savi-hide-native-subs');
        expect(style).not.toBeNull();
        expect(style!.tagName.toLowerCase()).toBe('style');
        expect(style!.textContent).toContain('.player-timedtext');
        expect(style!.textContent).toContain('display: none !important');
    });

    it('apply twice does not duplicate the style element', () => {
        const hider = new NativeSubtitleHider(document);
        hider.apply('.player-timedtext');
        hider.apply('.player-timedtext');

        expect(document.querySelectorAll('#savi-hide-native-subs').length).toBe(1);
    });

    it('apply with a new selector replaces the existing style contents', () => {
        const hider = new NativeSubtitleHider(document);
        hider.apply('.player-timedtext');
        hider.apply('.ytp-caption-window-container');

        const styles = document.querySelectorAll('#savi-hide-native-subs');
        expect(styles.length).toBe(1);
        expect(styles[0].textContent).toContain('.ytp-caption-window-container');
        expect(styles[0].textContent).not.toContain('.player-timedtext');
    });

    it('clear removes the injected style element', () => {
        const hider = new NativeSubtitleHider(document);
        hider.apply('.player-timedtext');
        hider.clear();

        expect(document.getElementById('savi-hide-native-subs')).toBeNull();
    });

    it('clear is a no-op when nothing was injected', () => {
        const hider = new NativeSubtitleHider(document);
        expect(() => hider.clear()).not.toThrow();
        expect(document.getElementById('savi-hide-native-subs')).toBeNull();
    });

    it('apply does not throw when the document has no head', () => {
        const headlessDoc = { head: null } as unknown as Document;
        const hider = new NativeSubtitleHider(headlessDoc);
        expect(() => hider.apply('.player-timedtext')).not.toThrow();
    });
});
