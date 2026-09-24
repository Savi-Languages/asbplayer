import { SaviHoverPause } from './hover-pause';

describe('hover holds the current subtitle at its end', () => {
    let video: HTMLVideoElement;
    let paused: boolean;
    let enabled: boolean;
    let onPopup: boolean;
    let pause: jest.Mock;
    let play: jest.Mock;
    let controller: SaviHoverPause;
    let line: HTMLElement;
    let cues: (typeof cue)[];
    const cue = { text: '私は君を利用している', start: 1000, end: 4000, track: 0 };
    const move = (target: Element) => target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const advance = (seconds: number) => {
        video.currentTime = seconds;
        jest.advanceTimersByTime(100);
    };

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML =
            '<div class="asbplayer-subtitles"><span data-track="0">私は君を<ruby>利用<rt>りよう</rt></ruby>している</span></div>';
        line = document.querySelector('[data-track]')!;
        video = document.createElement('video');
        paused = false;
        enabled = true;
        onPopup = false;
        cues = [cue];
        video.currentTime = 2;
        Object.defineProperty(video, 'paused', { get: () => paused });
        pause = jest.fn(() => {
            paused = true;
            video.dispatchEvent(new Event('pause'));
        });
        play = jest.fn(() => {
            paused = false;
            video.dispatchEvent(new Event('play'));
        });
        controller = new SaviHoverPause({
            video,
            subtitles: () => cues,
            enabled: () => enabled,
            pause,
            play,
            overPopup: () => onPopup,
        });
        controller.start();
    });
    afterEach(() => {
        controller.stop();
        jest.useRealTimers();
        document.body.innerHTML = '';
    });

    test('Japanese hover plays to the end, holds without further mouse movement, and resumes on leave', () => {
        move(line.querySelector('ruby')!);
        expect(pause).not.toHaveBeenCalled();
        advance(3.8);
        expect(pause).not.toHaveBeenCalled();
        advance(3.99);
        expect(pause).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1000);
        expect(play).not.toHaveBeenCalled();
        move(document.body);
        expect(play).toHaveBeenCalledTimes(1);
    });
    test('leaving before the end cancels the pending pause', () => {
        move(line);
        move(document.body);
        advance(4.1);
        expect(pause).not.toHaveBeenCalled();
    });
    test('the definition popup keeps the original cue armed and held', () => {
        move(line);
        onPopup = true;
        move(document.body);
        advance(4.02);
        expect(pause).toHaveBeenCalledTimes(1);
        move(document.body);
        expect(play).not.toHaveBeenCalled();
        onPopup = false;
        move(document.body);
        expect(play).toHaveBeenCalledTimes(1);
    });
    test('fast playback crossing the boundary still pauses', () => {
        video.playbackRate = 2;
        move(line);
        advance(4.08);
        expect(pause).toHaveBeenCalledTimes(1);
    });
    test('does not resume an existing manual pause', () => {
        paused = true;
        move(line);
        advance(4);
        move(document.body);
        expect(pause).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
    });
    test('seeking cancels the old cue and pause ownership', () => {
        move(line);
        advance(3.99);
        video.dispatchEvent(new Event('seeking'));
        move(document.body);
        expect(play).not.toHaveBeenCalled();
    });
    test('manual play after a held pause overrides the hover', () => {
        move(line);
        advance(3.99);
        paused = false;
        video.dispatchEvent(new Event('play'));
        advance(4.2);
        expect(pause).toHaveBeenCalledTimes(1);
    });
    test('disabled hover and notification text never arm a pause', () => {
        enabled = false;
        move(line);
        advance(3.99);
        expect(pause).not.toHaveBeenCalled();
        enabled = true;
        video.currentTime = 2;
        line.textContent = 'Loaded subtitles';
        move(line);
        advance(4);
        expect(pause).not.toHaveBeenCalled();
    });
    test('leaving during the Netflix pause acknowledgement resumes when it arrives', () => {
        pause.mockImplementation(() => {});
        move(line);
        advance(3.99);
        move(document.body);
        expect(play).not.toHaveBeenCalled();
        paused = true;
        video.dispatchEvent(new Event('pause'));
        expect(play).toHaveBeenCalledTimes(1);
    });
    test('buffering does not pause based on wall time', () => {
        move(line);
        jest.advanceTimersByTime(5000);
        expect(pause).not.toHaveBeenCalled();
        advance(3.99);
        expect(pause).toHaveBeenCalledTimes(1);
    });
    test('overlapping tracks use the hovered track end', () => {
        cues = [{ ...cue, end: 2500, track: 1 }, cue];
        move(line);
        advance(2.6);
        expect(pause).not.toHaveBeenCalled();
        advance(3.99);
        expect(pause).toHaveBeenCalledTimes(1);
    });
    test('replacing or retiming subtitles cancels the old deadline', () => {
        move(line);
        cues = [{ ...cue, end: 6000 }];
        advance(3.99);
        expect(pause).not.toHaveBeenCalled();
        move(line);
        advance(5.99);
        expect(pause).toHaveBeenCalledTimes(1);
    });
    test('a manual pause before the deadline is never auto-resumed', () => {
        move(line);
        paused = true;
        video.dispatchEvent(new Event('pause'));
        advance(3.99);
        move(document.body);
        expect(pause).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
    });
    test('teardown removes a pending deadline', () => {
        move(line);
        controller.stop();
        advance(4);
        expect(pause).not.toHaveBeenCalled();
    });
});
