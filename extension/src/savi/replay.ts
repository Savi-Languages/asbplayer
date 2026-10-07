/** Replay uses the platform seek bridge, but reports playback failures to the toolbar. */
export async function replayFrom(
    video: HTMLMediaElement,
    startMs: number,
    seek: (seconds: number) => void,
    netflix: boolean
): Promise<void> {
    seek(startMs / 1000);
    if (!video.paused) return;

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            video.removeEventListener('play', started);
            video.removeEventListener('playing', started);
        };
        const started = () => {
            cleanup();
            resolve();
        };
        const failed = (error: unknown) => {
            cleanup();
            reject(error);
        };
        const timer = setTimeout(() => failed(new Error('Playback did not start')), 10000);
        try {
            if (netflix) {
                video.addEventListener('play', started);
                video.addEventListener('playing', started);
                document.dispatchEvent(new CustomEvent('asbplayer-netflix-play'));
            } else {
                void video.play().then(started, failed);
            }
        } catch (error) {
            failed(error);
        }
    });
}
