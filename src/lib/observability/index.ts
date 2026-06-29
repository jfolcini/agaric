/**
 * Frontend observability public API (#2110, M3b).
 *
 * The only surface the rest of the app imports. Two guarantees shape it:
 *
 *  - **Off by default, zero cost when off.** [`initFrontendObservability`]
 *    registers the custom tracer provider + context manager only when enabled
 *    (see `./config`). Until then `@opentelemetry/api`'s built-in no-op tracer
 *    answers `trace.getTracer(...)`, so [`traceInteraction`] runs its callback
 *    directly with a non-recording span — no allocation, no IPC.
 *  - **Lazy.** The custom SDK (`./tracer`, `./invoke`) and the generated
 *    `bindings` are pulled in via dynamic `import()` *inside* init and only when
 *    enabled, so a disabled build never ships their cost on the hot path.
 *
 * Instrumentation uses the standard API shape: `traceInteraction(name, fn)`
 * wraps a top-level interaction (page open, edit commit, search) in an active
 * span; any `invoke()` dispatched synchronously inside `fn` is auto-parented and
 * propagated to the backend by the invoke patch.
 */

import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api'

import { resolveEnabled, setSamplingRatio } from './config'

export { getSamplingRatio, setSamplingRatio } from './config'
export { INTERACTIONS, type InteractionName } from './interactions'

/** Instrumentation scope name — the backend tags these `service.name=agaric-frontend`. */
const SCOPE = 'agaric-frontend'

let initialized = false
let exporter: { flush: () => Promise<void> } | null = null

/**
 * Initialise the frontend tracer if observability is enabled. Idempotent and
 * safe to call unconditionally at app start. Resolves once the pipeline is
 * registered (or immediately when disabled). `opts.enabled` forces the decision
 * (tests); otherwise the build/runtime gate decides.
 */
export async function initFrontendObservability(opts?: { enabled?: boolean }): Promise<void> {
  if (initialized) return
  const enabled = opts?.enabled ?? resolveEnabled()
  if (!enabled) return
  initialized = true

  const [
    { FrontendTracerProvider, StackContextManager },
    { installInvokePatch },
    transport,
    { commands },
  ] = await Promise.all([
    import('./tracer'),
    import('./invoke'),
    import('./transport'),
    import('../bindings'),
  ])

  context.setGlobalContextManager(new StackContextManager())
  const provider = new FrontendTracerProvider()
  trace.setGlobalTracerProvider(provider)
  exporter = provider.exporter

  // Wire the IPC sink — the generated command is the only egress (local file).
  transport.setSpanSink((spans) => commands.ingestOtelSpans(spans))
  installInvokePatch()

  // Flush trailing spans when the page is backgrounded/closed so an in-flight
  // interaction's spans are not lost on exit.
  if (typeof window !== 'undefined') {
    const flush = () => {
      void provider.exporter.flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
}

/** Settle `span` from a sync result, returning it unchanged. */
function endOk<T>(span: Span, result: T): T {
  span.setStatus({ code: SpanStatusCode.OK })
  span.end()
  return result
}

/** Settle `span` from a failure, then re-raise. */
function endError(span: Span, error: unknown): never {
  span.recordException(error as Error)
  span.setStatus({ code: SpanStatusCode.ERROR })
  span.end()
  throw error
}

/**
 * Trace a top-level user interaction. Opens an active span named `name` (with
 * optional opaque `attributes` — ids/counts/enums only, never content), runs
 * `fn`, and ends the span on completion — awaiting and reflecting the outcome
 * when `fn` returns a promise.
 *
 * When observability is disabled this is a thin pass-through: the no-op tracer
 * still invokes `fn` and returns its result, so call sites need no guard.
 *
 * NB: `invoke()` calls must be dispatched **synchronously** within `fn` (before
 * any `await`) to be auto-parented — the stack context manager does not cross
 * raw `await` boundaries (a deliberate WebKit-portability trade-off).
 */
export function traceInteraction<T>(
  name: string,
  fn: (span: Span) => T,
  attributes?: Record<string, string | number | boolean>,
): T {
  return trace.getTracer(SCOPE).startActiveSpan(name, (span) => {
    if (attributes) span.setAttributes(attributes)
    let result: T
    try {
      result = fn(span)
    } catch (error) {
      return endError(span, error)
    }
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (value) => endOk(span, value),
        (error) => endError(span, error),
      ) as unknown as T
    }
    return endOk(span, result)
  })
}

/** Force-flush buffered spans to the backend. Best-effort; resolves when sent. */
export async function flushFrontendSpans(): Promise<void> {
  await exporter?.flush()
}

/**
 * Set the trace head-sampling ratio app-wide (#2110, M5) — the single
 * sampling↔full-tracing toggle. Applies the ratio to the frontend tracer
 * locally AND drives the backend's runtime sampler via the `set_trace_sampling`
 * command, so one call switches both halves (`1` = trace everything, `0.1` =
 * sample a tenth, `0` = drop new roots). Clamped to `[0, 1]` on both sides.
 *
 * The backend hop is best-effort: in a browser/test context without the IPC
 * bridge it is swallowed and only the frontend half applies.
 */
export async function setTraceSampling(ratio: number): Promise<void> {
  setSamplingRatio(ratio)
  try {
    const { commands } = await import('../bindings')
    await commands.setTraceSampling(ratio)
  } catch {
    // IPC unavailable (browser dev / tests) — frontend half is already applied.
  }
}

/** Whether the tracer has been initialised (enabled + registered). @internal */
export function isFrontendObservabilityInitialized(): boolean {
  return initialized
}

/**
 * Tear down global tracer state. Test-only — restores the API to its no-op
 * defaults so a subsequent `initFrontendObservability` re-registers cleanly.
 * @internal
 */
export async function _resetFrontendObservabilityForTest(): Promise<void> {
  trace.disable()
  context.disable()
  const { _resetSpanSink } = await import('./transport')
  _resetSpanSink()
  initialized = false
  exporter = null
}
