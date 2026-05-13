# Agenda load-more cursor-namespace mismatch — 2026-05-13

> **Status:** **latent bug, flagged during sql-audit H3 review** (Session 706).
> Pre-existed before H3 — H3 didn't introduce it, but H3's change made it
> easier to see in the diff. Fix is small but its own commit per
> commit-hygiene rules.

## The bug

`src/components/journal/AgendaView.tsx` has two paginated paths:

1. **Initial fetch** (active-filter branch) goes through `executeAgendaFilters`
   which (post-H3) calls `filteredBlocksQuery` once. The response includes
   `next_cursor` — a `b.id` in the **`filtered_blocks_query` cursor
   namespace** (i.e. "next id after this in the AND-intersection of the
   supplied filters").
2. **Load more** (`AgendaView.tsx:90-107`) calls
   `queryByProperty({ key: 'todo_state', cursor: agendaCursor, … })` with
   that same cursor.

`queryByProperty` is a different IPC with its own keyset cursor — its
`b.id > ?` predicate runs against a different result set (the
`block_properties` join for `key='todo_state'`, no filter intersection).
The cursor minted by `filtered_blocks_query` is meaningless to it.

**Visible symptom:** page 2 returned by load-more is silently wrong. It
has the right *shape* (a list of `BlockRow`) and the right *single-filter*
meaning (`todo_state IN ('TODO','DOING')`), but it doesn't continue
page 1's AND-intersected set.

**When it fires:** only if (a) active filters are set AND (b) the
filtered intersection returns ≥200 matching blocks (so `has_more` is
true on the initial fetch). Both are uncommon for typical agendas.

## Why it's pre-existing

Before H3, `loadMoreAgenda` was also calling `queryByProperty` with a
cursor from the old fan-out path. The fan-out stored the cursor from
the *first* sub-query, which had a similar wrong-namespace issue. H3
didn't change `loadMoreAgenda`; it only changed how `agendaCursor`
gets populated on the initial fetch.

## Fix options

### Option A — route load-more through `filteredBlocksQuery`

Pass the same `propertyFilters` / `tagFilters` payload to a follow-up
`filteredBlocksQuery` call with the existing cursor. Either:

- Refactor `executeAgendaFilters` to accept an optional `cursor`
  argument and reuse the existing translation logic, or
- Add a sibling `loadMoreAgendaFilters(filters, cursor, spaceId)` that
  shares the translation helpers.

**Pros:** correct page 2; preserves the AND-intersection across pages.

**Cons:** the FE has to retain the filter payload across the
load-more click (today it's stored in component state already, so
this is cheap).

### Option B — remove load-more from the active-filter branch entirely

With `PAGINATION_MAX=200` and the typical agenda fitting in one page,
load-more on the active-filter branch is rarely useful. Hide the
button when filters are active. Continue exposing load-more for the
default (no-filter) path, which uses `queryByProperty` directly with a
matching cursor namespace.

**Pros:** smallest diff. No new code paths.

**Cons:** users with >200 matching agenda items lose access to the
overflow (low-frequency, but worth flagging).

### Recommendation

**Option A** is the right fix — page 2 should continue page 1's
intersection, not silently fall back to a different result set.
Option B masks the problem rather than fixing it.

## Cost

- Option A: **S (~half a day).** Mostly mechanical: extract the
  translation helpers in `agenda-filters.ts` into a shared function
  that both `executeAgendaFilters` and the new `loadMoreAgendaFilters`
  can call. Update `AgendaView.loadMoreAgenda` to dispatch through
  the new helper. Add one test asserting page 2's intersection
  matches the expected AND-intersection of the filters.
- Option B: **S (~1-2 hours).** Conditional render of the
  load-more button.

## Risk

**Low.** Active-filter pagination beyond page 1 is uncommon in
practice; the bug has been latent through multiple sessions without a
user report.

## Related

- Session 706 (commit `60a104cb`) — H3 frontend agenda migration that
  surfaced this in review.
- `src/lib/agenda-filters.ts` — `executeAgendaFilters` (post-H3) and
  the translation helpers (`appendPropertyFilters`,
  `resolveTagFilters`, etc.) that a load-more helper would share.
- `src/components/journal/AgendaView.tsx:90-107` — the
  `loadMoreAgenda` call site.
- `src-tauri/src/commands/queries.rs:735` —
  `filtered_blocks_query_inner` (the correct backend for load-more).
- `src-tauri/src/pagination/properties.rs` — `query_by_property` (the
  currently-mis-used backend).
