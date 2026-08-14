# Session 1303 — tauri-mock run_advanced_query divergences (2026-08-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-15 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | `#3863` |
| **Items modified** | filed `#3884` |
| **Tests added** | +3 (frontend) / +0 (backend) |
| **Files touched** | 4 |

**Summary:** Closed the two `run_advanced_query` divergences #3863 named — the
`lastEdited` seed fallback and the cursor payload shape — by deriving what the engine
actually does from the Rust source in each case rather than from the issue's description.
On the cursor, those two disagreed, and the source won.

**Files touched (this session):**
- `src/lib/tauri-mock/handlers/shared.ts`
- `src/lib/tauri-mock/handlers/search.ts`
- `src/lib/tauri-mock/__tests__/advanced-query-sort.test.ts`
- `docs/session-log/session-1303-tauri-mock-query-divergences.md` (new)

**Verification:**
- `npx vitest run src/lib/tauri-mock src/lib/__tests__/tauri-mock.test.ts src/hooks` —
  2314 tests run, 2314 passed (148 files), including the conformance harness (57) and the
  `useAdvancedQuery`/`useQueryExecution` hook suites.
- `npx tsc -b` — clean.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**What changed:**

- **Divergence 1 — `lastEdited` seed fallback.** The engine's sort key is
  `COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), 0)`
  (`agaric-store/src/query/engine.rs:229`) — op-log-free rows all tie at the epoch
  sentinel. The mock was layering a seeded `pageLastModified` fallback on top, so those
  rows sorted apart instead of tying. Extracted `rawOpLogLastEditedAt` and pointed
  `SORT_COLUMN_GETTERS.lastEdited` at it.
- **Divergence 2 — cursor payload shape.** Replaced `btoa(JSON.stringify({id}))` with
  `URL_SAFE_NO_PAD` base64 of `{version, values}`, where `values` is the full ordered
  tuple of tagged `CursorValue`s, one per resolved sort term including the tiebreak.

**Process notes:**

- **The issue described the cursor as carrying only the leading sort term; the engine
  carries the full tuple.** The builder read `engine.rs:141-196` and `EngineRow::cursor_value`
  and implemented what the source does, overriding the issue's own suggested approach.
  The reviewer independently confirmed the source and ruled for the builder. Worth
  recording because the instinct to follow a well-written issue is strong, and a mock
  "fixed" toward a misread of the engine is worse than the divergence it replaces — the
  whole value of the mock is that it is indistinguishable from the real thing.

- **The conformance harness structurally could not have caught this, and that is the more
  interesting finding.** `conformance-query.ts` captures each stack's own `next_cursor`
  only to feed it back into a later step of the *same* run (`cursor_from`); the raw cursor
  never enters the recorded `QueryResult`, so no fixture assertion ever compares cursor
  bytes across stacks. A bespoke unit test was therefore the only way to falsify a shape
  divergence — but it is a weaker permanent guard, because it will not notice a future
  change to the *Rust* cursor format. The reviewer proposed a concrete extension: record a
  `cursorShape` of `{version, valueTypeTags[]}` decoded on both sides, with any `Text` id
  value relabelled through the same canonical map the row tokens already use. Not done
  here — it is a design change to a shared TS/Rust harness, outside #3863's scope.

- **Coverage stated with its denominator.** `SortColumn` has exactly 5 variants
  (`agaric-store/src/query/mod.rs:357-371`) and the TS `SORT_COLUMN_CURSOR_KIND` map covers
  5/5. `CursorKind` has 6 (`engine.rs:123-138`) — the 5 above plus `Rank`, which is sourced
  from `SortSource::Relevance` rather than from a `SortColumn`; the TS mirrors that split,
  so 6/6.

- **One divergence deliberately left in place, now tracked.** `pageLastModifiedAt`'s seeded
  fallback still feeds `list_pages_with_metadata`'s `RecentlyModified` sort, which has the
  same class of divergence (`commands/pages/metadata.rs` uses the identical
  `LAST_MOD_NULL_SENTINEL = 0` with no seed analogue). It was not fixed here because
  `e2e/pages-filter.spec.ts` and `e2e/pages-view.spec.ts` genuinely depend on the seeded
  differentiation — removing it needs a reseed, not a one-line swap. Filed as `#3884`.
  The reviewer's one code change was to replace a dangling "see the #3863 PR notes"
  comment with that issue number: a citation nobody can follow is not a citation.
