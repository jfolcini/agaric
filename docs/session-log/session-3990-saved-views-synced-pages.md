# Session 3990 — saved views are pages that sync

`Closes #6544` (last box). A saved view, of the Pages browser or of Advanced Query, was a
per-device preference. It is now a page of its space carrying the internal `saved_view` property,
whose value is the view (`v1:` plus base64url JSON), so views sync between devices and a deleted one
waits in the Trash. No migration, op type, table or store.

- **Hidden everywhere a page is listed.** One SQL fragment, `filters::NOT_SAVED_VIEW`, sits in every
  page listing, the Pages metadata query and its count, the three search scans, the advanced-query
  predicate, inline query blocks and `list_by_type`. By-id reads, by-property reads, the Trash,
  history and sync still see a view. `list_by_type` loses the `view_type` clause it replaced, which
  nothing wrote.
- **`NOT IN`, not `NOT EXISTS`.** `NOT EXISTS` changed two pinned query plans. `block_id` is
  `NOT NULL`, so `NOT IN` is safe, and SQLite answers it from `idx_block_props_key` once per query.
- **A view holds no page name.** `SpacePageNames` leaves views out, so a page can be created with,
  or renamed to, a view's title, and a restored view never collides. A view still cannot be renamed
  onto a page's title. Two views with one title, and a view named like a journal date, are refused
  by the frontend only.
- **A save is two writes.** `create_page_in_space`, then `set_property`. If the second fails the
  frontend trashes the page it made, so no empty page is left in the list.
- **Deleting a space.** Once views stopped counting as pages, a space holding only views read as
  empty but refused to delete. The delete now takes the views with it, in the same transaction; a
  space holding a real page is still refused, and the message counts real pages only.
- **Device views are moved once.** The views a device had saved become pages on first load of the
  space, then the old preference is cleared.

Two small follow-ups from earlier PRs of this sweep ride along: a failed bookmark write shows a
toast, and `template-utils` gained the tests its mutation report asked for.

Known limits, all in the PR body: views are not in the vault ZIP export or the Markdown mirror;
restoring a deleted space leaves its views in the Trash; a batch delete of a space id leaves the
space live in the engine, which predates this change and has no caller.

Checks run: `cargo check` and `cargo clippy` over the workspace with all targets, the sqlx cache
check, the whole nextest workspace in two partitions, vitest for the mock, `src/lib`, `src/hooks`
and the touched component folders, typecheck, lint, the manual-stage hooks, and the saved-views,
spaces, trash and history Playwright specs. Each exclusion and each step of the space delete was
shown red by breaking the code it covers. `e2e-tauri` and the benches that time these queries did
not run locally.
