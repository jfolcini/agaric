/**
 * Backend log transport seam (#761).
 *
 * Leaf module that decouples `logger.ts` from `tauri.ts`. The logger fires
 * warn/error entries at whatever sink is registered here; `tauri.ts` registers
 * its IPC `logFrontend` implementation at module-init time. Neither `logger`
 * nor `tauri` imports the other, so the previous logger<->tauri import cycle is
 * gone.
 *
 * The default sink is a no-op: before `tauri.ts` has been imported (or in
 * browser/test contexts where the Tauri IPC bridge is absent) backend logging
 * is silently skipped, exactly matching the prior fire-and-forget fallback.
 *
 * Constraint (#868): there is a lazy-sink seam here — any `logger.warn`/
 * `logger.error` fired at module-init time *before* `tauri.ts` registers its
 * sink is silently dropped by this default no-op. No such early call exists
 * today; this note is a guard-rail for future code that might log during
 * module evaluation and expect it to reach the backend.
 */

/**
 * A backend log sink. Mirrors `tauri.ts#logFrontend`. Must be fire-and-forget
 * safe: the logger awaits nothing and swallows rejection.
 */
export type LogBackendSink = (
  level: string,
  module: string,
  message: string,
  stack?: string | null,
  context?: string | null,
  data?: string | null,
) => Promise<void>

let sink: LogBackendSink | null = null

/** Register the backend log sink. Called once by `tauri.ts` at init. */
export function setLogBackendSink(next: LogBackendSink): void {
  sink = next
}

/** The currently registered sink, or `null` when none has been wired up. */
export function getLogBackendSink(): LogBackendSink | null {
  return sink
}
