# Session 4320 — trash and references on the bridge

Slice 2 of #6926: the @pages trash and references specs move onto the headless bridge (#6529), and four WebdriverIO specs are ported into them.

**Promoted to `REAL_BACKEND_SPECS`:** `trash-badge`, `trash-bulk`, `trash-deleted-time`, `trashed-page-recents`, `references-filters`, `references-sort`, `unlinked-references`, `rename-invalidation`, `in-page-replace`, plus the two files the ports landed in, `trash-page-cascade` (new) and `page-alias-add`. None needed a `@mock-only` tag.

**Ported, then deleted from `e2e-tauri/`:**
- `trash-page-cascade` → `e2e/trash-page-cascade.spec.ts`: a page deleted from Pages is one Trash row with "+3 blocks", and Restore brings its tree back; a page deleted from its kebab and purged stays out of Pages and Trash after a fresh read. The kebab's step back to the previous page is already `delete-page-tabs.spec.ts`, on the bridge.
- `page-rename-lookup` → `rename-invalidation.spec.ts`: the Pages filter and the `[[` picker find a renamed page by its new title only. The WDIO header said the Pages filter reads a materializer copy; it globs the block's own title (`compile_path_glob_clause`), so only the picker's FTS copy can go stale.
- `page-alias-undo` → `page-alias-add.spec.ts`: Ctrl+Z removes the alias just added, durably. The page's undo groups ops by backend time inside `UNDO_GROUP_WINDOW_MS`, and `page.clock` does not reach the backend, so the test waits until the kept alias's op is older than the window.
- `references-filters`: Status none, Priority none and a two-character Contains term → `e2e/references-filters.spec.ts`. Its Created date test stays in WDIO: the mock's ids carry no time, so it needs the `@real-only` tag of #6926 G2.

**Two test bugs the bridge showed, both fixed:**
- `rename-invalidation`'s two Unlinked References tests both failed in 1 run of 3. The mention block read "he Onboarding Guide": `addBlock` typed before the new editor's focus settled, and ProseMirror's selection write-back 20 ms after the focus ate the first key. It now waits as `focusBlock` does and asserts the typed text. After: 50 of 50.
- `trash-bulk` failed in 2 runs of 3 (one test each time) at its last assertion, expecting -2 rows. It read Getting Started's row count with `count()` once, before the bridge had rendered the rows, so it read 0. It now waits for the seeded five. After: 48 of 48.

**Shown red on the bridge**, each at the predicted assertion, by breaking the Rust it covers and rebuilding: `trash_descendant_counts` returning nothing (badge), `purge_block` not purging (empty Trash after the round trip), `NOT (…)` without `COALESCE` (Status none 0 of 5), `reverse_add_page_alias` removing another alias (badge still there), and edit_block not reindexing a page's FTS row (picker still offers the old title).

**Ran:**
- the 11 files on the bridge after both fixes, three times: 32 passed each time;
- the same files on the mock, three repeats: 96 passed; `trash-bulk` again after its fix: 12 passed;
- `npm run typecheck`.
