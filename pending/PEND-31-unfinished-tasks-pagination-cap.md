# PEND-31 — `UnfinishedTasks` panel silently truncates carry-over TODOs to a single page (200 oldest blocks)

> **Status:** ready — bug confirmed by code review, awaiting user-side data confirmation (DB block count + repro recipe). No fix landed yet.

## Symptom (as reported by user)

> "The carry-over todos in the journal only bring the last one from the previous day."

The "Unfinished Tasks" panel that renders at the top of *today's* daily journal page shows fewer items than the user expects — in the reported case, only one TODO from yesterday surfaces, even though multiple unfinished TODOs from yesterday exist.

## What "carry-over todos" means in code

There is no literal "carry-over" mechanism (we do not copy yesterday's blocks into today's page). What the user is referring to is the **`UnfinishedTasks`** panel rendered at the top of `DailyView` only when the displayed date equals `getTodayString()`:

- <ref_snippet file="/home/javier/dev/agaric/src/components/journal/DailyView.tsx" lines="49-61" /> — `{isToday && <UnfinishedTasks onNavigateToPage={onNavigateToPage} />}`
- <ref_file file="/home/javier/dev/agaric/src/components/journal/UnfinishedTasks.tsx" />

The panel queries every block whose **`due_date`** OR **`scheduled_date`** is before today and whose `todo_state` is `TODO` / `DOING`, groups them into "Yesterday / This Week / Older", and renders them as a collapsible list. This is the only "previous-day TODOs" surface in the journal view.

## Investigation summary

The panel issues two parallel `queryByProperty` calls on mount (no cursor pagination, single fetch each), merges/dedups by `block.id`, then filters client-side:

<ref_snippet file="/home/javier/dev/agaric/src/components/journal/UnfinishedTasks.tsx" lines="208-246" />

```ts
const [dueResp, schedResp] = await Promise.all([
  queryByProperty({ key: 'due_date',       limit: 500, spaceId: currentSpaceId }),
  queryByProperty({ key: 'scheduled_date', limit: 500, spaceId: currentSpaceId }),
])
…
const merged = mergeAndFilterUnfinished([...dueResp.items, ...schedResp.items], todayStr)
setBlocks(merged)
```

Three independent issues compound here. **The first is a confirmed correctness bug.** The other two are aggravating factors that make the symptom much worse.

### 1. `limit: 500` is silently clamped to 200 by the backend (CONFIRMED)

Every `query_by_property` call is funnelled through `pagination::PageRequest::new`, which **clamps `limit` to `[1, MAX_PAGE_SIZE = 200]`** with no warning, no log line, no error:

<ref_snippet file="/home/javier/dev/agaric/src-tauri/src/pagination/mod.rs" lines="50-53" />
<ref_snippet file="/home/javier/dev/agaric/src-tauri/src/pagination/mod.rs" lines="506-512" />

```rust
const DEFAULT_PAGE_SIZE: i64 = 50;
const MAX_PAGE_SIZE: i64 = 200;
…
pub fn new(after: Option<String>, limit: Option<i64>) -> Result<Self, AppError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    …
}
```

The frontend's `limit: 500` is **a no-op** — both queries return at most 200 rows each. There is no other carve-out for this command (`query_by_property_inner` calls `PageRequest::new` unconditionally — <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/queries.rs" lines="116-143" />).

### 2. `ORDER BY b.id ASC` puts the oldest blocks on page 1

Both branches of `query_by_property` (reserved-key column path and non-reserved `block_properties` join path) order by `b.id ASC`:

<ref_snippet file="/home/javier/dev/agaric/src-tauri/src/pagination/properties.rs" lines="117-167" />

```sql
…
ORDER BY b.id ASC
LIMIT ?4
```

