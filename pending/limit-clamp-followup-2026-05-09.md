# Limit-clamp follow-up — close the BUG-48 anti-pattern repository-wide

> **Status:** ready as a three-phase plan. Phases are independent —
> Phase 1 buys immediate visibility; Phase 2 is the substantive fix;
> Phase 3 prevents the next regression.

## Why this exists

BUG-48 was a silent UX regression: `useCalendarPageDates` /
`useJournalAutoCreate` called `listBlocks({ blockType: 'page', limit: 500 })`,
the backend silently clamped that to 100 (`commands/blocks/queries.rs:75`,
F06), and any journal page past index 99 fell off — breaking auto-create
dedupe and calendar highlighting.

The journal-specific fix shipped (commits 309ee5bf, ef53eefc, 8dc87e72)
by introducing two database-native commands backed by `idx_blocks_journal_date`.
That closed BUG-48 itself. **It did not close the class of bug.**

The follow-up audit (see `sql-audit-2026-05-09.md`) found the same anti-
pattern in at least 10 other places. Some are HIGH severity (silent data
truncation in the editor, ref picker, graph view, exports). The risk is
not theoretical — it is the same shape that already bit us once.

Backend clamps in play (silent truncation ceilings):

| Site | File | Ceiling |
| ------ | ------ | --------- |
| `list_blocks_inner` | `src-tauri/src/commands/blocks/queries.rs:75` | **100** ← BUG-48 root |
| Generic `PageRequest::new` | `src-tauri/src/pagination/mod.rs:511` | 200 |
| `list_agenda` | `src-tauri/src/commands/agenda.rs:192` | 500 |
| MCP page commands | `src-tauri/src/commands/pages.rs:800, 899` | `MCP_PAGE_LIMIT_CAP` |
| `list_tags_by_prefix` | `src-tauri/src/tag_query/query.rs:134` | 200 |

Frontend "I want all" call sites that ignore those ceilings:

| Severity | File:line | Limit asked | Pattern | Hazard |
| ---------- | ----------- | ------------- | --------- | -------- |
| ~~HIGH~~ DONE | ~~`src/stores/page-blocks.ts:125`~~ | ~~500~~ | now routes through `load_page_subtree` IPC — single SELECT against the `page_id` index, no per-parent recursion; FE-side `loadSubtree` helper deleted | — |
| ~~HIGH~~ DONE | ~~`src/components/PropertyRowEditor.tsx:254`~~ | ~~500~~ | now routes through `list_all_pages_in_space` IPC (no pagination, no clamp); the existing client-side filter still works | — |
| ~~HIGH~~ DONE | ~~`src/components/GraphView.helpers.ts:55, 62, 76`~~ | ~~5000~~ | now routes through `list_all_pages_in_space(spaceId, tagIds)` IPC (no pagination, no clamp) | — |
| ~~HIGH~~ DONE | ~~`src/lib/export-graph.ts:19`~~ | ~~1000~~ | now routes through `list_all_pages_in_space` IPC (no pagination, no clamp) | — |
| ~~HIGH~~ DONE | ~~`src/components/GraphView.helpers.ts:146`~~ | ~~1000~~ | now routes through `list_template_page_ids_in_space` IPC (no pagination, no clamp) | — |
| MEDIUM | `src/hooks/useDuePanelData.ts:210, 261` | 500 | routes via agenda (cap 500) — at-edge | OK today, fragile to refactor |
| MEDIUM | `src/components/SearchPanel.tsx:138` | 20 | list + JS `.filter()` | page picker can't find pages past index 19 |
| MEDIUM | `src/hooks/useBlockDatePicker.ts:143` | 500 | one-shot | date-picker page list truncated |
| MEDIUM | `src/hooks/useBlockResolve.ts:99` | 500 | one-shot | resolve cache misses pages past 100 |
| MEDIUM | `src/lib/template-utils.ts:175` | 500 | one-shot | template lookup truncated |
| MEDIUM | `src/components/TagList.tsx:63` | 500 | `listTagsByPrefix` (cap 200) | tag list truncated past 200 |
| LOW | `src/components/ViewDispatcher.tsx:111` | 100 | trash count badge | wrong badge count at >100 trash items |

Verified safe (use cursor pagination correctly): `PageBrowser.tsx:70`,
`TrashView.tsx:67`, `stores/resolve.ts:158`, `SpaceManageDialog.tsx:280`
(emptiness probe, `limit: 1`).

