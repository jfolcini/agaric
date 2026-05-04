# PEND-22 — Frontend robustness review: confirmed non-nit findings

## TL;DR

Two confirmed gaps surfaced by a two-round JS/TS robustness review (6 parallel
Round-1 reviewers across stores / editor / hooks / lib / components, then 4
Round-2 validation subagents that re-checked 40 raw findings against actual
source). After validation, **30 of 40 raw findings were false positives** and
**6 were exaggerations** — the codebase is generally well-guarded. The two
items below are the only confirmed, non-nit issues that actually deserve a
fix:

1. **`graph-worker.ts` — no try/catch around the worker's `message`
   dispatcher and no structured error message back to the main thread.** The
   main thread already listens for the worker's `error` / `messageerror`
   events (`runWorkerSimulation` in `src/lib/graph-sim-helpers.ts`), and the
   `useGraphWorkerSimulation` hook flips `workerFailed = true` on any boundary
   failure to fall back to the main-thread simulation. So the safety net
   exists for "loud" failures. The remaining gap is **errors thrown inside
   d3-force tick/end callbacks** (e.g., a corrupted node makes
   `self.postMessage` throw on serialization), which may not propagate to the
   worker boundary `error` event on every runtime. Wrapping the dispatcher
   and posting an explicit error message closes this hole and gives the main
   thread a richer signal than "unknown failure".

2. **`useQueryExecution.fetchResults` — no `cancelled` / request-id guard,
   so a slow in-flight fetch can clobber the results of a faster newer
   fetch.** When `expression` or `currentSpaceId` changes the effect re-runs,
   but the previous call still applies its results via `applyQueryResult` and
   `mergePageTitles`. Worst case is transient UI flicker on rapid query
   edits — no data loss, no crash. Trivial fix with the same pattern used
   elsewhere in the codebase (`useDuePanelData`, `SearchPanel.alias`,
   `ConflictList.deviceFetch`).

Two further findings were confirmed but explicitly **excluded** as nits and
are noted at the bottom for completeness.

Cost: **S** (~1.5–3 h combined, ~80–150 LOC across 2 source files + 2 test
files). Risk: **low** (small surgical changes, no API shape changes). Impact:
**low–medium** (worker fix tightens an already-mitigated failure path; query
fix removes a real-but-cosmetic flicker).

## Item 1 — `graph-worker.ts` dispatcher has no error catch

### Current state

<ref_file file="/home/javier/dev/agaric/src/workers/graph-worker.ts" />

```ts
self.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data

  switch (msg.type) {
    case 'start': {
      // ... build simNodes, simEdges, simulation ...
      simulation.on('tick', () => {
        self.postMessage({ type: 'tick', positions: collectPositions() })
      })
      simulation.on('end', () => {
        self.postMessage({ type: 'done', positions: collectPositions() })
      })
      break
    }
    case 'stop': { /* ... */ break }
    case 'drag':  { /* ... */ break }
  }
})
```

The full dispatcher has no try/catch. Two failure modes are imperfectly
handled:

- **Synchronous throws inside the `'start'` / `'drag'` cases** — e.g., a
  corrupted `WorkerStartMessage` payload that breaks `forceLink<…>(simEdges)`
  configuration. These propagate to the worker boundary as an `error` event,
  which `runWorkerSimulation` does catch (`worker.addEventListener('error',
  handleError)` in `graph-sim-helpers.ts:485`) and which trips the
  `workerFailed` fallback in `useGraphWorkerSimulation` — so the user sees a
  graceful degrade to main-thread simulation rather than a frozen graph. But
  the main thread only learns "the worker failed", not *what* failed.

- **Throws inside d3-force `tick` / `end` callbacks** — e.g., a node that
  serialised fine on `'start'` somehow produces a non-cloneable value during
  `collectPositions` (theoretical; this is a `.map(n => ({ id, x, y }))`
  over already-cloned nodes, so it would take a regression to break it).
  Whether such throws surface as the worker's `error` event depends on how
  d3-force invokes its tick subscribers and on the runtime — Chromium does
  re-throw uncaught exceptions from event listeners as `error` events on the
  worker scope, but defensive wrapping is cheaper than relying on that.

There is no explicit `error` / `unhandledrejection` listener on the worker
itself, and no structured error message in the protocol — the outbound
message union is `WorkerTickMessage | WorkerDoneMessage` (see
`src/workers/graph-worker-types.ts`), nothing else.

### Proposed fix

Two small, independent additions:

1. Wrap the dispatcher body in `try/catch`, post an explicit error message
   back to the main thread, and re-throw so the boundary `error` event still
   fires (preserving the existing `onWorkerFailed` fallback path):

   ```ts
   self.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
     try {
       const msg = event.data
       switch (msg.type) { /* unchanged */ }
     } catch (err) {
       self.postMessage({
         type: 'error',
         message: err instanceof Error ? err.message : String(err),
       })
       throw err
     }
   })
   ```

