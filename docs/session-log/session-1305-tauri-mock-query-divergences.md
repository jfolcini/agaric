# Session 1305 — tauri-mock run_advanced_query divergences (2026-08-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-15 |
| **Subagents** | 1 build + 2 review + 1 review-fix |
| **Items closed** | `#3863` |
| **Items modified** | filed `#3884`, `#3893`, `#3898`, `#3899`, `#3900` |
| **Tests added** | +15 (frontend) / +0 (backend) |
| **Files touched** | 8 |

**Summary:** Closed the two `run_advanced_query` divergences #3863 named — the
`lastEdited` seed fallback and the cursor payload shape — by deriving what the engine
actually does from the Rust source in each case rather than from the issue's description.
On the cursor, those two disagreed, and the source won. Review round 3 then established
that fixing the `lastEdited` SORT alone had left the same command's `LastEdited` FILTER on
a different data source; that split is closed here too, and the remainder that genuinely
cannot be closed without a reseed is filed rather than asserted away.

**Files touched (this session):**
- `src/lib/tauri-mock/handlers/shared.ts`
- `src/lib/tauri-mock/handlers/search.ts`
- `src/lib/tauri-mock/handlers/pages.ts` (round 3 — cursor decode)
- `src/lib/tauri-mock/__tests__/advanced-query-sort.test.ts`
- `src/lib/tauri-mock/__tests__/sort-cursor-conformance.test.ts` (round 3)
- `src/lib/base64url.ts` (new — extracted, see the review round below)
- `src/lib/inline-query-spec.ts`
- `e2e/weekly-reschedule-drag.spec.ts` (CI triage — see the last process note; the failure
  was a scroll race in the spec, not this diff)
- `docs/session-log/session-1305-tauri-mock-query-divergences.md` (new)

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
  here — it is a design change to a shared TS/Rust harness, outside #3863's scope. Filed as
  `#3893`.

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

- **Two review notes deliberately NOT fixed here.** Written up at the time WITHOUT issue
  numbers, and neither was actually filed until review round 3 caught it — the same
  #3702 failure mode this log's own closing line argues against. Now filed:
  - `#3899` — a malformed cursor restarts silently where `QueryCursor::decode` returns a
    validation error (four distinct messages: bad base64, bad UTF-8, bad JSON, unsupported
    version), so the mock is more permissive than the backend it stands in for.
  - `#3900` — `idTermIndex` is resolved against the current request rather than against the
    cursor. Benign today, and round 3 established *why* rather than leaving it at "benign":
    a client that changes `sort` between pages reads the anchor out of a non-`Id` slot,
    which is either a non-`Text` tag (→ `anchorId` null) or a `Text` title/priority that
    `findIndex` cannot match against a ULID. Every path restarts from the top. It
    degrades to a duplicated page, never a skipped or misordered one.

- **One divergence deliberately left in place, now tracked.** `pageLastModifiedAt`'s seeded
  fallback still feeds `list_pages_with_metadata`'s `RecentlyModified` sort, which has the
  same class of divergence (`commands/pages/metadata.rs` uses the identical
  `LAST_MOD_NULL_SENTINEL = 0` with no seed analogue). It was not fixed here because
  `e2e/pages-filter.spec.ts` and `e2e/pages-view.spec.ts` genuinely depend on the seeded
  differentiation — removing it needs a reseed, not a one-line swap. Filed as `#3884`.
  The reviewer's one code change was to replace a dangling "see the #3863 PR notes"
  comment with that issue number: a citation nobody can follow is not a citation.

