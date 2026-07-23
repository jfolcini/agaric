/**
 * Tauri mock handlers -- Diagnostics, logging, recovery, and draft bookkeeping.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import { type TypedHandlers, returnEmptyArray, returnNull } from '@/lib/tauri-mock/handlers/shared'

export const systemHandlers = {
  // #2110 M3b — OpenTelemetry frontend-span ingest. Off by default; the frontend
  // tracer only invokes it when observability is enabled, which the default e2e
  // runs never are, so the mock is a no-op that accepts the batch and returns
  // `Ok(())` (serialized as `null`). Keeps the handlers-drift guard satisfied
  // until the frontend producer + its own e2e coverage land.
  ingest_otel_spans: () => null,

  // #2110 M5 — runtime sampling↔full-tracing toggle. Sets a process-global ratio
  // on the real backend; in the mock it is a no-op that returns `Ok(())` (`null`).
  set_trace_sampling: () => null,

  // ---------------------------------------------------------------------------
  // Block listing & CRUD
  // ---------------------------------------------------------------------------

  get_status: () => ({
    foreground_queue_depth: 0,
    background_queue_depth: 0,
    total_ops_dispatched: 0,
    total_background_dispatched: 0,
    fg_high_water: 0,
    bg_high_water: 0,
    fg_errors: 0,
    bg_errors: 0,
    fg_panics: 0,
    bg_panics: 0,
  }),

  // ---------------------------------------------------------------------------
  // Properties & tags queries
  // ---------------------------------------------------------------------------

  // #1255 — boot-recovery status. The mock represents a clean dev boot, so
  // replay never fails: always report a healthy (non-degraded) status.
  get_recovery_status: () => ({ degraded: false, replay_errors: [] }),

  // ---------------------------------------------------------------------------
  // Peer address
  // ---------------------------------------------------------------------------

  log_frontend: returnNull,
  get_log_dir: () => '/mock/logs',

  // ---------------------------------------------------------------------------
  // Bug report
  // ---------------------------------------------------------------------------

  collect_bug_report_metadata: () => ({
    app_version: '0.1.0',
    os: 'mock',
    arch: 'mock',
    device_id: 'mock-device-id',
    recent_errors: [],
  }),

  read_logs_for_report: () => [],

  // ---------------------------------------------------------------------------
  // Op log compaction commands
  // ---------------------------------------------------------------------------

  save_draft: returnNull,
  flush_draft: returnNull,
  delete_draft: returnNull,

  list_drafts: returnEmptyArray,

  // Boot recovery uses a single IPC. The mock has
  // no in-memory drafts map (existing `list_drafts: returnEmptyArray`
  // is the canonical source-of-truth shape), so `flushed` is always 0.
  flush_all_drafts: () => ({ flushed: 0 }),
} satisfies Pick<
  TypedHandlers,
  | 'ingest_otel_spans'
  | 'set_trace_sampling'
  | 'get_status'
  | 'get_recovery_status'
  | 'log_frontend'
  | 'get_log_dir'
  | 'collect_bug_report_metadata'
  | 'read_logs_for_report'
  | 'save_draft'
  | 'flush_draft'
  | 'delete_draft'
  | 'list_drafts'
  | 'flush_all_drafts'
>