2. Add belt-and-braces global handlers for failures that escape the
   dispatcher (e.g., unhandled rejections from a future async path):

   ```ts
   self.addEventListener('error', (e) => {
     self.postMessage({ type: 'error', message: e.message ?? 'worker error' })
   })
   self.addEventListener('unhandledrejection', (e) => {
     const reason = e.reason
     self.postMessage({
       type: 'error',
       message: reason instanceof Error ? reason.message : String(reason),
     })
   })
   ```

3. Extend the message protocol (`src/workers/graph-worker-types.ts`):

   ```ts
   export interface WorkerErrorMessage {
     type: 'error'
     message: string
   }

   export type WorkerOutboundMessage =
     | WorkerTickMessage
     | WorkerDoneMessage
     | WorkerErrorMessage
   ```

4. Handle the new outbound message in `runWorkerSimulation`'s `handleMessage`
   (`src/lib/graph-sim-helpers.ts`) — route it through the existing
   `reportFailure` helper so it joins the `onWorkerFailed` path the rest of
   the code already understands:

   ```ts
   const handleMessage = (evt: MessageEvent<WorkerOutboundMessage>): void => {
     if (failed) return
     const msg = evt.data
     if (msg.type === 'tick')  { /* unchanged */ }
     else if (msg.type === 'done') { /* unchanged */ }
     else if (msg.type === 'error') {
       reportFailure('worker-reported', new Error(msg.message))
       worker.terminate()
     }
   }
   ```

### Test impact

- New unit test in `src/components/__tests__/GraphView.test.tsx` (or its
  worker-failure-focused sibling
  `src/hooks/__tests__/useGraphWorkerSimulation.test.ts`) that posts a
  hand-crafted `{ type: 'error', message: '…' }` from the mock worker and
  asserts: (a) `workerFailed` flips to `true`, (b) `worker.terminate()` is
  called, (c) `logger.warn('GraphView', 'worker failed', { event:
  'worker-reported' }, …)` fires.
- The existing `flips workerFailed to true when the worker dispatches an
  error event` test (`useGraphWorkerSimulation.test.ts:165`) stays green —
  the boundary `error` event path is untouched.
- One regression-style test that throws inside the `'start'` case of the mock
  worker and asserts the new structured `error` message is observed by the
  main thread.

## Item 2 — `useQueryExecution.fetchResults` lacks a stale-fetch guard

### Current state

<ref_file file="/home/javier/dev/agaric/src/hooks/useQueryExecution.ts" />

```ts
const fetchResults = useCallback(
  async (pageCursor?: string) => {
    const isLoadMore = !!pageCursor
    beginFetch(isLoadMore, { setLoading, setLoadingMore, setCursor, setHasMore, setError })
    try {
      if (!expression.trim()) { setError('Query expression is empty'); return }
      const parsed = parseQueryExpression(expression)
      const result = await dispatchQuery(parsed, pageCursor, currentSpaceId)
      applyQueryResult(result, isLoadMore, { setResults, setCursor, setHasMore })
      const titles = await resolvePageTitles(result.items)
      mergePageTitles(titles, isLoadMore, setPageTitles)
    } catch (e) { /* ... */ }
    finally { endFetch(isLoadMore, { setLoading, setLoadingMore }) }
  },
  [expression, currentSpaceId],
)

useEffect(() => {
  fetchResults()
}, [fetchResults])
```

When the user edits `expression` rapidly:

1. Initial render → `fetchResults_v1` is created → effect calls it → IPC `dispatchQuery_v1` starts.
2. User edits expression → `fetchResults_v2` is created → effect re-runs → IPC `dispatchQuery_v2` starts.
3. If `dispatchQuery_v1` resolves *after* `dispatchQuery_v2`, it calls
   `applyQueryResult` and `mergePageTitles` with stale data, briefly
   overwriting the v2 results.

Result: a flash of stale rows and stale page-title labels before the v2
results land. No data loss, no crash. Same risk window applies to
`currentSpaceId` changes.

This pattern is solved correctly elsewhere in the codebase — e.g.,
`useDuePanelData.ts` uses a `let stale = false` flag with cleanup setting
`stale = true`, and `SearchPanel.tsx`'s alias resolver does the same. The
hook should match.

### Proposed fix

Two equivalent options; pick whichever matches existing style preferences:

**Option A — request-id counter (recommended):** Survives unmount + dep
changes uniformly, no closure capture issues.

```ts
const reqIdRef = useRef(0)

const fetchResults = useCallback(
  async (pageCursor?: string) => {
    const myReqId = ++reqIdRef.current
    const isLoadMore = !!pageCursor
    beginFetch(isLoadMore, { /* ... */ })
    try {
      if (!expression.trim()) {
        if (myReqId === reqIdRef.current) setError('Query expression is empty')
        return
      }
      const parsed = parseQueryExpression(expression)
      const result = await dispatchQuery(parsed, pageCursor, currentSpaceId)
      if (myReqId !== reqIdRef.current) return
      applyQueryResult(result, isLoadMore, { setResults, setCursor, setHasMore })
      const titles = await resolvePageTitles(result.items)
      if (myReqId !== reqIdRef.current) return
      mergePageTitles(titles, isLoadMore, setPageTitles)
    } catch (e) {
      if (myReqId !== reqIdRef.current) return
      logger.warn('useQueryExecution', 'query execution failed', { expression }, e)
      handleFetchError(e, isLoadMore, setError)
    } finally {
      if (myReqId === reqIdRef.current) endFetch(isLoadMore, { setLoading, setLoadingMore })
    }
  },
  [expression, currentSpaceId],
)
```

