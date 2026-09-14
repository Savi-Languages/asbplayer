// Direct coverage of SaviCommandHandler._warmProjections (SV-40 bind-time warm
// follow-up). The finding this closes: cloud-client.ts's warmProjections never
// checked response.ok, so a 401 (expired JWT), 404 (a cloud predating the
// route) or 500 all resolved as silent success — and this handler's own
// try/catch then always answered { ok: true } regardless of what actually
// happened, with nothing logged anywhere. Fixing cloud-client.ts to throw on a
// non-2xx response is only a real fix if this handler still (a) never lets
// that throw escape past it, and (b) stops claiming success once it does.
//
// cloud-client.ts is virtually mocked rather than imported for real: it reads
// import.meta.env (a Vite/WXT build-time construct) at module scope, which
// ts-jest cannot parse — so no test file can import it, or anything that
// imports it, without replacing it entirely first. That is also why no
// cloud-client.test.ts exists: the module cannot be loaded under Jest at all.
jest.mock('./cloud-client', () => ({
    DEFAULT_GLOSS_THRESHOLD: 0.8,
    glossThreshold: jest.fn(),
    resolveCloudBase: jest.fn((u: string) => u),
    glossLine: jest.fn(),
    translate: jest.fn(),
    wordBuckets: jest.fn(),
    wordsProficiency: jest.fn(),
    warmProjections: jest.fn(),
}));

import SaviCommandHandler from './background-handler';
import { warmProjections as mockWarmProjections, translate as mockTranslate } from './cloud-client';

describe('English subtitle translation', () => {
    beforeEach(() => (mockTranslate as jest.Mock).mockReset());
    const handler = () => new SaviCommandHandler({ get: async () => ({ saviCloudUrl: 'https://cloud.example' }) } as any);
    it('translates the full sentence into English with neighboring context', async () => {
        (mockTranslate as jest.Mock).mockResolvedValue({ text: 'It was a one-week trip.', provider: 'deepl' });
        const result = await (handler() as any)._subtitleTranslate({ command: 'savi-subtitle-translate', text: '1週間の旅行でした。', sourceLang: 'ja', context: 'スペインに行きました。' });
        expect(mockTranslate).toHaveBeenCalledWith('https://cloud.example', '1週間の旅行でした。', 'en', 'ja', 'スペインに行きました。');
        expect(result.text).toBe('It was a one-week trip.');
    });
    it('rejects oversized input before calling the translation provider', async () => {
        expect(await (handler() as any)._subtitleTranslate({ text: 'a'.repeat(4001), sourceLang: 'ja' })).toEqual({});
        expect(mockTranslate).not.toHaveBeenCalled();
    });
    it('answers unavailable when the service fails rather than leaving the subtitle pending', async () => {
        (mockTranslate as jest.Mock).mockRejectedValue(Error('offline'));
        const reply = jest.fn();
        handler().handle({ sender: 'savi-video', message: { command: 'savi-subtitle-translate', text: '旅行', sourceLang: 'ja' } }, {} as any, reply);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(reply).toHaveBeenCalledWith({});
    });
});

describe('SaviCommandHandler._warmProjections', () => {
    const settings = { get: async () => ({ saviCloudUrl: 'https://cloud.example' }) } as any;

    const warm = (handler: SaviCommandHandler) =>
        (handler as unknown as { _warmProjections: (m: unknown) => Promise<{ ok?: boolean }> })._warmProjections({
            command: 'savi-warm-projections',
            lang: 'es',
        });

    beforeEach(() => {
        (mockWarmProjections as jest.Mock).mockReset();
    });

    it('reports { ok: true } when the cloud call actually succeeds', async () => {
        (mockWarmProjections as jest.Mock).mockResolvedValueOnce(undefined);
        const handler = new SaviCommandHandler(settings);

        await expect(warm(handler)).resolves.toEqual({ ok: true });
    });

    it('swallows a non-ok warm response (now a thrown error) without throwing, and stops claiming ok:true', async () => {
        // Simulates the post-fix cloud-client.ts behaviour: a non-2xx response
        // throws instead of resolving silently. Before the fix this branch was
        // unreachable — a 401/404/500 looked identical to success from here.
        (mockWarmProjections as jest.Mock).mockRejectedValueOnce(new Error('cloud warm failed: HTTP 401'));
        const handler = new SaviCommandHandler(settings);

        await expect(warm(handler)).resolves.toEqual({});
    });

    it('the public handle() dispatch never throws or leaves sendResponse uncalled on failure', async () => {
        (mockWarmProjections as jest.Mock).mockRejectedValueOnce(new Error('cloud warm failed: HTTP 500'));
        const handler = new SaviCommandHandler(settings);
        const sendResponse = jest.fn();

        const command = { sender: 'savi-video', message: { command: 'savi-warm-projections', lang: 'es' } };
        expect(() => handler.handle(command, {} as any, sendResponse)).not.toThrow();

        // handle() returns synchronously (true, meaning "async response
        // coming"); sendResponse fires once the promise chain settles.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(sendResponse).toHaveBeenCalledWith({});
    });
});

describe('Savi screenshot tab identity',()=>{
 afterEach(()=>{delete (globalThis as any).browser;});
 it('refuses an inactive sender tab',async()=>{
  const capture=jest.fn();(globalThis as any).browser={tabs:{get:async()=>({active:false,windowId:1}),captureVisibleTab:capture}};
  const handler=new SaviCommandHandler({} as any);
  expect(await (handler as any)._captureFrame({tab:{id:5}})).toEqual({});expect(capture).not.toHaveBeenCalled();
 });
 it('drops captured pixels if the active tab changed during capture',async()=>{
  (globalThis as any).browser={tabs:{get:async()=>({active:true,windowId:1}),captureVisibleTab:async()=> 'private-other-tab',query:async()=>[{id:6}]},windows:{get:async()=>({focused:true})}};
  const handler=new SaviCommandHandler({} as any);
  expect(await (handler as any)._captureFrame({tab:{id:5}})).toEqual({});
 });
});
