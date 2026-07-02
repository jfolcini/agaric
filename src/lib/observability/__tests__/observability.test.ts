/**
 * Frontend observability unit tests (#2110, M3b).
 *
 * Drives the real pipeline end-to-end against a mocked Tauri IPC bridge: an
 * interaction span propagates a `traceparent` into `invoke()` and its finished
 * spans flush over `ingest_otel_spans`, sharing one trace id across the
 * frontend↔backend boundary. Also covers the off-by-default no-op path, id
 * shape, sampling, and the exporter's defensive caps.
 */

import { type Span, SpanStatusCode } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FrontendSpan } from '../../bindings'
import { commands } from '../../bindings'
import { getSamplingRatio, resolveEnabled, setSamplingRatio, shouldSampleRoot } from '../config'
import { generateSpanId, generateTraceId, isValidSpanId, isValidTraceId } from '../ids'
import {
  _resetFrontendObservabilityForTest,
  flushFrontendSpans,
  initFrontendObservability,
  setTraceSampling,
  traceInteraction,
} from '../index'
import { INTERACTIONS } from '../interactions'
import { _resetSpanSink, setSpanSink } from '../transport'

interface InvokeCall {
  cmd: string
  args: unknown
  options: { headers?: Record<string, string> } | undefined
}

/**
 * Install a fake Tauri internals bridge that records every invoke. Must be
 * called BEFORE `initFrontendObservability` so the invoke patch wraps it.
 */
function installFakeInternals(): InvokeCall[] {
  const calls: InvokeCall[] = []
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown, options?: unknown) => {
      calls.push({ cmd, args, options: options as InvokeCall['options'] })
      return Promise.resolve(null)
    },
    transformCallback: (cb: unknown) => cb,
  }
  return calls
}

/**
 * Call the (possibly patched) `window.__TAURI_INTERNALS__.invoke` directly —
 * exactly what `@tauri-apps/api/core` does in the real app and e2e. After init
 * this is the trace-injecting patch wrapping the fake recorder.
 */
function patchedInvoke(cmd: string, args?: unknown, options?: unknown): Promise<unknown> {
  return (
    window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown, o?: unknown) => Promise<unknown> }
    }
  ).__TAURI_INTERNALS__.invoke(cmd, args, options)
}

/** Override the IPC span sink with an in-memory capture (avoids real IPC). */
function captureSpans(): FrontendSpan[][] {
  const batches: FrontendSpan[][] = []
  setSpanSink((spans) => {
    batches.push(spans)
    return Promise.resolve(null)
  })
  return batches
}

afterEach(async () => {
  await _resetFrontendObservabilityForTest()
  setSamplingRatio(1)
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as unknown as { __AGARIC_OTEL__?: unknown }).__AGARIC_OTEL__
})

describe('w3c id generation', () => {
  it('generates 32-hex trace ids and 16-hex span ids', () => {
    for (let i = 0; i < 50; i++) {
      const t = generateTraceId()
      const s = generateSpanId()
      expect(t).toMatch(/^[0-9a-f]{32}$/)
      expect(s).toMatch(/^[0-9a-f]{16}$/)
      expect(isValidTraceId(t)).toBe(true)
      expect(isValidSpanId(s)).toBe(true)
    }
  })

  it('rejects all-zero and malformed ids', () => {
    expect(isValidTraceId('0'.repeat(32))).toBe(false)
    expect(isValidSpanId('0'.repeat(16))).toBe(false)
    expect(isValidTraceId('XYZ')).toBe(false)
    expect(isValidSpanId('abc')).toBe(false)
  })
})

describe('config / sampling', () => {
  it('is off by default', () => {
    expect(resolveEnabled()).toBe(false)
  })

  it('honours the window enablement hook', () => {
    ;(window as unknown as { __AGARIC_OTEL__: boolean }).__AGARIC_OTEL__ = true
    expect(resolveEnabled()).toBe(true)
  })

  it('clamps the sampling ratio and gates root decisions', () => {
    setSamplingRatio(2)
    expect(getSamplingRatio()).toBe(1)
    expect(shouldSampleRoot()).toBe(true)
    setSamplingRatio(-1)
    expect(getSamplingRatio()).toBe(0)
    expect(shouldSampleRoot()).toBe(false)
    setSamplingRatio(0.5)
    const draw = vi.spyOn(Math, 'random').mockReturnValue(0.4)
    expect(shouldSampleRoot()).toBe(true)
    draw.mockReturnValue(0.9)
    expect(shouldSampleRoot()).toBe(false)
    draw.mockRestore()
  })

  it('setTraceSampling (M5) drives both the frontend ratio and the backend command', async () => {
    const spy = vi
      .spyOn(commands, 'setTraceSampling')
      .mockResolvedValue({ status: 'ok', data: null })
    await setTraceSampling(0.25)
    expect(getSamplingRatio()).toBe(0.25) // frontend half
    expect(spy).toHaveBeenCalledWith(0.25) // backend half (one app-wide toggle)
    // Clamp applies on the frontend side too.
    await setTraceSampling(5)
    expect(getSamplingRatio()).toBe(1)
    spy.mockRestore()
  })

  it('setTraceSampling tolerates a missing IPC bridge (frontend half still applies)', async () => {
    const spy = vi.spyOn(commands, 'setTraceSampling').mockRejectedValue(new Error('no IPC'))
    await expect(setTraceSampling(0.5)).resolves.toBeUndefined()
    expect(getSamplingRatio()).toBe(0.5)
    spy.mockRestore()
  })
})