**Option B — `cancelled` flag in the calling effect:** Mirrors
`useDuePanelData.ts` exactly, but doesn't protect manual calls to
`handleLoadMore` (whose `cursor`-based flow generally doesn't need
cancellation, but Option A handles it for free).

```ts
useEffect(() => {
  let cancelled = false
  void fetchResults().catch(() => {})  // fetchResults handles its own errors
  // … but fetchResults still needs to know about `cancelled` to skip
  //   setResults / setPageTitles. Plumbing this through cleanly requires
  //   changing fetchResults' signature — Option A avoids that.
  return () => { cancelled = true }
}, [fetchResults])
```

Recommendation: Option A. Slightly more LOC than B, but keeps `fetchResults`
self-contained and protects `handleLoadMore` callers too.

### Test impact

Add one focused unit test in `src/hooks/__tests__/useQueryExecution.test.ts`
(or wherever the existing tests for this hook live — verify location before
editing):

- Mock `dispatchQuery` so the first call resolves *after* the second call.
- Render the hook with `expression = 'tag:foo'`, then change it to
  `expression = 'tag:bar'` before the first IPC resolves.
- Assert that after both IPCs settle, `result.current.results` matches the
  `'tag:bar'` payload, not the `'tag:foo'` payload.

If no test file currently exists for this hook, that's a documentation
follow-up — not a blocker for this change.

## Out of scope (intentionally)

- **`useCheckboxSyntax` optimistic-update ordering.** Confirmed by the
  validator but the practical observable window is zero (both lines run in
  the same synchronous tick before any microtask resolves). Cost of fixing:
  swap two lines. Not worth the diff noise on its own — fold into the next
  unrelated edit to that file if/when one happens.
- **`revertUnclosedMarks` round-trips atomic tokens through plaintext.**
  Confirmed mechanism, but `nodeToPlainText` reconstructs the textual ULID
  forms (`#[ULID]`, `[[ULID]]`, `((ULID))`) verbatim, and the next parse
  re-recognises them. **Lossless.** No fix needed; a one-line code comment
  noting the round-trip is intentional would be useful and can ride along
  with any nearby edit to `markdown-parse.ts`.
- **All exaggerated findings** (`resolve.preload`, markdown empty-block
  asymmetry, external-link URL scan, `/table NxM` bounds, `PageHeader`
  dependency array, `PropertyRowEditor` ref-picker state). Either the
  framing was wrong, the practical impact is negligible, or an existing
  guard already handles it.
- **All 30 false positives.** Documented in the review session output, not
  re-litigated here.

## Step-by-step plan

1. **`src/workers/graph-worker-types.ts`** — add
   `WorkerErrorMessage` and extend `WorkerOutboundMessage`. ~6 LOC.
2. **`src/workers/graph-worker.ts`** — wrap the dispatcher in try/catch +
   add the two `self.addEventListener('error' | 'unhandledrejection', …)`
   handlers. ~15 LOC.
3. **`src/lib/graph-sim-helpers.ts`** — extend `handleMessage` to route the
   new `'error'` outbound message through `reportFailure`. ~5 LOC.
4. **`src/hooks/__tests__/useGraphWorkerSimulation.test.ts`** — add
   `'error'` outbound message test. Reuse the existing `MockWorker` fixture.
   ~25 LOC.
5. **`src/hooks/useQueryExecution.ts`** — add `reqIdRef` and the four
   `if (myReqId !== reqIdRef.current) return` guards (Option A). ~12 LOC.
6. **Test for stale-fetch guard** — locate the existing
   `useQueryExecution` test file (if any), add the slow-old-fetch-races-fast-new-fetch
   case. ~30 LOC.
7. Run `npm run test` (vitest) — all 7300+ tests stay green.
8. Run `prek run --all-files` — Biome + parity hooks stay clean.
9. Single commit, conventional title:
   `fix: close PEND-22 — graph-worker error envelope + useQueryExecution stale-fetch guard`.

## Cost / risk / impact

| Dimension | Verdict |
| --- | --- |
| Cost | **S** (~1.5–3 h, ~80–150 LOC across 5 files) |
| Risk | **low** — additive error path on the worker, additive guard on the hook; no API shape changes |
| Impact | **low–medium** — worker fix tightens an already-mitigated failure path with richer diagnostics; query fix removes a real but cosmetic flicker users will notice on rapid query edits |

## Provenance

Two-round JS/TS robustness review (~73K LOC of production TS/TSX). Round 1:
6 parallel reviewers, ~80 raw findings. Round 2: 4 parallel validators
re-checked 40 raw findings against actual source. Final verdict
distribution: **30 false positives (75%) / 6 exaggerated (15%) / 4
confirmed (10%)**. Of the 4 confirmed findings, 2 are nit-level and 2 (this
file) are worth fixing.
