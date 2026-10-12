import { cropAndResize } from '@project/common/src/image-transformer';
/** Capture only a fully visible paused player. Images are optional; never
 * attach a later frame after playback, a seek, account or episode change. */
export async function captureWatchScreenshot(
    video: HTMLMediaElement,
    send: (message: any) => Promise<any>,
    current: () => boolean
): Promise<string | undefined> {
    const rect = video.getBoundingClientRect();
    if (
        !current() ||
        !video.paused ||
        video.seeking ||
        document.hidden ||
        rect.width < 1 ||
        rect.height < 1 ||
        rect.left < 0 ||
        rect.top < 0 ||
        rect.right > innerWidth ||
        rect.bottom > innerHeight
    )
        return;
    try {
        const result = await send({ command: 'savi-capture-frame' });
        if (!current() || document.hidden || !video.paused || video.seeking || !result?.dataUrl) return;
        const after = video.getBoundingClientRect();
        if (
            after.left !== rect.left ||
            after.top !== rect.top ||
            after.width !== rect.width ||
            after.height !== rect.height
        )
            return;
        for (const width of [640, 400]) {
            const cropped = await cropAndResize(
                width,
                0,
                { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                result.dataUrl
            );
            if (!current() || document.hidden || !video.paused || video.seeking) return;
            if (cropped.length <= 240000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(cropped)) return cropped;
        }
    } catch {
        /* The subtitle still saves when screenshot capture is unavailable. */
    }
}
