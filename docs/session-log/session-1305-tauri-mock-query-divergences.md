# Session 1305 — tauri-mock run_advanced_query divergences (2026-08-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-15 |
| **Subagents** | 1 build + 2 review + 1 review-fix |
| **Items closed** | `#3863` |
| **Items modified** | filed `#3884` |
| **Tests added** | +8 (frontend) / +0 (backend) |
| **Files touched** | 6 |

**Summary:** Closed the two `run_advanced_query` divergences #3863 named — the
`lastEdited` seed fallback and the cursor payload shape — by deriving what the engine
actually does from the Rust source in each case rather than from the issue's description.
On the cursor, those two disagreed, and the source won.

**Files touched (this session):**
- `src/lib/tauri-mock/handlers/shared.ts`
- `src/lib/tauri-mock/handlers/search.ts`
- `src/lib/tauri-mock/__tests__/advanced-query-sort.test.ts`
- `src/lib/base64url.ts` (new — extracted, see the review round below)
- `src/lib/inline-query-spec.ts`
- `docs/session-log/session-1303-tauri-mock-query-divergences.md` (new)

**Verification:**
- `npx vitest run src/lib/tauri-mock src/lib/__tests__/tauri-mock.test.ts src/hooks
  src/lib/__tests__/inline-query-spec.test.ts` — 2327 tests run, 2327 passed (149 files),
  including the conformance harness and the `useAdvancedQuery`/`useQueryExecution` hook
  suites.
- `npx vitest run src/components/dialogs/__tests__/QueryBuilderModal.test.tsx
  src/components/query src/lib/__tests__` — 3178 passed (124 files); the consumers of the
  base64url codec that moved.
- `npx tsc -b --noEmit` — clean.
- `node scripts/check-lib-layering.mjs` / `check-import-cycles.mjs` — clean (the new
  `lib` → `lib` edge adds no violation and no cycle).
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

- **Coverage stated with its denominator — and the denominator was the wrong one.**
  `SortColumn` has exactly 5 variants (`agaric-store/src/query/mod.rs:357-371`) and the TS
  `SORT_COLUMN_CURSOR_KIND` map covers 5/5. `CursorKind` has 6 (`engine.rs:123-138`) — the
  5 above plus `Rank`, sourced from `SortSource::Relevance` rather than from a
  `SortColumn`; the TS mirrors that split, so the DISCRIMINATOR coverage is 6/6. The second
  review round pointed out that this says nothing about the values actually emitted: it is
  5/6 there, because `LastEditedMs` on a row WITH op-log activity emits `Text` (ISO-8601)
  where the engine emits `Int` (epoch-ms). See the round-2 note below.

**Review round 2 (CHANGES_REQUESTED — encoder), and what it changed:**

- **BLOCKING: `encodeCursor` used `btoa` on a payload that now carries user text.** Safe
  while the payload was `{id}` (a ULID); not safe once `values` carries the `Title` term
  (the raw page title) and `Priority` (a user-configurable label). `btoa` maps each string
  CODE UNIT to one byte, so it (a) THREW `InvalidCharacterError` above U+00FF — an em-dash
  or CJK or emoji title, sorted by title with `limit` below the match count, produced a
  raw DOMException escaping the IPC boundary, since `dispatch` wraps handlers in no
  try/catch — and (b) silently emitted the single Latin-1 byte for U+0080–U+00FF (`é` ⇒
  `0xE9` where `QueryCursor::encode` has UTF-8 `0xC3 0xA9`), i.e. the exact cursor-byte
  divergence this PR exists to close, still open. Both now go through
  `utf8ToBase64Url`/`base64UrlToUtf8`, and four tests pin them: em dash, `é`, an emoji
  (astral-plane surrogate pair), and a non-ASCII round trip through page 2. Every one was
  confirmed RED first — the em-dash/emoji cases as the verbatim `InvalidCharacterError`,
  the `é` case as a byte mismatch — which is what the original shape test could not see,
  because every value in it was an ASCII ULID or an integer.

- **Where the codec lives.** The correct pair already existed as module-private helpers in
  `inline-query-spec.ts`. Rather than duplicate them or widen a FEATURE module's API so the
  backend mock could reach into it, both were extracted verbatim to a leaf module,
  `src/lib/base64url.ts`, and both consumers now import it. `check-lib-layering.mjs` permits
  either direction (both are rank-0 `lib`), so this was a coupling decision, not a legality
  one: the mock already depends on shared primitives of exactly this class
  (`fold-for-search`, `search-query/glob-validate`, `task-states`) and now on one more,
  instead of on the inline `{{query …}}` block payload format.

- **The `LastEditedMs` sentinel now encodes as the engine's `Int(0)`, not `Null`.**
  `EngineRow::cursor_value` (`engine.rs:322`) reads the COALESCE'd `last_edited: i64` and
  can only ever emit `CursorValue::Int` for that column — `Null` is unreachable there, and
  `COALESCE(…, 0)` makes `0` the exact value an op-log-free row carries. The `Text`-vs-`Int`
  gap for a row that HAS activity is the inherited ISO-string representation divergence and
  is left documented; the `Null`-vs-`Int(0)` gap was this change's own sentinel choice and
  had an exact engine answer, so it was fixed rather than documented.

- **The `lastEdited` getter no longer rescans `opLog` per comparison.**
  `rawOpLogLastEditedAt` linearly scans `opLog` with a `JSON.parse` per entry, and the
  getter runs inside the sort comparator — O(N log N · |opLog|). It is now memoized per
  matched row (`rawLastEditedOf`), lazily, so a query that does not sort by `lastEdited`
  pays nothing. Measured on a throwaway harness (N=200 rows, |opLog|=1000): **232 ms →
  73-77 ms** for one `run_advanced_query` dispatch, ~3.1x, and the gap widens with both N
  and |opLog|.

- **Two review notes deliberately NOT fixed here**, filed instead: a malformed cursor
  restarts silently where `QueryCursor::decode` returns a validation error, and
  `idTermIndex` is resolved against the current request rather than against the cursor
  (benign today — the anchor is matched by exact id — but load-bearing on an unstated
  assumption).

- **One divergence deliberately left in place, now tracked.** `pageLastModifiedAt`'s seeded
  fallback still feeds `list_pages_with_metadata`'s `RecentlyModified` sort, which has the
  same class of divergence (`commands/pages/metadata.rs` uses the identical
  `LAST_MOD_NULL_SENTINEL = 0` with no seed analogue). It was not fixed here because
  `e2e/pages-filter.spec.ts` and `e2e/pages-view.spec.ts` genuinely depend on the seeded
  differentiation — removing it needs a reseed, not a one-line swap. Filed as `#3884`.
  The reviewer's one code change was to replace a dangling "see the #3863 PR notes"
  comment with that issue number: a citation nobody can follow is not a citation.
