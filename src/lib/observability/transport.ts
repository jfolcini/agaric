/**
 * Frontend-span IPC sink seam (#2110, M3b).
 *
 * Mirrors `logger-transport.ts`: a leaf module that decouples the tracer's
 * exporter from `bindings`/`tauri`. `initFrontendObservability` registers the
 * real `commands.ingestOtelSpans` IPC call here at init; the exporter fires
 * batched spans at whatever sink is registered.
 *
 * The default sink is **null** (no-op): before init has run, in browser/test
 * contexts without the Tauri IPC bridge, or whenever observability is disabled,
 * span flushes are silently dropped — exactly matching the fire-and-forget
 * posture of the backend log bridge.
 */

import type { FrontendSpan } from '@/lib/bindings'

/**
 * A frontend-span sink. Mirrors `commands.ingestOtelSpans`. Must be
 * fire-and-forget safe: the exporter awaits nothing and swallows rejection.
 */
export type SpanSink = (spans: FrontendSpan[]) => Promise<unknown>

let sink: SpanSink | null = null

/** Register the span IPC sink. Called once by `initFrontendObservability`. */
export function setSpanSink(next: SpanSink): void {
  sink = next
}

/** The currently registered sink, or `null` when none has been wired up. */
export function getSpanSink(): SpanSink | null {
  return sink
}

/** Clear the registered sink. Exported for testing only. @internal */
export function _resetSpanSink(): void {
  sink = null
}