---

## Phase 1 — Strict clamp: turn silent truncation into a loud failure

**Goal:** make the next BUG-48 fail at the first IPC call instead of
months later when a user reports that "some pages are missing."

**Change:**

1. In `src-tauri/src/commands/blocks/queries.rs:75`, replace

   ```rust
   let clamped_limit = limit.map(|l| l.clamp(1, 100));
   ```

   with

   ```rust
   if let Some(l) = limit {
       if l < 1 || l > 100 {
           return Err(AppError::Validation(format!(
               "list_blocks limit must be in [1, 100]; got {l}. \
                For larger result sets, use cursor pagination."
           )));
       }
   }
   ```

2. Apply the same pattern to the other clamps:
   - `src-tauri/src/pagination/mod.rs:511` (`PageRequest::new`)
   - `src-tauri/src/commands/agenda.rs:192`
   - `src-tauri/src/commands/pages.rs:800, 899`
   - `src-tauri/src/tag_query/query.rs:134`

3. Run the test suite. Every new failure is a known-broken call site
   (the table above). Fix each immediately by either threading cursor
   pagination or routing to a database-native command (Phase 2).

**Sequencing note:** do not ship Phase 1 alone — it will break the
HIGH-severity FE call sites synchronously. Land it together with the
matching Phase 2 fixes for those sites in the same release.

- **Risk:** MEDIUM. Will surface fallout on first run if any FE site
  was missed in the audit. Mitigated by the `tauri-mock` test suite
  catching most cases pre-merge.
- **Impact:** HIGH long-term. Eliminates the silent-truncation class
  of bug entirely — every future BUG-48 becomes a loud, attributable
  validation error instead of mysterious data loss.
- **Cost:** S (≤½ day to make the change + run tests).

---

## Phase 2 — Per-site conversions

For each row in the hazard table, choose one of three fixes.
Recommendations below are per-site.

### 2a. Database-native commands (preferred when caller really needs "all of X")

This is what the journal fix did. New IPC + partial index, returns the
full bounded set, no pagination needed because the upper bound is
intrinsic.

- **`src/lib/export-graph.ts:19`** → new IPC `export_pages_for_graph(spaceId)`
  that streams or returns a bounded set (the export already has to load
  everything; the limit was bogus). Cost: S.
- **`src/components/GraphView.helpers.ts:55, 62, 76, 146`** → reuse the
  same `export_pages_for_graph` shape, or a graph-specific
  `list_pages_for_graph(spaceId, tagFilterIds[])`. The caller is a
  visualization that genuinely wants every node; pagination is wrong.
  Cost: S–M (depending on whether tag-filter is folded in).
- **`src/components/PropertyRowEditor.tsx:254`** → either a typeahead
  command (`search_pages_by_prefix(prefix, spaceId, limit: 50)`) wired
  to user input, or cursor-paginated `usePaginatedQuery`. Typeahead is
  better UX at 1000+ pages. Cost: S.
- **`src/hooks/useBlockResolve.ts:99`**, **`src/lib/template-utils.ts:175`**,
  **`src/hooks/useBlockDatePicker.ts:143`** → same shape; convert to
  typeahead or cursor-paginated. Cost: S each.

### 2b. Cursor pagination (when the UI is genuinely a list view)

- **`src/stores/page-blocks.ts:loadSubtree:125`** → either thread cursor
  pagination per parent (a parent with >100 children is rare but real),
  or — better — use a single recursive CTE in a database-native
  `load_page_subtree(rootId, spaceId, maxBlocks)` command. The recursive
  CTE already exists in the codebase pattern (see migration 0021's
  backfill). Cost: M; risk: MEDIUM because the editor's incremental-
  render hooks key off this loader.

### 2c. Typeahead

- **`src/components/SearchPanel.tsx:138`** → `limit: 20` is a typeahead
  shape but the JS `.filter()` makes it broken. Either fold the user's
  query into a `searchBlocks` call (FTS5) or drop the filter and just
  show "the most recent 20" with a "show all" path. Cost: S.

### 2d. Just fix the count

- **`src/components/ViewDispatcher.tsx:useTrashCount:111`** → call a
  dedicated `count_trash(spaceId)` IPC instead of `listBlocks` +
  `.length`. Cost: S.

