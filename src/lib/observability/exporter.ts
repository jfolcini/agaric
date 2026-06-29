/**
 * Batching IPC span exporter for the frontend tracer (#2110, M3b).
 *
 * Finished spans are enqueued here and flushed to the backend `traces/` sink in
 * batches over the `ingestOtelSpans` IPC command (registered via
 * [`transport.setSpanSink`]). Batching keeps the IPC chatter bounded: a flush
 * fires when the buffer reaches [`MAX_BATCH`], after [`FLUSH_INTERVAL_MS`] of
 * inactivity (a coalescing timer), or on an explicit [`SpanExporter.flush`]
 * (called at page hide so an interaction's trailing spans are not lost).
 *
 * The exporter is intentionally dumb about span *content* — it receives
 * already-shaped [`FrontendSpan`] records and only enforces the backend's two
 * hard caps defensively: ≤512 spans per IPC call (chunked) and ≤64 attributes
 * per span (truncated). Everything PII-relevant is the producer's job, enforced
 * by the M4 guard.
 */

import type { FrontendSpan } from '../bindings'
import { getSpanSink } from './transport'

/** Flush when this many spans have accumulated (well under the 512 IPC cap). */
const MAX_BATCH = 128

/** Coalescing flush delay: trailing spans flush within this window. */
const FLUSH_INTERVAL_MS = 2000

/** Backend hard cap — max spans accepted per `ingest_otel_spans` call. */
const MAX_SPANS_PER_CALL = 512

/** Backend hard cap — max attributes retained per span. */
const MAX_ATTRS_PER_SPAN = 64

/** Split `items` into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/** Defensively clamp a span to the backend's per-span attribute cap. */
function clampAttrs(span: FrontendSpan): FrontendSpan {
  if (span.attributes.length <= MAX_ATTRS_PER_SPAN) return span
  return { ...span, attributes: span.attributes.slice(0, MAX_ATTRS_PER_SPAN) }
}

/**
 * Buffers finished spans and flushes them to the IPC sink in bounded batches.
 *
 * A single instance is owned by the tracer provider for the app lifetime. When
 * no sink is registered (observability off / pre-init) `flush` drops the buffer
 * silently — the producer side is already gated off in that case, so this is
 * only a defensive backstop.
 */
export class SpanExporter {
  private buffer: FrontendSpan[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  /** Enqueue one finished span, scheduling/forcing a flush as needed. */
  enqueue(span: FrontendSpan): void {
    this.buffer.push(clampAttrs(span))
    if (this.buffer.length >= MAX_BATCH) {
      void this.flush()
      return
    }
    this.scheduleFlush()
  }

  /** Arm the coalescing flush timer if it is not already running. */
  private scheduleFlush(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, FLUSH_INTERVAL_MS)
  }

  /**
   * Drain the buffer to the IPC sink. Fire-and-forget: rejections are swallowed
   * (a failed trace export must never surface to the user or recurse). Returns
   * the in-flight IPC promise(s) so callers/tests can await completion.
   */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return
    const sink = getSpanSink()
    const drained = this.buffer
    this.buffer = []
    if (!sink) return
    // Honour the backend's ≤512-spans-per-call cap by chunking large drains.
    await Promise.all(
      chunk(drained, MAX_SPANS_PER_CALL).map((spans) =>
        // Intentional swallow: trace export is best-effort and must not throw
        // into the app or recurse through logging. (AGENTS.md no-silent-catch
        // carve-out, same as the logger's backend bridge.)
        Promise.resolve(sink(spans)).catch(() => {}),
      ),
    )
  }
}
