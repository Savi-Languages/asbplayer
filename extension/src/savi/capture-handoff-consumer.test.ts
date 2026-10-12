import { SaviCaptureController } from './capture-controller';

it('deactivates the matching video controller on handoff without an idle restart', () => {
    let listener: any;
    (globalThis as any).browser = {
        runtime: {
            onMessage: {
                addListener: (fn: any) => {
                    listener = fn;
                },
                removeListener: jest.fn(),
            },
        },
    };
    const controller = new SaviCaptureController({
        video: document.createElement('video'),
        settings: {} as any,
        videoSrc: () => 'blob:old',
        currentSubtitles: () => [],
        subtitleFileName: () => '',
        notify: jest.fn(),
    });
    const start = jest.spyOn(controller, 'start').mockResolvedValue(undefined);
    controller.bind();
    (controller as any)._active = true;
    try {
        const ended = (src: string) =>
            listener(
                {
                    sender: 'savi-extension-to-video',
                    message: {
                        command: 'savi-capture-ended',
                        src,
                        ok: false,
                        expired: false,
                    },
                },
                {},
                jest.fn()
            );
        ended('blob:unrelated');
        expect(controller.active).toBe(true);
        ended('blob:old');
        expect(controller.active).toBe(false);
        expect(start).not.toHaveBeenCalled();
    } finally {
        controller.unbind();
        delete (globalThis as any).browser;
    }
});