ULIDs are time-prefixed (AGENTS.md invariant #8 — "ULID uppercase normalization — Crockford base32 for blake3 hash determinism"), so `id ASC` ≈ **oldest first**. For the "unfinished" panel — which by definition wants the *most recent* unfinished work — this is the wrong direction. Page 1 (limit 200) is filled with the oldest 200 blocks that ever had a `due_date` / `scheduled_date` set. Yesterday's TODOs (the freshest ULIDs) sit on page 2+.

### 3. The frontend never paginates and never inspects `has_more`

`UnfinishedTasks` does a single `queryByProperty` per key and never reads `next_cursor` / `has_more` from `dueResp` or `schedResp`:

<ref_snippet file="/home/javier/dev/agaric/src/components/journal/UnfinishedTasks.tsx" lines="212-246" />

There is no follow-up `while (resp.has_more) { … }` loop, no `next_cursor` plumbing, no log line on truncation. Once the user accumulates >200 dated blocks total, page 1 is full of stale ancient items and yesterday's TODOs are silently invisible.

### Why "only the last one from the previous day" specifically?

The first three points cleanly explain why **most of yesterday's TODOs would disappear**. They do *not* by themselves explain why **exactly one survives** — the residual block has to land in page 1 by some path. Most plausible explanations, ranked:

1. **The single survivor has BOTH `due_date` AND `scheduled_date` set, and a duplicate from earlier in the user's data set is also on page 1.** The `mergeAndFilterUnfinished` dedup (line 156) keeps the first occurrence by id; if that occurrence happens to have yesterday's date (because the block is *itself* in page 1 of one of the two queries due to its older ULID neighbours), it survives. **Worth validating against user data.**
2. **The user has fewer than 200 dated blocks total**, in which case both queries do return everything. Then the symptom must be explained by something else — most likely a separate problem (e.g., the missing TODOs lack both `due_date` and `scheduled_date` entirely; see "Open questions" below).
3. **A dedup edge case** in `mergeAndFilterUnfinished` (line 156-157): the dedup happens **before** the `todo_state` and date-window filters. If the same block id were ever returned twice with mutually-exclusive metadata (e.g., one row passes the filters and one does not), we could incorrectly skip the legitimate survivor. Both queries hit the same `blocks` table though, so this is theoretically tight; flagging it for completeness.

The first interpretation is consistent with the user's wording and the failure mode of issue #1 above, which is the headline confirmed bug regardless of which sub-shape is producing the "exactly one" residual.

## What is *not* the bug

To save the next session: these were investigated and ruled out:

- **Materializer lag.** AGENTS.md invariant #2 — primary-state materialization is synchronous in the same `BEGIN IMMEDIATE` transaction as the op-log append. `commands/blocks/crud.rs:1721-1737` and `materializer/handlers.rs:591-607` confirm `due_date` / `scheduled_date` columns are written in the same tx. There is no observable replication window between `block_properties` and the column.
- **Space filter clause.** `(?N IS NULL OR COALESCE(b.page_id, b.id) IN (SELECT … WHERE bp.key = 'space' AND bp.value_ref = ?N))` correctly resolves blocks under daily journal pages because daily pages are created via `createPageInSpace` which atomically sets the `space` ref property — see <ref_snippet file="/home/javier/dev/agaric/src/hooks/useJournalBlockCreation.ts" lines="69-99" />.
- **`b.due_date` empty-string vs null.** Backend types are `Option<String>` and serialise as `null` on the wire; the frontend's `b.due_date ?? b.scheduled_date` handles `null` correctly.
- **React key collisions.** `BlockListItem` keys on `block.id` (uppercase 26-char ULID) — no collision risk.
- **`useBlockPropertyEvents` interference.** `UnfinishedTasks` does not subscribe to property-event invalidations; it fetches once on mount and on `currentSpaceId` change.

## Reproduction steps (proposed)

To confirm the headline bug (#1 + #2 + #3) deterministically:

1. Start with a fresh space.
2. Create ≥200 blocks and set `due_date` on each to a date in **2024** (well before yesterday). They will all be unfinished TODOs by default.
3. Create one TODO block today, scheduled or due *yesterday*.
4. View today's journal.
5. **Expected:** the yesterday TODO appears under "Yesterday" in the Unfinished Tasks panel.
6. **Observed (predicted):** the panel either shows only the 2024 blocks (the oldest 200) or shows nothing under "Yesterday", because the yesterday block sits in page 2 of `query_by_property('due_date')` and the frontend never asks for it.

To collect ground-truth from the affected user's database (Linux: `~/.local/share/com.agaric.app/notes.db`):

```sql
SELECT COUNT(*) FROM blocks
 WHERE deleted_at IS NULL
   AND is_conflict = 0
   AND (due_date IS NOT NULL OR scheduled_date IS NOT NULL);
```

If the count is ≥200, the headline bug is empirically confirmed for that user. Then:

```sql
-- The 200 blocks the frontend actually sees for due_date:
SELECT id, due_date, todo_state, content
  FROM blocks
 WHERE due_date IS NOT NULL
   AND deleted_at IS NULL
   AND is_conflict = 0
 ORDER BY id ASC
 LIMIT 200;

-- The full list of yesterday's unfinished blocks (the user's expectation):
SELECT id, due_date, scheduled_date, todo_state, content
  FROM blocks
 WHERE deleted_at IS NULL
   AND is_conflict = 0
   AND todo_state IN ('TODO', 'DOING')
   AND (due_date = date('now', '-1 day', 'localtime')
     OR scheduled_date = date('now', '-1 day', 'localtime'));
```

The set difference between row 2 and row 1 (restricted to yesterday) is exactly the set of TODOs that are silently invisible.

## Suggested fix shapes (pick one)

| Option | Approach | Cost | Risk | Impact |
| --- | --- | --- | --- | --- |
| **A** | **Paginate properly in `UnfinishedTasks`** — loop on `next_cursor` until `has_more` is false, for both `due_date` and `scheduled_date` queries. Cap with a generous safety bound (say 5000 total blocks) so we never spin forever on an absurd dataset. | trivial-S (≈30–60 min) | low | high — fixes the symptom for every user, regardless of dataset size |
| **B** | **Push the date-window filter to the backend** — add a new `list_unfinished_tasks_inner` command that accepts `before_date` + `todo_states` and runs a single SQL with `WHERE (due_date < ? OR scheduled_date < ?) AND todo_state IN (...) ORDER BY id DESC LIMIT 200`. Frontend calls it once with `before_date = today`. | M (≈2–4 h: backend command + sqlx query + specta binding + tauri-mock + frontend rewrite + tests) | low | very high — eliminates the over-fetch entirely (today fetches up to 1000 rows just to discard the ones not before today), gives correct DESC-by-recency ordering, and removes the dedup logic from the frontend |
| **C** | **Flip the `query_by_property` ordering to `id DESC`** for reserved-key date columns (or as an opt-in flag). | S (≈1–2 h) | medium — many other callsites of `query_by_property` rely on stable `ASC` cursor semantics; flipping is breaking unless gated | medium — doesn't fix the truncation, just makes the truncated subset more useful |

**Recommended:** **Option B**. The current panel is already doing a half-application-layer query (filter for `todo_state IN ('TODO','DOING')` and `dateStr < today` in JavaScript on potentially-truncated data); promoting both filters into SQL is the natural fix and incidentally addresses ordering and over-fetch in one shot. Option A is the cheapest hot-fix if the priority is closing the data-loss path immediately and Option B can come later. Option C is the riskiest and the least targeted.

If we go with **Option B**, the new command should use `ORDER BY COALESCE(due_date, scheduled_date) DESC, id DESC LIMIT 200` so yesterday's blocks always come before older ones within the page; if the user genuinely has >200 unfinished overdue TODOs, the panel can paginate within the new command. Yes, that's still a per-page cap — but it caps on the *most recent* 200 unfinished items, which is the correct user-visible truncation.

## Open questions for the user

Before landing any fix, please confirm:

1. **How many of yesterday's TODOs do you have?** And what's the rough total of dated TODOs across all time? (`SELECT COUNT(*) FROM blocks WHERE due_date IS NOT NULL OR scheduled_date IS NOT NULL;`)
2. **Are the yesterday TODOs that *don't* show up missing both `due_date` AND `scheduled_date`?** If yes, the fix scope changes — `UnfinishedTasks` only includes blocks with at least one of those properties set; pure `todo_state = 'TODO'` blocks on yesterday's daily journal page never carry over by design. If that's the user's mental model gap, we should clarify the panel's scope (or extend the panel to include "TODO blocks on yesterday's daily journal page even without a date property").
3. **Which fix do you prefer?** Option A is fastest, Option B is most correct, Option C is opportunistic.

## Verification plan

For the fix landing commit:

1. **Unit/integration tests** — extend `src/components/journal/__tests__/UnfinishedTasks.test.tsx` with:
   - A test where `query_by_property` returns 200 oldest blocks dated 2024, plus one block dated yesterday, and assert all yesterday blocks (not just the oldest 200) end up in the panel. Today's existing tests use an unbounded mock and never exercise the cap.
   - A test for the dataset shape "block has both `due_date` AND `scheduled_date` set" to lock in the dedup behaviour against regressions (today there is no test that constructs this row shape).
2. **Backend test** (only if Option B) — `command_integration_tests/property_integration.rs` should gain a `list_unfinished_tasks` test that asserts `ORDER BY date DESC` and the 200-cap.
3. **Manual** — clear app state, generate the repro dataset above, and confirm yesterday's TODOs render after the fix.

## Cost / Impact / Risk

- **Cost:** Option A — trivial-S (≈1 h). Option B — M (≈2–4 h).
- **Risk:** low. No schema changes, no op-log additions, no new stores. Option A is a pure frontend change. Option B adds one new read-only command (additive, easy to back out).
- **Impact:** high. This is a **silent data-loss-shaped UX bug**: users believe their unfinished work is gone or forgotten. Solo-user app, but the trust cost of "the app forgot my TODOs" is large. Closing it removes a class of "mysterious missing tasks" support questions.
