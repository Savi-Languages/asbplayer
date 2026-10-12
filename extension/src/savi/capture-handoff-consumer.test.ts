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
        replay: jest.fn().mockResolvedValue(undefined),
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

it('ignores a delayed finish from an older take of the same video', () => {
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
        videoSrc: () => 'blob:same',
        currentSubtitles: () => [],
        subtitleFileName: () => '',
        notify: jest.fn(),
        replay: jest.fn().mockResolvedValue(undefined),
    });
    controller.bind();
    (controller as any)._active = true;
    (controller as any)._captureGeneration = 'current-take';
    listener(
        {
            sender: 'savi-extension-to-video',
            message: { command: 'savi-capture-ended', src: 'blob:same', generation: 'old-take', ok: true },
        },
        {},
        jest.fn()
    );
    expect(controller.active).toBe(true);
    listener(
        {
            sender: 'savi-extension-to-video',
            message: { command: 'savi-capture-ended', src: 'blob:same', generation: 'current-take', ok: true },
        },
        {},
        jest.fn()
    );
    expect(controller.active).toBe(false);
    controller.unbind();
});

it('deactivates on notOwner delivered through the direct keepalive transport', async () => {
    (globalThis as any).browser = {
        runtime: { sendMessage: jest.fn().mockResolvedValue({ ok: false, notOwner: true }) },
    };
    const controller = new SaviCaptureController({
        video: document.createElement('video'),
        settings: {} as any,
        videoSrc: () => 'blob:x',
        currentSubtitles: () => [],
        subtitleFileName: () => '',
        notify: jest.fn(),
        replay: jest.fn(),
    });
    (controller as any)._active = true;
    (controller as any)._captureGeneration = 'current';
    await (controller as any)._deliverOps([{ op: 'segment-end' }]);
    expect(controller.active).toBe(false);
});
it('retries Stop with the original recording identity', async () => {
    const send = jest.fn().mockRejectedValueOnce(new Error('Worker restarted')).mockResolvedValue({ stopped: true });
    (globalThis as any).browser = { runtime: { sendMessage: send } };
    const controller = new SaviCaptureController({
        video: document.createElement('video'),
        settings: {} as any,
        videoSrc: () => 'blob:x',
        currentSubtitles: () => [],
        subtitleFileName: () => '',
        notify: jest.fn(),
        replay: jest.fn(),
    });
    (controller as any)._active = true;
    (controller as any)._captureEpisodeId = 'episode-a';
    (controller as any)._captureGeneration = 'original';
    await controller.stop();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
    expect(send.mock.calls[1][0].message).toMatchObject({ episodeId: 'episode-a', generation: 'original' });
});

const recoveryFixture = () => {
    let listener: any;
    const send = jest.fn();
    (globalThis as any).browser = {
        runtime: {
            sendMessage: send,
            onMessage: {
                addListener: (fn: any) => {
                    listener = fn;
                },
                removeListener: jest.fn(),
            },
        },
    };
    const notify = jest.fn();
    const controller = new SaviCaptureController({
        video: document.createElement('video'),
        settings: {} as any,
        videoSrc: () => 'blob:x',
        currentSubtitles: () => [],
        subtitleFileName: () => '',
        notify,
        replay: jest.fn(),
    });
    controller.bind();
    const c = controller as any;
    c._active = true;
    c._captureGeneration = 'old';
    c._captureEpisodeId = 'episode-a';
    jest.spyOn(c, '_pageMetadata').mockReturnValue({ episodeId: 'episode-a' });
    const start = jest.spyOn(controller, 'start').mockImplementation(async () => {
        c._active = true;
        c._captureGeneration = 'new';
    });
    const expire = () =>
        listener(
            {
                sender: 'savi-extension-to-video',
                message: {
                    command: 'savi-capture-ended',
                    src: 'blob:x',
                    generation: 'old',
                    expired: true,
                    ok: false,
                },
            },
            {},
            jest.fn()
        );
    return { c, controller, start, send, notify, expire };
};
it('deactivates an absent, non-expired capture without restarting or claiming it was saved', async () => {
    const f = recoveryFixture();
    try {
        f.send.mockResolvedValue({ ok: false, ownerAbsent: true });
        await f.c._deliverOps([]);
        expect(f.controller.active).toBe(false);
        expect(f.start).not.toHaveBeenCalled();
        expect(f.notify.mock.calls.flat().join(' ')).not.toContain('saved');
    } finally {
        f.controller.unbind();
    }
});
it('recovers from a sessionGone reply even if the expiry notification is lost', async () => {
    const f = recoveryFixture();
    try {
        f.send.mockResolvedValue({ ok: false, sessionGone: true });
        await f.c._deliverOps([]);
        expect(f.start).toHaveBeenCalledTimes(1);
        f.expire();
        expect(f.start).toHaveBeenCalledTimes(1);
    } finally {
        f.controller.unbind();
    }
});
it('ignores a late expiry reply after a deliberate Stop', async () => {
    const f = recoveryFixture();
    try {
        let release!: (v: any) => void;
        f.send
            .mockImplementationOnce(
                () =>
                    new Promise((r) => {
                        release = r;
                    })
            )
            .mockResolvedValue({ stopped: true });
        const delivery = f.c._deliverOps([]);
        await f.controller.stop(true);
        release({ ok: false, sessionGone: true });
        await delivery;
        f.expire();
        expect(f.start).not.toHaveBeenCalled();
        expect(f.controller.active).toBe(false);
    } finally {
        f.controller.unbind();
    }
});
it.each([true, false])(
    'distinguishes lost Stop acknowledgement from a real ownership error: alreadyStopped=%s',
    async (alreadyStopped) => {
        const f = recoveryFixture();
        try {
            f.send.mockRejectedValueOnce(new Error('Worker restarted')).mockResolvedValue({
                stopped: false,
                alreadyStopped,
                errorMessage: 'Another tab owns this capture.',
            });
            await f.controller.stop();
            const notices = f.notify.mock.calls.flat().join(' ');
            expect(notices.includes('capture failed')).toBe(!alreadyStopped);
            expect(notices).not.toContain('saved');
        } finally {
            f.controller.unbind();
        }
    }
);
