/**
 * IPC trace-context propagation patch (#2110, M3b).
 *
 * Tauri's `invoke()` (and therefore every tauri-specta binding) dispatches
 * through `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`
 * (`@tauri-apps/api/core` → core.js). Patching that single function once is the
 * cleanest global seam: it captures all ~112 invoke sites without a Vite alias
 * or touching the generated `bindings.ts`, and is trivially reversible.
 *
 * Behaviour, only while observability is enabled (the patch is installed by
 * `initFrontendObservability` only then):
 *
 *  - If a **sampled** frontend span is active (i.e. the call is inside a
 *    `traceInteraction`/`startActiveSpan` body), open a short child span
 *    `ipc <cmd>` parented to it, inject a W3C `traceparent` header carrying the
 *    *child's* context, and end the child when the IPC promise settles. The
 *    backend's `extract_trace_context` (M3a) then re-parents its command span
 *    under that child — yielding one trace: interaction → ipc <cmd> (frontend)
 *    → ipc.frontend (backend) → command/SQLite/materializer.
 *  - Otherwise the call passes through untouched (no header, no span).
 *
 * `ingest_otel_spans` is never instrumented — tracing its own export would
 * recurse. The command *name* is a compile-time identifier, never user data, so
 * using it as the span name is PII-safe.
 */

import { context as otelContext, type Span, SpanStatusCode, trace } from '@opentelemetry/api'

/** Instrumentation scope for invoke child spans. */
const SCOPE = 'agaric-frontend'

/** The IPC command whose own export must never be traced (recursion guard). */
const UNTRACED = new Set(['ingest_otel_spans'])

/** Marker so a double `install` is a no-op (idempotent across HMR/tests). */
const PATCHED = Symbol.for('agaric.otel.invoke.patched')

/** The shape of the Tauri internals we patch. */
interface TauriInternals {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>
  [PATCHED]?: boolean
}

/** Merge a `traceparent` value into an existing `HeadersInit`, non-destructively. */
function withTraceparent(options: unknown, traceparent: string): Record<string, unknown> {
  const opts = (options ?? {}) as Record<string, unknown>
  const existing = opts['headers']
  let headers: HeadersInit
  if (existing instanceof Headers) {
    const next = new Headers(existing)
    next.set('traceparent', traceparent)
    headers = next
  } else if (Array.isArray(existing)) {
    headers = [...(existing as [string, string][]), ['traceparent', traceparent]]
  } else if (existing && typeof existing === 'object') {
    headers = { ...(existing as Record<string, string>), traceparent }
  } else {
    headers = { traceparent }
  }
  return { ...opts, headers }
}

/** End `child` reflecting the IPC outcome, then re-raise on rejection. */
function settleChild<T>(child: Span, promise: Promise<T>): Promise<T> {
  return promise.then(
    (value) => {
      child.setStatus({ code: SpanStatusCode.OK })
      child.end()
      return value
    },
    (error: unknown) => {
      child.recordException(error as Error)
      child.setStatus({ code: SpanStatusCode.ERROR })
      child.end()
      throw error
    },
  )
}

/**
 * Install the invoke patch on `window.__TAURI_INTERNALS__`. Idempotent; a no-op
 * when the internals bridge is absent (browser dev / unit tests without Tauri).
 * Returns a disposer that restores the original invoke (used by tests).
 */
export function installInvokePatch(): () => void {
  if (typeof window === 'undefined') return () => {}
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') return () => {}
  if (internals[PATCHED]) return () => {}

  const original = internals.invoke.bind(internals)
  internals[PATCHED] = true

  internals.invoke = (cmd: string, args?: unknown, options?: unknown): Promise<unknown> => {
    const active = trace.getActiveSpan()
    if (UNTRACED.has(cmd) || !active || !active.isRecording()) {
      return original(cmd, args, options)
    }
    // Child span under the active interaction; its context is what we propagate.
    const child = trace.getTracer(SCOPE).startSpan(`ipc ${cmd}`, undefined, otelContext.active())
    const sc = child.spanContext()
    const traceparent = `00-${sc.traceId}-${sc.spanId}-0${sc.traceFlags & 1}`
    return settleChild(child, original(cmd, args, withTraceparent(options, traceparent)))
  }

  return () => {
    internals.invoke = original
    internals[PATCHED] = false
  }
}
