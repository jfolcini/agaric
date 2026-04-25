/**
 * Global "report a bug" DOM event.
 *
 * Dispatched on `window` when a section-level error boundary
 * (`FeatureErrorBoundary`) wants to surface the in-app bug-report dialog
 * with the captured error message + stack pre-filled. Any top-level
 * component that mounts a `BugReportDialog` can listen for this event and
 * open the dialog with the supplied detail.
 *
 * This is a plain `CustomEvent` on `window` — no Zustand store, no React
 * Context — because the feature is a one-shot signal that must cross from
 * a class component (the boundary) up into the App-level dialog mount
 * without prop-drilling. Mirrors the `overlay-events.ts` pattern.
 *
 * UX-279.
 */

export const BUG_REPORT_EVENT = 'agaric:report-bug'

export interface BugReportEventDetail {
  /** The error message to pre-fill as the report title. */
  message: string
  /** Optional stack trace to pre-fill as the report description. */
  stack?: string
}

/**
 * Dispatch a `BUG_REPORT_EVENT` on `window` with the given detail. Callers
 * should prefer this helper over `window.dispatchEvent(new CustomEvent(...))`
 * so the event name and detail shape stay in lockstep with listeners.
 */
export function dispatchBugReport(detail: BugReportEventDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<BugReportEventDetail>(BUG_REPORT_EVENT, { detail }))
}
