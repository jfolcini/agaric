/**
 * Global "close all overlays" DOM event.
 *
 * Dispatched on `window` when the user presses the `closeOverlays` shortcut
 * (Escape by default; rebindable via keyboard-config). Any top-level overlay
 * component that is NOT managed by Radix (or any component that wants a
 * second dismiss path in addition to Radix's built-in Escape trap) can
 * listen for this event and close itself.
 *
 * This is a plain `CustomEvent` on `window` — no Zustand store, no React
 * Context — because the feature is a one-shot signal with no state, and we
 * want every subscriber (including detached overlays created via portals
 * outside the React tree) to react without any wiring.
 *
 * UX-228.
 */
export const CLOSE_ALL_OVERLAYS_EVENT = 'agaric:closeAllOverlays'
