// Hides the streaming site's own (burned-in DOM) subtitle track while savi
// is active, so the only subtitles on screen are asbplayer's. This is
// independent of capture: a user may want asbplayer's subtitles to replace
// the site's even when nothing is being captured.
//
// The host → selector mapping is a pure function so it stays unit-testable
// and free of any DOM access. The injector is defensive: it never throws if
// the document has no <head> (e.g. very early in page load).

const STYLE_ELEMENT_ID = 'savi-hide-native-subs';

// Pure: maps a hostname to the CSS selector for that site's native subtitle
// container, or undefined when the site is unknown. Matching is suffix-based
// so locale/subdomain variants (e.g. www.netflix.com, music.youtube.com) are
// covered.
export function nativeSubtitleSelectorForHost(hostname: string): string | undefined {
    const host = (hostname ?? '').toLowerCase();

    if (host === 'netflix.com' || host.endsWith('.netflix.com')) {
        return '.player-timedtext';
    }

    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        return '.ytp-caption-window-container';
    }

    return undefined;
}

export class NativeSubtitleHider {
    constructor(private doc: Document = document) {}

    // Idempotently inject (or replace, if the selector changed) the hide
    // stylesheet. Safe to call repeatedly with the same selector — only one
    // <style id="savi-hide-native-subs"> ever exists.
    apply(selector: string) {
        const head = this.doc.head;

        if (!head) {
            return;
        }

        const css = `${selector} { display: none !important; }`;
        const existing = this.doc.getElementById(STYLE_ELEMENT_ID);

        if (existing) {
            if (existing.textContent !== css) {
                existing.textContent = css;
            }
            return;
        }

        const style = this.doc.createElement('style');
        style.id = STYLE_ELEMENT_ID;
        style.textContent = css;
        head.appendChild(style);
    }

    // Remove the hide stylesheet if present. No-op when it was never injected.
    clear() {
        const existing = this.doc.getElementById(STYLE_ELEMENT_ID);
        existing?.parentNode?.removeChild(existing);
    }
}
