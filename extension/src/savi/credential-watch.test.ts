import {
    bindCredentialWatch,
    CREDENTIAL_STATE_KEY,
    noteTokenResolution,
    resetCredentialWatchForTests,
} from './credential-watch';
import { loadRoamingSettings } from './cloud-settings';

jest.mock('./cloud-settings', () => ({ loadRoamingSettings: jest.fn() }));
// cloud-client reads `import.meta.env` at module scope for the dev override,
// which Jest cannot parse. Identity here: resolving the base URL is that
// module's job and its own concern, not this one's.
jest.mock('./cloud-client', () => ({ resolveCloudBase: (url: string) => url }));

const loadMock = loadRoamingSettings as jest.Mock;

// The unit under test is an edge detector with one side effect, so the
// assertions are about WHEN it fires, not what it fetched: the pull and the
// broadcast are both faked and only their order and count matter.
describe('savi credential watch', () => {
    let session: Record<string, unknown>;
    let sendMessageMock: jest.Mock;
    /** Every observable effect, in the order it happened. */
    let calls: string[];

    const cloudUrl = 'https://cloud.example';
    /** The settings read, made observable: it appears in `calls` when it
     *  actually happens, so tests can assert it did NOT on the no-edge path. */
    const readCloudUrl = async () => {
        calls.push('read-cloud-url');
        return cloudUrl;
    };

    beforeEach(() => {
        resetCredentialWatchForTests();
        session = {};
        calls = [];

        loadMock.mockReset();
        loadMock.mockImplementation(async () => {
            calls.push('pull');
            return { targetLanguage: 'es', openSubtitlesApiKey: '' };
        });

        sendMessageMock = jest.fn(async (command: any) => {
            calls.push(`broadcast:${command?.message?.command}`);
        });

        (globalThis as any).browser = {
            storage: {
                session: {
                    get: async (key: string) => (key in session ? { [key]: session[key] } : {}),
                    set: async (items: Record<string, unknown>) => {
                        Object.assign(session, items);
                    },
                },
            },
            runtime: { sendMessage: sendMessageMock },
        };
    });

    afterEach(() => {
        delete (globalThis as any).browser;
    });

    it('pulls the roaming settings BEFORE broadcasting, on a rising edge', async () => {
        // Nothing stored = no credentials last time. A session coming back —
        // refreshed after expiry, or restored when the network did — shows up
        // here as the first resolution that yields a token.
        await noteTokenResolution(true, readCloudUrl);

        // The order is the fix: broadcasting first would have every content
        // script re-read the cache the pull has not filled yet.
        expect(calls).toEqual(['read-cloud-url', 'pull', 'broadcast:settings-updated']);
        expect(loadMock).toHaveBeenCalledWith(cloudUrl);
        expect(session[CREDENTIAL_STATE_KEY]).toBe(true);
    });

    it('never reads the cloud url on the no-edge path — the one that runs per request', async () => {
        // Every gloss, dictionary lookup, and watched-line report resolves its
        // token through the observer that lands here. In the steady state
        // (credentials present, unchanged) that has to cost nothing: before
        // this, the caller read `saviCloudUrl` from storage BEFORE the early
        // return, once per request, and used it never (savi#33).
        session[CREDENTIAL_STATE_KEY] = true;
        for (let i = 0; i < 25; i++) {
            await noteTokenResolution(true, readCloudUrl);
        }
        expect(calls).toEqual([]);

        // A falling edge writes state but reads nothing either — there is
        // nothing to pull with.
        await noteTokenResolution(false, readCloudUrl);
        expect(calls).toEqual([]);

        // Only the rising edge pays for the read, and pays once.
        await noteTokenResolution(true, readCloudUrl);
        expect(calls).toEqual(['read-cloud-url', 'pull', 'broadcast:settings-updated']);
        expect(calls.filter((c) => c === 'read-cloud-url')).toHaveLength(1);
    });

    it('does nothing when credentials were already there', async () => {
        session[CREDENTIAL_STATE_KEY] = true;

        await noteTokenResolution(true, readCloudUrl);

        expect(calls).toEqual([]);
    });

    it('does nothing on a falling edge, but re-arms when they come back', async () => {
        session[CREDENTIAL_STATE_KEY] = true;

        // Losing the token needs no pull — there is nothing to pull with — and
        // no broadcast: requests stop being authorized on their own.
        await noteTokenResolution(false, readCloudUrl);
        expect(calls).toEqual([]);
        expect(session[CREDENTIAL_STATE_KEY]).toBe(false);

        // ...and a session lapsing offline, then refreshing when the network
        // comes back, is exactly this sequence — no sign-in anywhere in it.
        await noteTokenResolution(true, readCloudUrl);
        expect(calls).toEqual(['read-cloud-url', 'pull', 'broadcast:settings-updated']);
    });

    it('fires once per edge, not once per resolution', async () => {
        await noteTokenResolution(true, readCloudUrl);
        await noteTokenResolution(true, readCloudUrl);
        await noteTokenResolution(true, readCloudUrl);

        expect(loadMock).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('collapses a concurrent burst into one pull', async () => {
        // Every gloss, dict and watched-line request resolves a bearer, so a
        // busy moment produces many resolutions at once.
        await Promise.all([
            noteTokenResolution(true, readCloudUrl),
            noteTokenResolution(true, readCloudUrl),
            noteTokenResolution(true, readCloudUrl),
            noteTokenResolution(true, readCloudUrl),
        ]);

        expect(loadMock).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('re-seeds from storage after a service-worker restart instead of re-firing', async () => {
        await noteTokenResolution(true, readCloudUrl);
        expect(loadMock).toHaveBeenCalledTimes(1);

        // MV3 unloads the background after ~30s idle. In-memory state is gone;
        // storage.session is not. Without the re-seed the next resolution would
        // read as a fresh rising edge and re-arm every bound video for nothing.
        resetCredentialWatchForTests();

        await noteTokenResolution(true, readCloudUrl);

        expect(loadMock).toHaveBeenCalledTimes(1);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('assumes credentials were present when storage cannot be read', async () => {
        (globalThis as any).browser.storage.session.get = async () => {
            throw new Error('no storage.session');
        };

        // Guessing "none" would manufacture a rising edge on every wake. A
        // missed re-arm is recovered by the next real transition; a spurious
        // one restarts the controllers on a timer.
        await noteTokenResolution(true, readCloudUrl);

        expect(calls).toEqual([]);
    });

    it('broadcasts even when the pull fails', async () => {
        loadMock.mockRejectedValue(new Error('offline'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        await noteTokenResolution(true, readCloudUrl);

        // The re-arm is worth having on its own — the next video data sync
        // fetches the language from the cloud anyway.
        expect(calls).toEqual(['read-cloud-url', 'broadcast:settings-updated']);
        expect(session[CREDENTIAL_STATE_KEY]).toBe(true);
    });

    it('survives a broadcast with no receiver', async () => {
        sendMessageMock.mockRejectedValue(new Error('could not establish connection'));

        await expect(noteTokenResolution(true, readCloudUrl)).resolves.toBeUndefined();
        expect(loadMock).toHaveBeenCalledTimes(1);
    });

    describe('bindCredentialWatch', () => {
        /** The observer is fire-and-forget; let its detached work settle. */
        const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

        it('reads the cloud url lazily and returns without awaiting the pull', async () => {
            const readCloudUrl = jest.fn(async () => cloudUrl);
            const observer = bindCredentialWatch(readCloudUrl);

            // Synchronous return is the requirement: currentAccessToken must
            // not wait on a settings read and a network round trip to hand back
            // a bearer it already resolved.
            expect(observer(true)).toBeUndefined();
            expect(loadMock).not.toHaveBeenCalled();

            await settle();

            expect(readCloudUrl).toHaveBeenCalledTimes(1);
            expect(calls).toEqual(['pull', 'broadcast:settings-updated']);
        });

        it('swallows a failure to read the cloud url', async () => {
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            const observer = bindCredentialWatch(async () => {
                throw new Error('settings unavailable');
            });

            observer(true);
            await settle();

            expect(calls).toEqual([]);
        });
    });
});
