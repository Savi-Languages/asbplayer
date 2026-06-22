// A tap-triggered word-study panel. Hover stays instant + purely rule-based;
// TAPPING a subtitle word opens this fuller view: the complete dictionary entry +
// kanji for the word, plus — fetched on demand — the AI in-context reading for
// THIS sentence and the whole-line breakdown. The slow, LLM-backed AI context
// lives HERE (behind a deliberate tap) so it can never delay or destabilize the
// hover popup. Inline-styled + appended to document.body, like the toast/popup.

import { SaviDictEntry, SaviKanjiInfo, SaviToken } from './daemon-client';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A tiny SMIL-animated spinner — no CSS/keyframes dependency, animates anywhere. */
function spinner(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.style.flex = '0 0 auto';
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', '12');
    track.setAttribute('cy', '12');
    track.setAttribute('r', '9');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'currentColor');
    track.setAttribute('stroke-width', '3');
    track.setAttribute('stroke-opacity', '0.25');
    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute('d', 'M12 3 a9 9 0 0 1 9 9');
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'currentColor');
    arc.setAttribute('stroke-width', '3');
    arc.setAttribute('stroke-linecap', 'round');
    const anim = document.createElementNS(SVG_NS, 'animateTransform');
    anim.setAttribute('attributeName', 'transform');
    anim.setAttribute('attributeType', 'XML');
    anim.setAttribute('type', 'rotate');
    anim.setAttribute('from', '0 12 12');
    anim.setAttribute('to', '360 12 12');
    anim.setAttribute('dur', '0.7s');
    anim.setAttribute('repeatCount', 'indefinite');
    arc.appendChild(anim);
    svg.appendChild(track);
    svg.appendChild(arc);
    return svg;
}

/** A small uppercase section heading. */
function sectionLabel(text: string, color = '#8a93a0'): HTMLDivElement {
    const el = document.createElement('div');
    Object.assign(el.style, {
        fontSize: '10.5px',
        fontWeight: '700',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color,
        margin: '10px 0 4px',
    });
    el.textContent = text;
    return el;
}

/** A spinner + italic "loading" line. */
function loadingRow(message: string): HTMLDivElement {
    const row = document.createElement('div');
    Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        color: '#93a0ad',
        fontStyle: 'italic',
        fontSize: '13px',
    });
    row.appendChild(spinner());
    const t = document.createElement('span');
    t.textContent = message;
    row.appendChild(t);
    return row;
}

export interface WordPanelInput {
    term: string;
    token: SaviToken;
    entries: SaviDictEntry[];
    kanji: SaviKanjiInfo[];
    onMine: (button: HTMLButtonElement) => void;
}

/** The tapped word's contextual reading, resolved from the AI segmentation. */
export interface WordContext {
    gloss?: string;
    grammar?: string;
}

export class SaviWordPanel {
    private _el: HTMLDivElement | null = null;
    private _scroll: HTMLDivElement | null = null;
    private _ctxBody: HTMLDivElement | null = null; // "in this sentence" — the tapped word's AI gloss
    private _breakdownBody: HTMLDivElement | null = null; // whole-line AI breakdown
    private _explainBody: HTMLDivElement | null = null; // the rich "explain like a sensei" note

    /** @param _onClose called when the user dismisses the panel (×) so the owner
     *  can resume the video it paused. */
    constructor(private readonly _onClose?: () => void) {}

