/** Keep Netflix tracking-query churn separate from real source navigation.
 * Other sites retain exact URL matching because their query can identify media.
 * Player identity and request-token checks remain the caller's responsibility. */
export function subtitleSourceMatchesUrl(source: string | undefined, current: string): boolean {
    if (source === undefined || source === current) return true;
    try {
        const a = new URL(source);
        const b = new URL(current);
        return (
            a.origin === b.origin &&
            (a.hostname === 'netflix.com' || a.hostname.endsWith('.netflix.com')) &&
            /^\/watch\/\d+\/?$/.test(a.pathname) &&
            a.pathname === b.pathname
        );
    } catch {
        return false;
    }
}