describe('disabled (default) is a zero-cost no-op', () => {
  it('runs the interaction body but emits no spans or headers', async () => {
    const calls = installFakeInternals()
    await initFrontendObservability({ enabled: false })
    const batches = captureSpans()

    const result = await traceInteraction(INTERACTIONS.SEARCH, async () => {
      await patchedInvoke('get_status', {})
      return 'value'
    })

    expect(result).toBe('value')
    // Disabled ⇒ no invoke patch installed ⇒ raw call, no traceparent.
    const getStatus = calls.find((c) => c.cmd === 'get_status')
    expect(getStatus).toBeDefined()
    expect(getStatus?.options?.headers).toBeUndefined()
    await flushFrontendSpans()
    expect(batches).toHaveLength(0)
  })
})

describe('enabled: end-to-end propagation + export', () => {
  it('injects a traceparent and exports a correlated span tree', async () => {
    const calls = installFakeInternals()
    await initFrontendObservability({ enabled: true })
    const batches = captureSpans()

    await traceInteraction(
      INTERACTIONS.PAGE_OPEN,
      async () => {
        await patchedInvoke('get_status', {})
      },
      { 'page.kind': 'daily' },
    )

    // The command invoke carried a W3C traceparent for the child span.
    const getStatus = calls.find((c) => c.cmd === 'get_status')
    expect(getStatus).toBeDefined()
    const traceparent = getStatus?.options?.headers?.['traceparent']
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    const [, tpTrace, tpSpan] = (traceparent as string).split('-')

    await flushFrontendSpans()

    const spans = batches.flat()
    // Interaction (root) + ipc child span.
    expect(spans.length).toBeGreaterThanOrEqual(2)
    // All spans share the interaction's trace id (the cross-boundary join key).
    expect(spans.every((s) => s.trace_id === tpTrace)).toBe(true)

    const root = spans.find((s) => s.name === INTERACTIONS.PAGE_OPEN)
    const child = spans.find((s) => s.name === 'ipc get_status')
    expect(root).toBeDefined()
    expect(child).toBeDefined()
    // The traceparent carried the child's span id, parented under the root.
    expect(child?.span_id).toBe(tpSpan)
    expect(child?.parent_span_id).toBe(root?.span_id)
    expect(root?.parent_span_id).toBeNull()
    expect(root?.status).toBe('ok')
    // Opaque interaction attribute survived.
    expect(root?.attributes).toContainEqual({ key: 'page.kind', value: 'daily' })
  })

  it('does not trace the ingest export itself (no recursion)', async () => {
    const calls = installFakeInternals()
    await initFrontendObservability({ enabled: true })
    captureSpans()
    await traceInteraction(INTERACTIONS.PALETTE_QUERY, async () => {
      await patchedInvoke('ingest_otel_spans', { spans: [] })
    })
    // The ingest call must not have carried a traceparent (it is UNTRACED).
    const ingest = calls.find((c) => c.cmd === 'ingest_otel_spans')
    expect(ingest).toBeDefined()
    expect(ingest?.options?.headers?.['traceparent']).toBeUndefined()
  })

  it('passes through invokes fired outside any interaction (no header)', async () => {
    const calls = installFakeInternals()
    await initFrontendObservability({ enabled: true })
    captureSpans()
    await patchedInvoke('get_status', {})
    const getStatus = calls.find((c) => c.cmd === 'get_status')
    expect(getStatus?.options?.headers).toBeUndefined()
  })
})

