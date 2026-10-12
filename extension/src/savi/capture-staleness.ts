// Only authoritative lifecycle evidence may retire a stored capture.
// A missing reply (including a frozen tab or a start handshake) is not evidence
// that the owner stopped recording.
import { captureState } from './daemon-client';
import type { SaviDaemonConfig } from './daemon-client';
import type { CaptureSessionRecord } from './capture-session';

export interface CaptureDocumentContext {
    readonly documentId?: string;
    readonly frameId?: number;
}

export const isStaleCaptureSession = async (
    session: CaptureSessionRecord,
    _requestedEpisodeId: string,
    requestingTabId: number,
    config: SaviDaemonConfig,
    requestingDocument?: CaptureDocumentContext
): Promise<boolean> => {
    try {
        await browser.tabs.get(session.tabId);
    } catch {
        // A failed lookup can also be a transient browser API error. Confirm
        // absence through the tab inventory before retiring a recording.
        try {
            const tabs = await browser.tabs.query({});
            if (!tabs.some((tab) => tab.id === session.tabId)) return true;
        } catch {
            // Unknown: retain the record unless the daemon confirms it ended.
        }
    }

    // A reload replaces the document within the SAME frame. A different frame
    // or another video in the same document cannot evict the current owner.
    // Older stored sessions/browsers without this metadata remain conservative:
    // explicitly Stop before starting again, or let the daemon reconcile them.
    if (
        session.tabId === requestingTabId &&
        session.frameId !== undefined &&
        session.frameId === requestingDocument?.frameId &&
        session.documentId !== undefined &&
        requestingDocument?.documentId !== undefined &&
        session.documentId !== requestingDocument.documentId
    ) {
        return true;
    }

    const active = await captureState(config);
    return active !== undefined && !active.includes(session.episodeId);
};
