/**
 * E2E — frontend OpenTelemetry tracing (#2110, M3b/M4).
 *
 * Exercises the REAL frontend tracer through the production-shaped e2e bundle
 * (VITE_E2E build + tauri-mock), not a unit harness. Observability is off by
 * default, so the spec opts in by setting `window.__AGARIC_OTEL__ = true` via
 * an init script before the app boots — the same hook `resolveEnabled()` reads.
 *
 * What it proves end-to-end:
 *  - performing a real interaction (typing a search) opens a `search`
 *    interaction span and, via the invoke patch, an `ipc search_blocks` child;
 *  - the finished spans are batched and exported over the `ingest_otel_spans`
 *    IPC command (the only egress — a local file on the real backend);
 *  - the child shares the root's `trace_id` and is parented under it — the
 *    cross-boundary correlation the whole feature exists for;
 *  - PII discipline: the typed query never appears in any exported span.
 *
 * The IPC recorder wraps the live (already trace-patched) mock `invoke`, so it
 * sees both the `search_blocks` call and the `ingest_otel_spans` export payload.
 */

import { expect, getInvokeCalls, installIpcRecorder, openSearchView, test } from './helpers'

interface ExportedSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
}

test.describe('frontend OTel tracing (#2110)', () => {
  test.beforeEach(async ({ page }) => {
    // Opt in before any app script runs (off by default).
    await page.addInitScript(() => {
      ;(window as unknown as { __AGARIC_OTEL__?: boolean }).__AGARIC_OTEL__ = true
    })
  })

  test('search interaction exports a correlated frontend span tree', async ({ page }) => {
    const input = await openSearchView(page)
    await installIpcRecorder(page)

    await input.fill('welcome')
    await input.press('Enter')

    // The search interaction dispatched its command…
    await expect
      .poll(async () => (await getInvokeCalls(page, 'search_blocks')).length)
      .toBeGreaterThan(0)

    // …and the finished spans flushed over the ingest command (coalesced ≤2s).
    await expect
      .poll(async () => (await getInvokeCalls(page, 'ingest_otel_spans')).length, {
        timeout: 8000,
      })
      .toBeGreaterThan(0)

    const ingestCalls = await getInvokeCalls(page, 'ingest_otel_spans')
    const spans = ingestCalls.flatMap((c) => (c['spans'] as ExportedSpan[]) ?? [])

    const root = spans.find((s) => s.name === 'search')
    const child = spans.find((s) => s.name === 'ipc search_blocks')
    expect(root, 'search interaction root span was exported').toBeTruthy()
    expect(child, 'ipc child span was exported').toBeTruthy()

    // One correlated trace across the would-be IPC boundary.
    expect(child?.trace_id).toBe(root?.trace_id)
    expect(child?.parent_span_id).toBe(root?.span_id)
    expect(root?.parent_span_id).toBeNull()
    // W3C id shapes.
    expect(root?.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(child?.span_id).toMatch(/^[0-9a-f]{16}$/)

    // PII discipline: the typed query is never carried in a span.
    expect(JSON.stringify(spans)).not.toContain('welcome')
  })

  test('is off by default — no spans exported without the opt-in', async ({ page }) => {
    // Override the beforeEach opt-in: disable for this case.
    await page.addInitScript(() => {
      ;(window as unknown as { __AGARIC_OTEL__?: boolean }).__AGARIC_OTEL__ = false
    })
    const input = await openSearchView(page)
    await installIpcRecorder(page)
    await input.fill('welcome')
    await input.press('Enter')
    await expect
      .poll(async () => (await getInvokeCalls(page, 'search_blocks')).length)
      .toBeGreaterThan(0)
    // When disabled the tracer never registers an exporter, so nothing can ever
    // call `ingest_otel_spans` — there is no flush timer to wait on. The check is
    // race-free immediately after the search IPC is observed (no `waitForTimeout`).
    expect(await getInvokeCalls(page, 'ingest_otel_spans')).toHaveLength(0)
  })
})
