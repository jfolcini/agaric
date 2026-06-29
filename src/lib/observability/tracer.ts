/**
 * A minimal custom OpenTelemetry SDK for the frontend (#2110, M3b).
 *
 * The maintainer chose **`@opentelemetry/api` + a custom IPC exporter** over the
 * full `@opentelemetry/sdk-trace-web` (bundle size + WebKit portability — the
 * web SDK's zone/context machinery and auto-instrumentation are Chromium-leaning
 * and pull tens of KB). So this file implements just enough of the API's `Span`
 * / `Tracer` / `TracerProvider` / `ContextManager` contracts to:
 *
 *  - produce W3C-correct spans (real 128/64-bit ids via [`./ids`]),
 *  - propagate context **synchronously** through a stack context manager
 *    (`startActiveSpan(name, fn)` sets the active span for the synchronous body
 *    of `fn` — which is where `invoke()` is dispatched, so the invoke patch
 *    reads the right parent), and
 *  - convert finished, sampled spans into [`FrontendSpan`] records and hand them
 *    to the batching [`SpanExporter`].
 *
 * Deliberately **not** implemented: async context propagation across raw
 * `await` (needs zone.js — out for WebKit), span events/links export (the
 * backend `FrontendSpan` carries none), and metrics. `addEvent`/`addLink` are
 * accepted (API-conformant) but not exported.
 *
 * When `setGlobalTracerProvider` is never called (observability off), the API's
 * built-in no-op tracer answers `trace.getTracer(...)`, so all of the above is
 * bypassed for zero cost.
 */

import {
  type Context,
  type ContextManager,
  context as otelContext,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  SpanStatusCode,
  type TimeInput,
  trace,
  type Tracer,
  type TracerProvider,
  TraceFlags,
} from '@opentelemetry/api'

import type { FrontendSpan, FrontendSpanAttr } from '../bindings'
import { shouldSampleRoot } from './config'
import { SpanExporter } from './exporter'
import { generateSpanId, generateTraceId } from './ids'

/** Epoch-millis wall clock matching the backend's `start_unix_millis`. */
function nowEpochMillis(): number {
  // `timeOrigin + now()` is monotonic-derived but epoch-anchored — the portable
  // high-resolution wall clock available on every webview target.
  return performance.timeOrigin + performance.now()
}

/** Coerce an API attribute value to the opaque string the backend stores. */
function attrValueToString(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',')
  return String(value)
}

/** Map an API span status to the backend's optional status string. */
function statusToString(code: SpanStatusCode): string | null {
  if (code === SpanStatusCode.OK) return 'ok'
  if (code === SpanStatusCode.ERROR) return 'error'
  return null
}

/**
 * A recording span. Holds the W3C context + opaque attributes, and on [`end`]
 * converts itself to a [`FrontendSpan`] and enqueues it on the exporter.
 *
 * Implements the API `Span` surface; the mutators are chainable no-ops where the
 * backend record has no corresponding field (`addEvent`, `addLink`).
 */
class RecordingSpan implements Span {
  private readonly ctx: SpanContext
  private readonly parentSpanId: string | null
  private readonly startMillis: number
  private name: string
  private readonly attributes = new Map<string, string>()
  private statusCode: SpanStatusCode = SpanStatusCode.UNSET
  private ended = false
  private readonly exporter: SpanExporter

  constructor(ctx: SpanContext, parentSpanId: string | null, name: string, exporter: SpanExporter) {
    this.ctx = ctx
    this.parentSpanId = parentSpanId
    this.name = name
    this.exporter = exporter
    this.startMillis = nowEpochMillis()
  }

  spanContext(): SpanContext {
    return this.ctx
  }

  setAttribute(key: string, value: unknown): this {
    if (!this.ended) this.attributes.set(key, attrValueToString(value))
    return this
  }

  setAttributes(attributes: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(attributes)) this.setAttribute(k, v)
    return this
  }

  // The backend FrontendSpan carries no events/links; accept for API
  // conformance but do not export them.
  addEvent(): this {
    return this
  }

  addLink(): this {
    return this
  }

  addLinks(): this {
    return this
  }

  setStatus(status: SpanStatus): this {
    if (!this.ended) this.statusCode = status.code
    return this
  }

  updateName(name: string): this {
    if (!this.ended) this.name = name
    return this
  }

  isRecording(): boolean {
    return !this.ended
  }

  recordException(exception: unknown): void {
    // Surface the failure as an error status; the message is NOT exported
    // (PII discipline — exception text may carry content). Errors always count.
    this.statusCode = SpanStatusCode.ERROR
    void exception
  }

  end(_endTime?: TimeInput): void {
    if (this.ended) return
    this.ended = true
    const attributes: FrontendSpanAttr[] = []
    for (const [key, value] of this.attributes) attributes.push({ key, value })
    const record: FrontendSpan = {
      trace_id: this.ctx.traceId,
      span_id: this.ctx.spanId,
      parent_span_id: this.parentSpanId,
      name: this.name,
      start_unix_millis: this.startMillis,
      end_unix_millis: nowEpochMillis(),
      attributes,
      status: statusToString(this.statusCode),
    }
    this.exporter.enqueue(record)
  }
}

