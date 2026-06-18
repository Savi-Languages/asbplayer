// A compact playback-speed selector overlaid at the top of the video. Sets
// video.playbackRate directly. The rates offered (0.5–1.5) all sit inside the
// range savi capture tempo-corrects (0.5–2.0), so slowing down while recording
// is fine. Appended to document.body; styled by video.css (.savi-speed-control).

// Resolved lazily so the control can be constructed before the host's video
// element is wired up.
type VideoSource = () => HTMLMediaElement;

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

export class SaviSpeedControl {
    private readonly _getVideo: VideoSource;
    private _video: HTMLMediaElement | null = null;
    private _root: HTMLDivElement | null = null;
    private readonly _buttons = new Map<number, HTMLButtonElement>();
    private readonly _onRateChange = () => this._reflect();

    constructor(getVideo: VideoSource) {
        this._getVideo = getVideo;
    }

    show() {
        this._ensure().style.display = 'inline-flex';
        this._reflect();
    }

    hide() {
        if (this._root) {
            this._root.style.display = 'none';
        }
    }

    destroy() {
        this._video?.removeEventListener('ratechange', this._onRateChange);
        this._root?.remove();
        this._root = null;
        this._video = null;
        this._buttons.clear();
    }

    private _ensure(): HTMLDivElement {
        if (this._root) {
            return this._root;
        }
        const video = this._getVideo();
        this._video = video;

        const root = document.createElement('div');
        root.className = 'savi-speed-control';

        for (const speed of SPEEDS) {
            const button = document.createElement('button');
            button.className = 'savi-speed-button';
            button.textContent = `${speed}×`; // e.g. "0.75×"
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                video.playbackRate = speed;
                this._reflect();
            });
            root.appendChild(button);
            this._buttons.set(speed, button);
        }

        document.body.appendChild(root);
        // Reflect rate changes from any source (the site's own controls,
        // asbplayer's ±0.1 keybinds, an ad break resetting it).
        video.addEventListener('ratechange', this._onRateChange);
        this._root = root;
        return root;
    }

    private _reflect() {
        if (!this._video) {
            return;
        }
        const rate = this._video.playbackRate;
        for (const [speed, button] of this._buttons) {
            button.classList.toggle('active', Math.abs(speed - rate) < 0.001);
        }
    }
}