- **The one CI failure on this PR was NOT this diff, and the triage says how that was
  established rather than asserted.** `validate / playwright (3)` failed
  `e2e/weekly-reschedule-drag.spec.ts:66` ("source row … not found") on both the first
  attempt and the retry. The obvious suspect was divergence 1: op-log-free rows now tie at
  the sentinel instead of sorting apart by a seeded stamp, so any view ordered by
  `lastEdited` reorders. That hypothesis was falsified, not argued away — an instrumented
  run wrapping `__TAURI_INTERNALS__.invoke` before first paint recorded every command the
  boot + weekly-view flow issues (21 distinct: `get_journal_page_by_date`, `list_blocks`,
  `load_page_subtree`, `count_agenda_batch_by_source`, `count_backlinks_batch`,
  `list_projected_agenda`, `list_unfinished_tasks`, `query_by_property`, …).
  `run_advanced_query` is not among them, count 0. Weekly view reaches its rows through
  `BlockTree`, and the only `run_advanced_query` entry points are inline `{{query …}}`
  blocks (`useQueryExecution`) and `AdvancedQueryView` — the seed contains neither
  (`grep -c query src/lib/tauri-mock/seed.ts` = 0). The changed sort getter is unreachable
  from that spec.

- **The real mechanism was a scroll race the spec created itself.** The test picks its drop
  target as the first rendered day that is not today — normally the START of the week,
  several day-sections ABOVE today's — and called `scrollIntoViewIfNeeded()` on it. That
  scrolls today's section back out of the viewport, and `useViewportObserver`'s
  IntersectionObserver (200px rootMargin) then swaps the source row for the ARIA-hidden
  placeholder `SortableBlockWrapper` renders for off-screen rows — the very culling the
  spec's own comment describes, re-triggered after `expect(sourceRow).toBeVisible()` had
  already passed. Whether the `page.evaluate` landed before or after the flip decided the
  outcome. The same-day sibling test in the same file passed in the same CI run, on both
  attempts, precisely because ITS drop zone is today's, so it never scrolls away from the
  row it is about to drag.

- **Fix: order the scrolls so nothing moves the row off screen after it is found.** The
  drop zone is resolved and asserted first, without scrolling — `RescheduleDropZone` is
  rendered unconditionally per day and is not virtualized, and Playwright's `toBeVisible`
  means attached-and-laid-out, not in-viewport, so the assertion still checks everything
  the synthetic `DragEvent` dispatch needs. Scrolling today's section in is now the LAST
  step before the gesture. Reproduced and measured under load
  (`--repeat-each=12 --workers=4 --retries=0`): **3/12 failures before, 0/12 after**, then
  **0/20** on a wider repeat; the same-day test was 12/12 in both. Sweep: `grep` over all
  of `e2e/` shows `scrollIntoViewIfNeeded` appears in this file ONLY, so no sibling spec
  carries the same construct; the other scroll idioms (`scrollTop`/`mouse.wheel` in
  `pages-view`, `pages-filter`, `search-results`, `agenda-virtualization`,
  `infinite-journal-1415`) scroll a container to trigger load-more and never scroll away
  from an element they subsequently need. The three specs that DO exercise
  `run_advanced_query` (`query-blocks`, `query-hint`, `mobile-overflow`) plus the three
  other weekly-view specs (`journal-panels`, `agenda-advanced`, `features-coverage`) were
  run together: 94/94 pass.

**Review round 3 (APPROVED, all notes non-blocking) — and why four of the five were still
worth acting on:**

- **The flake fix removed the barrier it was relying on.** Reordering the drop-zone
  `toBeVisible()` to sit AFTER the `renderedDays` enumeration left that enumeration with no
  auto-waiting step ahead of it. `Locator.evaluateAll` does not retry: on an unmounted
  weekly view it returns `[]` immediately and the spec dies on `rendered days: []` — a NEW
  flake vector introduced inside a flake fix. The `0/20` repeat above is evidence the
  residual vector is rare, not evidence the barrier was unnecessary; that distinction is
  the whole note. An explicit `expect(page.locator('[data-testid^="reschedule-drop-zone-"]')
  .first()).toBeVisible()` now sits ahead of the enumeration. Re-measured
  `--repeat-each=12 --workers=4 --retries=0`: **24/24 pass**.

