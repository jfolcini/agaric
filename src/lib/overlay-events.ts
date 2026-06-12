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

/**
 * Global "show keyboard shortcuts" DOM event.
 *
 * Dispatched on `window` to open the keyboard-shortcuts reference sheet from
 * surfaces that can't reach the dialog state directly. The `?` keydown listener
 * in `useAppDialogs` deliberately ignores `?` while an editor is focused (so a
 * literal `?` is typed during outlining); this event is the editor-agnostic
 * path — the command palette's "Keyboard shortcuts" entry dispatches it so the
 * cheatsheet stays reachable whether or not an editor is focused (#922).
 *
 * Same one-shot-signal rationale as `CLOSE_ALL_OVERLAYS_EVENT`: a plain
 * `CustomEvent` on `window`, no store / context, so the always-mounted
 * dialog-state owner (`useAppDialogs`) can react from anywhere.
 */
export const SHOW_SHORTCUTS_EVENT = 'agaric:showShortcuts'
