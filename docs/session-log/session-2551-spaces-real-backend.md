# Session 2551 — spaces on the real backend: delete, move to space, window title (#5739)

Three #5739 Spaces items need the real backend: the mock blocks deleting even a
fresh space, and moving a page fans out over several IPCs and the pages cache.
They share one file, `e2e-tauri/spaces.e2e.ts`, so one app boot.

**Delete:** Settings › Spaces enables Delete for an empty space and refuses one
holding a page (the blocked hint); after confirming, the empty space leaves the
rows and the switcher, and the full one keeps its refusal. The refusal the spec
sees is `SpacesTab.tsx`'s scoped `list_blocks` emptiness probe; the disabled
button never reaches the backend's `verify_deletable_in_tx`. The last-space
refusal can't be shown: a real vault boots with Personal and Work, and Personal
is never empty.

**Move to space:** a page with a child and grandchild moves to Work; it leaves
Personal's Pages list, opens in Work with both levels, a search finds the
grandchild in Work and settles on no results in Personal, and the child's tag
stops counting in Personal's Tags view (`tags_cache` counts only blocks in the
tag's own space).

**Window title:** reads `<Page> · <Space> · Agaric` through the window plugin's
`title` command; WebDriver's `getTitle()` returns `document.title`, which nothing
in `src/` sets.

**Shown red:** the type-scoped `list_by_type` without its space (delete), the
`verify_deletable_in_tx` count check (confirm dialog stays open), the page-group
`space_id` fan-out in `loro/projection.rs` (the tag count), the search's space
filter in `fts/filter_builder.rs` (Personal no-results), `sync_pages_cache_space_ids`
skipped (Personal's Pages list), and the title's view label (title). Under the
fan-out mutation the search assertion was masked, not passing: the boot
`page_ids_backstop` job's first tick ran `rebuild_space_ids` inside its retry
window. The tag count is the dependable check for the subtree.

**Shared helpers:** `switchToSpace` and `switcherLabel` move to
`e2e-tauri/helpers.ts`; `space-scoped-tag.e2e.ts` and
`sync-cross-space-move.e2e.ts` drop their identical copies.