describe('traceInteraction: endError re-throws and records an error span', () => {
  it('a synchronous throw re-raises and flushes an ERROR-status span', async () => {
    await initFrontendObservability({ enabled: true })
    const batches = captureSpans()
    const boom = new Error('sync boom')

    // Spy on the live span so we can assert the exact exception + status calls.
    let recordException: ReturnType<typeof vi.spyOn> | undefined
    let setStatus: ReturnType<typeof vi.spyOn> | undefined

    // The call itself must throw synchronously — endError re-raises.
    expect(() =>
      traceInteraction(INTERACTIONS.SEARCH, (span: Span) => {
        recordException = vi.spyOn(span, 'recordException')
        setStatus = vi.spyOn(span, 'setStatus')
        throw boom
      }),
    ).toThrow(boom)

    expect(recordException).toHaveBeenCalledWith(boom)
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })

    await flushFrontendSpans()
    const spans = batches.flat()
    expect(spans).toHaveLength(1)
    // A regression that writes 'ok' (or drops the error) fails here.
    expect(spans[0]?.status).toBe('error')
  })

  it('a rejected promise re-rejects and flushes an ERROR-status span', async () => {
    await initFrontendObservability({ enabled: true })
    const batches = captureSpans()
    const boom = new Error('async boom')

    let recordException: ReturnType<typeof vi.spyOn> | undefined
    let setStatus: ReturnType<typeof vi.spyOn> | undefined

    const pending = traceInteraction(INTERACTIONS.SEARCH, (span: Span) => {
      recordException = vi.spyOn(span, 'recordException')
      setStatus = vi.spyOn(span, 'setStatus')
      return Promise.reject(boom)
    })

    // The returned promise must reject with the SAME error (not swallowed).
    await expect(pending).rejects.toBe(boom)

    expect(recordException).toHaveBeenCalledWith(boom)
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })

    await flushFrontendSpans()
    const spans = batches.flat()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.status).toBe('error')
  })
})

describe('exporter caps', () => {
  it('auto-flushes at the 128-span batch threshold', async () => {
    const { SpanExporter } = await import('../exporter')
    const batches: number[] = []
    setSpanSink((spans) => {
      batches.push(spans.length)
      return Promise.resolve(null)
    })
    const exporter = new SpanExporter()
    for (let i = 0; i < 600; i++) {
      exporter.enqueue({
        trace_id: generateTraceId(),
        span_id: generateSpanId(),
        parent_span_id: null,
        name: 'n',
        start_unix_millis: 0,
        end_unix_millis: 1,
        attributes: [],
        status: 'ok',
      })
    }
    await exporter.flush()
    // 600 spans → four auto-flushes of 128 + a final drain of 88. Every IPC
    // call stays well under the backend's 512-span cap.
    expect(batches).toEqual([128, 128, 128, 128, 88])
    expect(Math.max(...batches)).toBeLessThanOrEqual(512)
  })

  it('truncates per-span attributes to the 64 cap', async () => {
    const { SpanExporter } = await import('../exporter')
    const captured: FrontendSpan[] = []
    setSpanSink((spans) => {
      captured.push(...spans)
      return Promise.resolve(null)
    })
    const exporter = new SpanExporter()
    exporter.enqueue({
      trace_id: generateTraceId(),
      span_id: generateSpanId(),
      parent_span_id: null,
      name: 'n',
      start_unix_millis: 0,
      end_unix_millis: 1,
      attributes: Array.from({ length: 100 }, (_v, i) => ({ key: `k${i}`, value: `${i}` })),
      status: null,
    })
    await exporter.flush()
    const first = captured[0]
    expect(first).toBeDefined()
    expect(first ? first.attributes.length : -1).toBe(64)
  })
})

describe('exporter: coalescing timer + no-sink drain', () => {
  const makeSpan = (): FrontendSpan => ({
    trace_id: generateTraceId(),
    span_id: generateSpanId(),
    parent_span_id: null,
    name: 'n',
    start_unix_millis: 0,
    end_unix_millis: 1,
    attributes: [],
    status: 'ok',
  })

  it('flushes buffered spans exactly once when the 2000ms coalescing timer fires', async () => {
    vi.useFakeTimers()
    try {
      const { SpanExporter } = await import('../exporter')
      const batches: number[] = []
      setSpanSink((spans) => {
        batches.push(spans.length)
        return Promise.resolve(null)
      })
      const exporter = new SpanExporter()
      // Two sub-batch enqueues arm the single coalescing timer (no immediate
      // flush — well under the 128 MAX_BATCH threshold).
      exporter.enqueue(makeSpan())
      exporter.enqueue(makeSpan())
      expect(batches).toEqual([])

      // Nothing fires before the interval elapses.
      await vi.advanceTimersByTimeAsync(1999)
      expect(batches).toEqual([])

      // At 2000ms the timer fires ONCE, draining both spans in a single batch.
      await vi.advanceTimersByTimeAsync(1)
      expect(batches).toEqual([2])

      // The timer is not re-armed on an empty buffer — no further flushes.
      await vi.advanceTimersByTimeAsync(10000)
      expect(batches).toEqual([2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains and drops the buffer without error when no sink is configured', async () => {
    const { SpanExporter } = await import('../exporter')
    _resetSpanSink() // ensure getSpanSink() === null for this test
    const exporter = new SpanExporter()
    exporter.enqueue(makeSpan())
    exporter.enqueue(makeSpan())

    // No sink → flush resolves without throwing and empties the buffer.
    await expect(exporter.flush()).resolves.toBeUndefined()

    // Prove the spans were DROPPED (not retained): wiring a sink now and
    // flushing again sends nothing, because the buffer was already drained.
    const batches: number[] = []
    setSpanSink((spans) => {
      batches.push(spans.length)
      return Promise.resolve(null)
    })
    await exporter.flush()
    expect(batches).toEqual([])
  })
})