/** Whether a span context is present, valid, and sampled. */
function isValidSampled(ctx: SpanContext | undefined): boolean {
  return (
    ctx !== undefined &&
    /^[0-9a-f]{32}$/.test(ctx.traceId) &&
    ctx.traceId !== '0'.repeat(32) &&
    (ctx.traceFlags & TraceFlags.SAMPLED) !== 0
  )
}

/**
 * The frontend tracer. One instance is shared across instrumentation scopes
 * (the backend tags everything `service.name=agaric-frontend`, so the scope
 * name is not surfaced in the `FrontendSpan` record).
 */
class FrontendTracer implements Tracer {
  private readonly exporter: SpanExporter

  constructor(exporter: SpanExporter) {
    this.exporter = exporter
  }

  startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
    const parentCtx = trace.getSpan(ctx ?? otelContext.active())?.spanContext()
    const parentSampled = isValidSampled(parentCtx)

    // Sampling: inherit a sampled parent; for a root, take the head decision.
    // A non-sampled root (or any child of one) yields a non-recording span —
    // children still share the trace id (so a later sampled sibling can join)
    // but nothing is exported.
    const sampled = parentSampled || (parentCtx === undefined && shouldSampleRoot())

    const traceId = parentCtx?.traceId ?? generateTraceId()
    const spanId = generateSpanId()
    const parentSpanId = parentCtx?.spanId ?? null

    const newCtx: SpanContext = {
      traceId,
      spanId,
      traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: false,
    }

    if (!sampled) {
      // Non-recording: API helper wraps a context without allocating a recorder.
      return trace.wrapSpanContext(newCtx)
    }
    void options
    return new RecordingSpan(newCtx, parentSpanId, name, this.exporter)
  }

  // startActiveSpan overloads (API contract): (name, fn) | (name, opts, fn) |
  // (name, opts, ctx, fn). We normalise and run `fn` with the new span active.
  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    arg2: SpanOptions | F,
    arg3?: Context | F,
    arg4?: F,
  ): ReturnType<F> {
    let options: SpanOptions | undefined
    let ctx: Context | undefined
    let fn: F
    if (typeof arg2 === 'function') {
      fn = arg2
    } else if (typeof arg3 === 'function') {
      options = arg2
      fn = arg3
    } else {
      options = arg2
      ctx = arg3
      fn = arg4 as F
    }
    const span = this.startSpan(name, options, ctx)
    const activeCtx = trace.setSpan(ctx ?? otelContext.active(), span)
    return otelContext.with(activeCtx, () => fn(span)) as ReturnType<F>
  }
}

/** The provider handed to `trace.setGlobalTracerProvider`. Owns the exporter. */
export class FrontendTracerProvider implements TracerProvider {
  readonly exporter: SpanExporter
  private readonly tracer: FrontendTracer

  constructor() {
    this.exporter = new SpanExporter()
    this.tracer = new FrontendTracer(this.exporter)
  }

  getTracer(_name: string, _version?: string): Tracer {
    return this.tracer
  }
}

/**
 * A synchronous stack context manager (API `ContextManager`).
 *
 * `with(ctx, fn)` makes `ctx` active for the synchronous duration of `fn` and
 * restores the previous context afterwards. This is the web SDK's
 * `StackContextManager` behaviour minus the (Chromium-oriented) event-target
 * binding — sufficient because the frontend dispatches `invoke()`
 * synchronously inside its interaction callback, so the active span is correct
 * at the moment the invoke patch reads it. Context is intentionally NOT
 * propagated across raw `await` (that needs zone.js).
 */
export class StackContextManager implements ContextManager {
  private current: Context = ROOT_CONTEXT

  active(): Context {
    return this.current
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.current
    this.current = ctx
    try {
      return fn.call(thisArg as ThisParameterType<F>, ...args)
    } finally {
      this.current = previous
    }
  }

  bind<T>(_ctx: Context, target: T): T {
    return target
  }

  enable(): this {
    return this
  }

  disable(): this {
    this.current = ROOT_CONTEXT
    return this
  }
}
