import { positionPopup, SaviHoverDictionary } from './hover-dict';
const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
});
it.each([20, 40, 60])('leaves a neighboring text row accessible for %spx words', (height) => {
    const popup = document.createElement('div'),
        arrow = document.createElement('div');
    jest.spyOn(popup, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 300, 180));
    const word = rect(200, 500, 100, height);
    positionPopup(popup, arrow, word);
    const bottom = parseFloat(popup.style.top) + 180;
    expect(word.top - bottom).toBeGreaterThanOrEqual(height * 1.8);
    positionPopup(popup, arrow, rect(200, 10, 100, height));
    expect(parseFloat(popup.style.top) - (10 + height)).toBeGreaterThanOrEqual(height * 1.8);
});
it('keeps the popup reachable through a gap that does not intercept underlying words', () => {
    const dict = new SaviHoverDictionary() as any;
    const popup = document.createElement('div');
    dict._popup = popup;
    jest.spyOn(popup, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 300, 180));
    dict._positionBridge(rect(200, 400, 100, 40));
    const bridge = document.querySelector<HTMLElement>('.savi-dict-bridge')!;
    expect(bridge.style.pointerEvents).toBe('none');
    jest.spyOn(bridge, 'getBoundingClientRect').mockReturnValue(rect(100, 280, 300, 120));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body });
    expect(dict.isOverHoverSurface(220, 330)).toBe(true);
    const hide = jest.spyOn(dict, '_scheduleHide');
    jest.spyOn(dict, '_resolveLine').mockReturnValue(null);
    dict._onMouseMove(new MouseEvent('mousemove', { clientX: 220, clientY: 330 }));
    expect(hide).not.toHaveBeenCalled();
    const neighboringLine = document.createElement('span');
    dict._resolveLine.mockReturnValue(neighboringLine);
    const hover = jest.spyOn(dict, '_handleHover').mockResolvedValue(undefined);
    dict._onMouseMove(new MouseEvent('mousemove', { clientX: 220, clientY: 330 }));
    jest.advanceTimersByTime(200);
    expect(hover).toHaveBeenCalledWith(neighboringLine, 220, 330);
    bridge.style.display = 'none';
    expect(dict.isOverHoverSurface(220, 330)).toBe(false);
    dict.stop();
});

it('scrolls a tall popup internally instead of covering the neighboring row or leaving the viewport', () => {
    const popup = document.createElement('div'),
        content = document.createElement('div'),
        arrow = document.createElement('div');
    content.dataset.saviPopupContent = '';
    popup.append(content);
    const height = () => (content.style.maxHeight ? Number.parseFloat(content.style.maxHeight) : 700);
    jest.spyOn(content, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 300, height()));
    jest.spyOn(popup, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 336, height() + 32));
    const word = rect(200, 500, 100, 40);
    positionPopup(popup, arrow, word);
    expect(Number.parseFloat(popup.style.top)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(popup.style.top) + height() + 32).toBeLessThan(word.top - 72);
    expect(content.style.overflowY).toBe('auto');
});
