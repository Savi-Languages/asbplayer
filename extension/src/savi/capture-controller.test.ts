import { SaviCaptureController, SaviCaptureHost } from './capture-controller';

// Regression cover for the "Start recording / Ctrl+Shift+S does nothing" bug:
// the savi-request-start handler used to silently return when no subtitle track
// was loaded, so the shortcut / popup had zero feedback. It now TOGGLES exactly
// like the on-video Record button (start(true) surfaces its own "no subtitle
// track loaded" notice), so a keypress with nothing to capture explains itself.
//
// start()/stop() are spied so their async internals (settings, browser.storage,
// runtime messaging) stay out of scope — this pins the handler's routing only.
describe('SaviCaptureController — savi-request-start handler', () => {
    let messageListener: ((request: any, sender: any, sendResponse: any) => any) | undefined;

    beforeEach(() => {
        messageListener = undefined;
        (globalThis as any).browser = {
            runtime: {
                onMessage: {
                    addListener: (listener: any) => {
                        messageListener = listener;
                    },
                    removeListener: () => {},
                },
            },
        };
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete (globalThis as any).browser;
    });

    const makeController = (subtitles: any[] = []) => {
        const host: SaviCaptureHost = {
            video: document.createElement('video') as HTMLMediaElement,
            settings: {} as any,
            currentSubtitles: () => subtitles,
            videoSrc: () => 'https://example.test/video',
            subtitleFileName: () => '',
            notify: jest.fn(),
        };
        return new SaviCaptureController(host);
    };

    const requestStart = () => {
        const sendResponse = jest.fn();
        messageListener?.(
            { sender: 'savi-extension-to-video', message: { command: 'savi-request-start' } },
            {},
            sendResponse
        );
        return sendResponse;
    };

    it('starts (manually) even with NO subtitle track loaded — the silent gate is gone', () => {
        const controller = makeController([]); // nothing to capture
        const start = jest.spyOn(controller, 'start').mockResolvedValue(undefined);
        controller.bind();

        const sendResponse = requestStart();

        // Before the fix this branch bailed silently on _subtitlesForCapture().length === 0.
        expect(start).toHaveBeenCalledWith(true);
        expect(sendResponse).toHaveBeenCalledWith({ requested: true });
    });

    it('stops when already recording (toggle-off), does not start again', () => {
        const controller = makeController([{ track: 0, text: 'hi', start: 0, end: 1 }]);
        (controller as any)._active = true;
        const start = jest.spyOn(controller, 'start').mockResolvedValue(undefined);
        const stop = jest.spyOn(controller, 'stop').mockResolvedValue(undefined);
        controller.bind();

        const sendResponse = requestStart();

        expect(stop).toHaveBeenCalledWith(true);
        expect(start).not.toHaveBeenCalled();
        expect(sendResponse).toHaveBeenCalledWith({ requested: true });
    });

    it('ignores savi-request-start from a non-savi sender', () => {
        const controller = makeController([]);
        const start = jest.spyOn(controller, 'start').mockResolvedValue(undefined);
        controller.bind();

        const sendResponse = jest.fn();
        messageListener?.(
            { sender: 'asbplayer-extension-to-video', message: { command: 'savi-request-start' } },
            {},
            sendResponse
        );

        expect(start).not.toHaveBeenCalled();
        expect(sendResponse).not.toHaveBeenCalled();
    });
});