    /** Render the word's rule-based details immediately; the AI sections show a
     *  spinner until `setContext` fills them. */
    show(input: WordPanelInput) {
        const el = this._ensure();
        const scroll = this._scroll!;
        scroll.replaceChildren();
        this._ctxBody = null;
        this._breakdownBody = null;
        this._explainBody = null;

        const head = document.createElement('div');
        Object.assign(head.style, { fontSize: '22px', fontWeight: '700', lineHeight: '1.25' });
        head.textContent = input.term;
        if (input.token.reading && input.token.reading !== input.term) {
            const r = document.createElement('span');
            Object.assign(r.style, { fontSize: '15px', color: '#4cc2ff', marginLeft: '10px', fontWeight: '400' });
            r.textContent = input.token.reading;
            head.appendChild(r);
        }
        scroll.appendChild(head);

        // Full dictionary entry (more generous than the hover popup).
        for (const entry of input.entries.slice(0, 3)) {
            const ol = document.createElement('ol');
            Object.assign(ol.style, {
                margin: '6px 0 4px',
                paddingLeft: '20px',
                fontSize: '14px',
                lineHeight: '1.5',
            });
            for (const sense of entry.senses.slice(0, 6)) {
                const li = document.createElement('li');
                li.textContent = sense.glosses.join('; ');
                ol.appendChild(li);
            }
            if (ol.childElementCount > 0) {
                scroll.appendChild(ol);
            }
        }

        // Kanji.
        if (input.kanji.length > 0) {
            scroll.appendChild(sectionLabel('漢字'));
            for (const k of input.kanji) {
                const row = document.createElement('div');
                Object.assign(row.style, { fontSize: '13.5px', lineHeight: '1.6' });
                const ch = document.createElement('span');
                Object.assign(ch.style, { color: '#ffd166', fontSize: '16px', marginRight: '8px' });
                ch.textContent = k.kanji;
                row.appendChild(ch);
                const kw = document.createElement('span');
                kw.textContent = k.keyword;
                row.appendChild(kw);
                if (k.components && k.components.length > 0) {
                    const comp = document.createElement('span');
                    Object.assign(comp.style, { color: '#8a93a0', marginLeft: '6px' });
                    comp.textContent = `(${k.components.join(', ')})`;
                    row.appendChild(comp);
                }
                scroll.appendChild(row);
            }
        }

        // AI in-context (this word, this sentence) — spinner until setContext.
        scroll.appendChild(sectionLabel('✦ In this sentence', '#74c79a'));
        const ctx = document.createElement('div');
        Object.assign(ctx.style, { margin: '0 0 4px', lineHeight: '1.5' });
        ctx.appendChild(loadingRow('reading the sentence…'));
        scroll.appendChild(ctx);
        this._ctxBody = ctx;

        // The detailed, professor-style teaching note — spinner until setExplanation.
        const explain = document.createElement('div');
        Object.assign(explain.style, { margin: '4px 0 6px', lineHeight: '1.65', fontSize: '13.5px', color: '#d6dbe2' });
        explain.appendChild(loadingRow('asking the sensei…'));
        scroll.appendChild(explain);
        this._explainBody = explain;

        // Whole-line breakdown — spinner until setContext.
        scroll.appendChild(sectionLabel('Sentence breakdown'));
        const bd = document.createElement('div');
        bd.appendChild(loadingRow('segmenting the line…'));
        scroll.appendChild(bd);
        this._breakdownBody = bd;

        const mine = document.createElement('button');
        mine.textContent = '+ Add to Anki';
        Object.assign(mine.style, {
            display: 'block',
            width: '100%',
            marginTop: '12px',
            padding: '10px',
            borderRadius: '9px',
            border: 'none',
            background: '#ffd45e',
            color: '#1a1a1a',
            fontSize: '14px',
            fontWeight: '700',
            cursor: 'pointer',
        });
        const trigger = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            input.onMine(mine);
        };
        mine.addEventListener('pointerdown', trigger);
        mine.addEventListener('click', trigger);
        scroll.appendChild(mine);

