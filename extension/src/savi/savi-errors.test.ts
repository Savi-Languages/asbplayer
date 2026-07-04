import { friendlySaviError } from './savi-errors';

describe('friendlySaviError', () => {
    it('maps a duplicate-note error', () => {
        expect(friendlySaviError('AnkiConnect: cannot create note because it is a duplicate')).toBe('Already in Anki');
    });

    it('points an unconfigured daemon at settings', () => {
        expect(friendlySaviError('savi daemon URL/token not set')).toMatch(/settings/i);
    });

    it('flags AnkiConnect being down', () => {
        expect(friendlySaviError('AnkiConnect: connection refused to :8765')).toMatch(/anki/i);
    });

    it('flags the daemon being unreachable', () => {
        expect(friendlySaviError('savi daemon: Failed to fetch')).toMatch(/daemon/i);
    });

    it('turns a missing episode into a capture hint', () => {
        expect(friendlySaviError("savi daemon: episode 'netflix:1' not found")).toMatch(/capture/i);
    });

    it('falls back to a safe generic for empty/unknown input', () => {
        expect(friendlySaviError(undefined)).toMatch(/try again/i);
        expect(friendlySaviError('')).toMatch(/try again/i);
        expect(friendlySaviError('totally novel situation 42')).toMatch(/try again/i);
    });
});
