// A whole-line "breakdown" panel: lists every meaning unit of the hovered line
// with its reading + contextual meaning + grammatical role — the AI segmentation
// when available, else the rule-based tokens (no glosses). Opened from the hover
// popup's "Breakdown" button. Inline-styled + appended to document.body, mirroring
// the toast/popup so it carries no CSS dependency.

import { SaviToken } from './daemon-client';

export class SaviSegmentPanel {
    private _el: HTMLDivElement | null = null;
    private _list: HTMLDivElement | null = null;
    private _lineEl: HTMLDivElement | null = null;

    /** Show the panel for `line`, one row per non-whitespace chunk. */
    show(line: string, tokens: SaviToken[]) {
        const el = this._ensure();
        if (this._lineEl) {
            this._lineEl.textContent = line;
        }
        if (this._list) {
            this._list.replaceChildren();
            for (const t of tokens) {
                if (!t.text.trim()) {
                    continue; // skip whitespace gap tokens
                }
                const row = document.createElement('div');
                Object.assign(row.style, {
                    display: 'flex',
                    gap: '10px',
                    alignItems: 'baseline',
                    padding: '4px 0',
                    borderTop: '1px solid #222a35',
                });
                const surf = document.createElement('span');
                Object.assign(surf.style, { fontWeight: '650', minWidth: '72px', color: '#fff' });
                surf.textContent = t.reading && t.reading !== t.text ? `${t.text}（${t.reading}）` : t.text;
                const meaning = document.createElement('span');
                Object.assign(meaning.style, { flex: '1', color: '#d6dbe2' });
                const bits = [t.gloss, t.grammar].filter(Boolean) as string[];
                meaning.textContent = bits.length > 0 ? bits.join(' · ') : t.lemma && t.lemma !== t.text ? t.lemma : '';
                row.appendChild(surf);
                row.appendChild(meaning);
                this._list.appendChild(row);
            }
        }
        el.style.display = 'block';
    }

    hide() {
        if (this._el) {
            this._el.style.display = 'none';
        }
    }

    destroy() {
        this._el?.remove();
        this._el = null;
        this._list = null;
        this._lineEl = null;
    }

    private _ensure(): HTMLDivElement {
        if (this._el) {
            return this._el;
        }
        const el = document.createElement('div');
        el.className = 'savi-segment-panel';
        Object.assign(el.style, {
            position: 'fixed',
            left: '50%',
            top: '64px',
            transform: 'translateX(-50%)',
            zIndex: '2147483647',
            display: 'none',
            maxWidth: 'min(92vw, 680px)',
            maxHeight: '42vh',
            overflowY: 'auto',
            padding: '12px 14px',
            borderRadius: '12px',
            border: '1px solid #2a313c',
            background: 'rgba(20, 22, 28, 0.97)',
            color: '#fff',
            font: '400 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.55)',
            pointerEvents: 'auto',
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '8px',
        });
        const lineEl = document.createElement('div');
        Object.assign(lineEl.style, { fontSize: '15px', fontWeight: '650' });
        const close = document.createElement('button');
        close.textContent = '×';
        close.title = 'Close';
        Object.assign(close.style, {
            cursor: 'pointer',
            border: 'none',
            background: 'rgba(255,255,255,0.16)',
            color: '#fff',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            font: '700 16px/1 sans-serif',
            flex: '0 0 auto',
        });
        close.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hide();
        });
        header.appendChild(lineEl);
        header.appendChild(close);

        const list = document.createElement('div');
        el.appendChild(header);
        el.appendChild(list);
        document.body.appendChild(el);
        this._el = el;
        this._list = list;
        this._lineEl = lineEl;
        return el;
    }
}