- **The same `btoa` bug was in the sibling handler, one import away.** Round 2 blocked on
  `encodeCursor`; `encodeNextCursor` (`handlers/shared.ts`, `list_pages_with_metadata`) had
  the identical defect and was not touched, because it is pre-existing. Under
  `sort: 'alphabetical'` its `deleted_at` slot carries `last.content` — the raw page title —
  so `Q3 — Roadmap` as a boundary row threw `InvalidCharacterError` straight out of the
  command and `Café` emitted `0xE9` for `0xC3 0xA9`. Now on `utf8ToBase64Url`, with
  `pages.ts`'s decode moved to `base64UrlToUtf8` to match (which still accepts the
  standard-alphabet cursors hand-rolled with `btoa`, since standard base64 never emits
  `-`/`_` — that is what keeps the stale-cursor fixtures decoding into the
  discriminator-mismatch path). Both failure modes confirmed RED first: the em dash as the
  verbatim `InvalidCharacterError` at `shared.ts:829`, the `é` as a byte mismatch
  (`…ZGVsZXRlZF9hdCI6IkNhZukgTm90ZXMifQ==` vs `…IkNhZsOpIE5vdGVzIn0`). Leaving a known
  instance of a bug you just fixed next door, with the fix already imported, is not a
  defensible scope boundary.

- **The accuracy correction: the command was internally SPLIT, and the PR said the
  opposite.** #3863 pointed the `lastEdited` SORT getter at `rawOpLogLastEditedAt` but left
  `metaRowMatchesExpr`'s `LastEdited` FILTER leaf on `row.lastModifiedAt` — i.e.
  `pageLastModifiedAt` *with* the seeded fallback. `compile_last_edited`
  (`agaric-store/src/filters/primitive.rs:1035-1052`) uses the op-log `MAX(created_at)` with
  the same COALESCE-to-epoch rule and no seed analogue, so a seeded, op-log-free block could
  pass a `Rolling{30}` filter on a stamp the backend cannot see and then sort at the
  never-edited sentinel in the same response, where the engine would have excluded it. So
  "matches the engine exactly" and "a strict improvement, not a new inconsistency" were
  overstated as written: #3863 fixed one half of one command and left the other half on a
  different data source. The bucket SEMANTICS always matched exactly (Rolling excludes,
  OlderThan includes, Range excludes on the epoch sentinel) — only the source differed.
  Fixed rather than documented: `metaRowMatchesFilter`/`metaRowMatchesExpr` now take a
  `LastEditedSource`, `run_advanced_query` passes `RAW_OP_LOG_LAST_EDITED_SOURCE`, and the
  `MatchedEntry` is built before the predicate so the filter and the sort share one
  `lastEditedRaw` memo. `list_pages_with_metadata` keeps the default seeded source: its
  fixtures depend on the differentiated stamps, so forcing it would break them — that
  remainder is filed as `#3898`, which #3884 does NOT cover (#3884 is the
  `RecentlyModified` sort keyset in `commands/pages/metadata.rs`; #3898 is the `LastEdited`
  filter predicate against `filters/primitive.rs` — same root cause, different path, and
  neither fix implies the other).

- **The one unpinned tagged value, and what was chosen for each half.**
  `approximateFtsRank` can return `Number.POSITIVE_INFINITY`, which `JSON.stringify` emits
  as `null` — `{"t":"Real","v":null}`, a payload serde cannot deserialize into
  `CursorValue::Real(f64)`. GUARDED, because the engine has an exact answer for it:
  `EngineRow::cursor_value` is `self.rank.map_or(CursorValue::Null, CursorValue::Real)`
  (`engine.rs:322`), so a rank-less row is `Null` there and is `Null` here now. The branch
  is unreachable through the handler — the MATCH narrowing and the ranker fold the same
  query with the same function, so a surviving row always has ≥1 occurrence — so it is
  falsified against `cursorValueFor` directly (exported as a test seam for exactly that
  reason), verbatim RED: `expected { t: 'Real', v: null } to deeply equal { t: 'Null' }`.
  The second half — an integral rank serializing as `2` where serde_json writes `2.0` — is
  PINNED, not fixed: serde's `f64` deserializer accepts a JSON integer, so both sides decode
  to the same `Real(2.0)`, and the keyset compares ranks inside `RANK_EPSILON = 1e-9`
  anyway. Emitting `2.0` from JS needs hand-built JSON for one cosmetic digit. The test
  asserts the raw cursor bytes contain `{"t":"Real","v":2}` and that page 2 still resumes,
  so the choice is recorded rather than merely believed.
