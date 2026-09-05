import type { SaviToken } from './daemon-client';
import { baseTextOf } from './gloss-hover';
import { SUBTITLE_CONTAINER } from './hover-dict';
import { subtitleTokens } from './token-cache';

function unwrap(root: ParentNode): void {
    for (const span of root.querySelectorAll('span.savi-target[data-savi-target]')) {
        span.replaceWith(...span.childNodes);
    }
}
/** Wrap pieces of base text individually. A Range spanning ruby nodes would
 *  accidentally extract its <rt> label or break nested markup. Never do that. */
export function decorateTargetTokens(
    root: HTMLElement,
    tokens: readonly SaviToken[],
    targets: ReadonlySet<string>
): HTMLElement[] {
    unwrap(root);
    if (tokens.map((t) => t.text).join('') !== baseTextOf(root)) return [];
    const matches: { start: number; end: number; lemma: string }[] = [];
    let offset = 0;
    for (const token of tokens) {
        if (token.lemma && targets.has(token.lemma))
            matches.push({ start: offset, end: offset + token.text.length, lemma: token.lemma });
        offset += token.text.length;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes: { node: Text; start: number; end: number }[] = [];
    offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const end = offset + (node.textContent?.length ?? 0);
        nodes.push({ node: node as Text, start: offset, end });
        offset = end;
    }
    const wrapped: HTMLElement[] = [];
    for (const { node, start, end } of nodes) {
        for (const match of matches.filter((m) => m.start < end && m.end > start).reverse()) {
            const from = Math.max(start, match.start) - start;
            const to = Math.min(end, match.end) - start;
            if (to <= from) continue;
            if (to < node.length) node.splitText(to);
            const piece = from > 0 ? node.splitText(from) : node;
            const span = document.createElement('span');
            span.className = 'savi-target';
            span.dataset.saviTarget = match.lemma;
            piece.replaceWith(span);
            span.appendChild(piece);
            wrapped.push(span);
        }
    }
    return wrapped;
}

/** Decoration is local analysis only, never a gloss/segment/AI request. */
export class SaviTargetDecorator {
    private observer?: MutationObserver;
    private targets = new Set<string>();
    private lang = '';
    private generation = 0;
    private scheduled = false;
    private pending = new WeakSet<HTMLElement>();
    private failedUntil = new WeakMap<HTMLElement, number>();
    private decorated = new WeakMap<HTMLElement, { text: string; spans: HTMLElement[] }>();
    constructor(private readonly subtitles: () => readonly { text: string; track?: number }[]) {}
    setTargets(lang: string, lemmas: readonly string[]): void {
        this.stop();
        this.lang = lang;
        this.targets = new Set(lemmas);
        if (!lang || !lemmas.length) return;
        if (!document.getElementById('savi-target-style')) {
            const style = document.createElement('style');
            style.id = 'savi-target-style';
            style.textContent =
                '.savi-target { text-decoration-line: underline; text-decoration-color: #c8b8f5; text-decoration-thickness: .09em; text-underline-offset: .2em; background: rgba(180,155,230,.12); border-radius: .12em; }';
            document.head.appendChild(style);
        }
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(document.body, { childList: true, characterData: true, subtree: true });
        this.schedule();
    }
    stop(): void {
        this.generation++;
        this.observer?.disconnect();
        this.observer = undefined;
        this.targets.clear();
        this.decorated = new WeakMap();
        this.pending = new WeakSet();
        unwrap(document);
    }
    private schedule(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            this.scan();
        });
    }
    private scan(): void {
        if (!this.targets.size) return;
        const generation = this.generation;
        const cueTexts = new Set(
            this.subtitles()
                .filter((s) => (s.track ?? 0) === 0)
                .map((s) => s.text.trim())
        );
        const selector = SUBTITLE_CONTAINER.split(',')
            .map((container) => `${container.trim()} [data-track="0"]`)
            .join(',');
        for (const track of document.querySelectorAll<HTMLElement>(selector)) {
            const root = track.querySelector<HTMLElement>('.asbplayer-subtitle-text') ?? track;
            const text = baseTextOf(root);
            if (!cueTexts.has(text.trim()) || this.pending.has(root) || (this.failedUntil.get(root) ?? 0) > Date.now())
                continue;
            const prior = this.decorated.get(root);
            if (prior?.text === text && prior.spans.every((span) => root.contains(span))) continue;
            const pending = this.pending;
            pending.add(root);
            void subtitleTokens
                .getRaw(this.lang, text)
                .then((tokens) => {
                    if (generation !== this.generation || !root.isConnected || baseTextOf(root) !== text) return;
                    const spans = decorateTargetTokens(root, tokens, this.targets);
                    this.decorated.set(root, { text, spans });
                })
                .catch(() => {
                    this.failedUntil.set(root, Date.now() + 5000);
                })
                .finally(() => {
                    pending.delete(root);
                });
        }
    }
}