        el.style.display = 'flex';
        scroll.scrollTop = 0;
    }

    /** Fill the detailed teaching note (the professor-style in-context explanation).
     *  null ⇒ no provider / all fail — show a graceful note; the dictionary stands. */
    setExplanation(text: string | null) {
        if (!this._explainBody) {
            return;
        }
        this._explainBody.replaceChildren();
        if (text && text.trim()) {
            Object.assign(this._explainBody.style, { color: '#d6dbe2', fontStyle: 'normal', fontSize: '13.5px' });
            for (const para of text.trim().split(/\n{2,}/)) {
                const p = document.createElement('p');
                Object.assign(p.style, { margin: '0 0 7px' });
                p.textContent = para.trim();
                this._explainBody.appendChild(p);
            }
        } else {
            Object.assign(this._explainBody.style, { color: '#93a0ad', fontStyle: 'italic', fontSize: '13px' });
            this._explainBody.textContent = 'Detailed explanation unavailable right now (provider busy).';
        }
    }

    /** Fill the AI sections once the daemon segmentation resolves. `featured` is the
     *  tapped word's contextual reading; `aiTokens` drives the whole-line breakdown.
     *  Both null ⇒ the AI call failed/was unavailable (graceful, rule-based stands). */
    setContext(featured: WordContext | null, aiTokens: SaviToken[] | null) {
        if (this._ctxBody) {
            this._ctxBody.replaceChildren();
            if (featured && (featured.gloss || featured.grammar)) {
                Object.assign(this._ctxBody.style, { color: '#9fd1a0', fontSize: '13.5px', fontStyle: 'normal' });
                this._ctxBody.textContent = `▸ ${[featured.gloss, featured.grammar].filter(Boolean).join(' · ')}`;
            } else {
                Object.assign(this._ctxBody.style, { color: '#93a0ad', fontSize: '13px', fontStyle: 'italic' });
                this._ctxBody.textContent = aiTokens
                    ? 'No distinct in-context reading — the dictionary entry above applies.'
                    : 'AI context unavailable right now (provider busy) — the dictionary entry above applies.';
            }
        }
        if (this._breakdownBody) {
            this._breakdownBody.replaceChildren();
            if (!aiTokens) {
                const note = document.createElement('div');
                Object.assign(note.style, { color: '#93a0ad', fontStyle: 'italic', fontSize: '13px' });
                note.textContent = 'unavailable';
                this._breakdownBody.appendChild(note);
                return;
            }
            for (const t of aiTokens) {
                if (!t.text.trim()) {
                    continue; // whitespace gap token
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
                Object.assign(surf.style, { fontWeight: '650', minWidth: '82px', color: '#fff' });
                surf.textContent = t.reading && t.reading !== t.text ? `${t.text}（${t.reading}）` : t.text;
                const mean = document.createElement('span');
                Object.assign(mean.style, { flex: '1', color: '#d6dbe2' });
                const bits = [t.gloss, t.grammar].filter(Boolean) as string[];
                mean.textContent = bits.length > 0 ? bits.join(' · ') : t.lemma && t.lemma !== t.text ? t.lemma : '';
                row.appendChild(surf);
                row.appendChild(mean);
                this._breakdownBody.appendChild(row);
            }
        }
    }

    hide() {
        if (this._el) {
            this._el.style.display = 'none';
        }
    }

    /** Dismiss: hide + notify the owner (which resumes the paused video). */
    private _close() {
        this.hide();
        this._onClose?.();
    }

    destroy() {
        this._el?.remove();
        this._el = null;
        this._scroll = null;
        this._ctxBody = null;
        this._breakdownBody = null;
        this._explainBody = null;
    }

    private _ensure(): HTMLDivElement {
        if (this._el) {
            return this._el;
        }
        const el = document.createElement('div');
        el.className = 'savi-word-panel';
        Object.assign(el.style, {
            position: 'fixed',
            left: '50%',
            top: '56px',
            transform: 'translateX(-50%)',
            zIndex: '2147483647',
            width: 'min(94vw, 560px)',
            maxHeight: '72vh',
            display: 'flex',
            flexDirection: 'column',
            padding: '14px 16px',
            borderRadius: '14px',
            border: '1px solid #2a313c',
            background: 'rgba(20, 22, 28, 0.98)',
            color: '#fff',
            font: '400 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            boxShadow: '0 10px 36px rgba(0, 0, 0, 0.6)',
            pointerEvents: 'auto',
        });
        el.style.display = 'none'; // hidden until show() flips it to flex

        const close = document.createElement('button');
        close.textContent = '×';
        close.title = 'Close';
        Object.assign(close.style, {
            position: 'absolute',
            top: '10px',
            right: '12px',
            cursor: 'pointer',
            border: 'none',
            background: 'rgba(255,255,255,0.16)',
            color: '#fff',
            width: '26px',
            height: '26px',
            borderRadius: '50%',
            font: '700 17px/1 sans-serif',
            flex: '0 0 auto',
        });
        close.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._close();
        });
        el.appendChild(close);

        const scroll = document.createElement('div');
        Object.assign(scroll.style, { overflowY: 'auto', paddingRight: '4px' });
        el.appendChild(scroll);

        document.body.appendChild(el);
        this._el = el;
        this._scroll = scroll;
        return el;
    }
}
