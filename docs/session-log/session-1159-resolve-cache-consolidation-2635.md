## Session 1159 — Consolidate `useBacklinkResolution` into `useResolveStore` (#2635) (2026-07-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | `#2635` |
| **Items modified** | — |
| **Tests added** | +`has()` store coverage; hook suite rewritten |
| **Files touched** | 4 |

**Summary:** Removed the duplicate `[[ULID]]`/`#[ULID]` title cache. `useBacklinkResolution` no longer keeps its own TTL(5min)+LRU(1000) resolved-title `Map`; it now delegates real title/status resolution to the shared `useResolveStore` (the app-wide Zustand resolve cache), keeping only backlink-specific bookkeeping local. Spun out of #2597 (the survey flagged it as a double-cache risk if migrated to TanStack). Read-path only.

**Files touched (this session):**
- `src/hooks/useBacklinkResolution.ts` (217 → 186, −31) — deleted the private `resolveCache` Map + `TTL_MS`/`MAX_CACHE_SIZE` + the evict/touch/computeTitle helpers. The resolve effect now `batchResolve`s only ids the store doesn't already have (`useResolveStore.has(id)`) and writes real rows via `batchSet`; reads go through the store's `resolveTitle`/`resolveStatus`; the hook subscribes to the store's `version` (plus a small `localVersion` for all-unchanged `batchSet` passes) to re-render when resolutions land. Broken/foreign/soft-deleted ids are held in a backlink-local `attemptedRef` Set (composite-keyed `${spaceId}::${id}`, mirroring `useSearchResults`' `attemptedBreadcrumbIdsRef`) so their placeholders **never** enter the shared store. `clearCache()` clears `attemptedRef` + sets a `forceReresolveRef` latch (it does NOT clear the shared store — that would nuke every consumer) so the next resolve pass re-fetches all current content ids — preserving #2628's re-resolve-on-rename behaviour in `LinkedReferences`.
- `src/stores/resolve.ts` (+11) — added a `has(id)` action: a pure existence probe (`cache.has(keyFor(activeSpaceId(), id))`, no LRU touch, no `version` bump, space-scoped) so a delegating consumer can distinguish a genuine cached resolution from `resolveTitle`'s `[[…]]` fallback without exposing the raw Map.
- `src/hooks/__tests__/useBacklinkResolution.test.ts` — rewritten to pin the delegated contract (real titles from the store; unresolved → broken placeholder with `cache.size === 0`, no pollution; `clearCache` re-resolves a rename AND leaves sibling store entries intact; attempted-unresolved suppresses redundant IPC; tag-name fallback; two-space scoping #2543; error path). The obsolete TTL-expiry test was removed (no TTL exists now).
- `src/stores/__tests__/resolve.test.ts` (+41) — `has()` coverage (real-vs-absent, space-scoped, pure-probe / no version bump).

**Verification:**
- 1 builder + 1 adversarial reviewer (SHIP, no defects). The review traced the `clearCache` latch lifecycle (double-clear idempotent; clear-then-load-more force-resolves once; normal load-more does NOT force), confirmed the single `batchSet` carries only real backend rows (no store pollution), and judged the dropped 60-char title truncation **benign**: no test depends on it, the reference-row CSS already `truncate`s, and the editor already renders full titles from the same store — so backlinks now match the editor rather than carrying a backlink-only cap.
- `npx tsc -b --noEmit` — 0 errors; `oxlint` clean.
- `npx vitest run` (full suite) — 662 files, 15069 tests, all passed.

**Process notes:** the intentional behaviour change is a single unified cache — backlink `[[ULID]]` chips now read the same resolved titles as the editor (full, not 60-char-capped). The 5-min TTL is gone; freshness now comes from the store's `preload` (sync) + `set`/`batchSet` (rename/restore) plus the `clearCache` force-latch on a property-change. Done in an isolated git worktree so it ran in parallel with #2634's first consumer PR.

**Commit plan:** single commit; pushed; PR against main (Closes #2635).