### 2e. Already at the ceiling, accept fragility

- **`src/hooks/useDuePanelData.ts:210, 261`** → routes through
  `list_agenda` whose cap is 500. At-edge but not currently broken.
  Add a code comment + assertion that this depends on the agenda cap
  staying ≥500. Cost: S.

- **`src/components/TagList.tsx:63`** — limited by `MAX_TAGS_PREFIX = 200`.
  The list view UI doesn't paginate but tag prefix searches are typeahead
  by design; if the workspace has >200 distinct tags this is broken.
  Convert to cursor-paginated `usePaginatedQuery`. Cost: S.

**Total Phase 2 cost:** roughly 2× S each ≈ 1 week of focused work,
or split across two sub-PRs (HIGH severity sites first).

- **Risk:** LOW per site (each is local).
- **Impact:** HIGH cumulative. Closes every known instance of the
  BUG-48 anti-pattern.

---

## Phase 3 — Typed boundary so the next one fails at type-check

**Goal:** make it impossible to write a new BUG-48 by accident.

**Approach (TS):** introduce a branded type for "this number was
validated against the IPC's known clamp," and make the IPC wrappers
accept only the brand:

```ts
// src/lib/tauri-types.ts
export type SafeLimit = number & { readonly __safeLimit: unique symbol }

export function safeLimit(n: number, max: number): SafeLimit {
  if (n < 1 || n > max) {
    throw new Error(`limit ${n} exceeds bound ${max}`)
  }
  return n as SafeLimit
}
```

Then change `listBlocks`'s parameter type so `limit` is `SafeLimit | undefined`,
not `number | undefined`. Every existing call site fails to compile until
it's been audited.

For call sites that legitimately want "all of X", expose a separate
function (`listAllBlocks` / `listPagesForGraph`) that does NOT take a
limit and is backed by a Phase-2-style database-native command.

**Variant for Rust side:** wrap the limit in a newtype
(`pub struct PageLimit(pub i64)`) constructed only via a checked
constructor; the `#[tauri::command]` boundary takes the newtype.

- **Risk:** MEDIUM. Touches every IPC wrapper signature. Manageable
  because IPC wrappers are a small surface (`src/lib/tauri.ts`).
- **Impact:** MEDIUM long-term. Phase 1 already turns runtime fallout
  loud; Phase 3 turns it into a compile-time error.
- **Cost:** M. One pass through `src/lib/tauri.ts` and `src/lib/bindings.ts`,
  plus a per-call audit.

---

## Sequencing

1. **Phase 2a + 2b for the four HIGH-severity FE sites first**
   (page-blocks subtree, PropertyRowEditor, GraphView helpers + graph
   export). Each is independent. Land them as separate small PRs so a
   regression in one doesn't block the others.
2. **Phase 1** (strict clamp) — land alongside the last HIGH Phase 2
   PR. The strict clamp will catch any HIGH-severity site we forgot.
3. **Phase 2c–2e** (MEDIUM severity sites) — these become loud
   validation errors after Phase 1 if anyone hits them, so the urgency
   shifts from silent-data-loss to integration test breakage. Fix on
   demand.
4. **Phase 3** (typed boundary) — once Phases 1+2 have settled. Don't
   start until the table above is empty; otherwise you're rewriting
   types for sites you'll change anyway.

## Cost / Impact / Risk summary

| Phase | Cost | Impact | Risk |
| ------- | ------ | -------- | ------ |
| 1 — strict clamp | S | HIGH (closes the silent-truncation class) | MEDIUM (must land with Phase 2 HIGH fixes) |
| 2 — per-site conversions | ~1 week | HIGH (closes every known instance) | LOW per site |
| 3 — typed boundary | M | MEDIUM (compile-time guarantee for the future) | MEDIUM (touches IPC wrappers) |

## Kill criteria

- If Phase 2's database-native commands need migrations and we're in a
  schema freeze, defer Phase 1 (the strict clamp) until the migrations
  ship — flipping it on with stale FE callers in place will break the
  app.
- If `safeLimit` (Phase 3) ends up requiring brand juggling at every
  call site (because typeahead vs paginated vs all-of-X take different
  argument shapes), prefer a runtime audit/lint rule (eslint plugin
  matching `listBlocks(...{ limit: <number-literal> })` patterns) over
  the type system. Same enforcement, less churn.
