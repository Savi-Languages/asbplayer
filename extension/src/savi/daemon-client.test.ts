import { browserHintFromUserAgent } from './daemon-client';

describe('browserHintFromUserAgent', () => {
    it('hints only DISTINGUISHABLE browsers', () => {
        expect(
            browserHintFromUserAgent(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87'
            )
        ).toBe('edge');
        expect(
            browserHintFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0')
        ).toBe('firefox');
        expect(
            browserHintFromUserAgent(
                'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Vivaldi/6.8'
            )
        ).toBe('vivaldi');
    });

    it('never hints for the Chrome UA — Chromium forks (Brave, Arc) masquerade as Chrome, and a wrong narrow hint would miss their audio', () => {
        expect(
            browserHintFromUserAgent(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            )
        ).toBeUndefined();
        expect(browserHintFromUserAgent('')).toBeUndefined();
    });
});
