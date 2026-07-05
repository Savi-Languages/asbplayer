// Map a raw daemon / AnkiConnect / network error string to a short, friendly,
// user-facing message — savi's equivalent of StylesGo's `userFriendlyError`.
//
// Rule (Lesson 4): never surface a raw `e.message`/`e.toString()` to the user.
// Daemon errors arrive prefixed "savi daemon: <reason>"; AnkiConnect failures
// arrive as "AnkiConnect: <reason>". This collapses the noise into something a
// learner can act on, and is deliberately total — any unknown input maps to a
// safe generic.

export function friendlySaviError(raw: string | undefined): string {
    const m = (raw ?? '').toLowerCase();

    if (!m) {
        return 'Something went wrong — try again';
    }
    if (/duplicate/.test(m)) {
        return 'Already in Anki';
    }
    if (/url\/token not set|not[- ]configured/.test(m)) {
        return 'Set the savi daemon URL + token in settings';
    }
    if (/deck was not found|model.*not found|collection is not open|anki.*not (running|open)|ankiconnect|:8765|econnrefused.*8765/.test(m)) {
        return 'Is Anki open? (AnkiConnect unreachable)';
    }
    if (/failed to fetch|networkerror|load failed|unreachable|:4030|daemon: \d|connection refused|econnrefused/.test(m)) {
        return "Can't reach the savi daemon — is it running?";
    }
    if (/no such file|episode.*not found|not found/.test(m)) {
        return 'Capture this episode first to add audio';
    }
    if (/ffmpeg|io error|io:/.test(m)) {
        return "Couldn't clip the audio — added without it";
    }
    return 'Something went wrong — try again';
}
