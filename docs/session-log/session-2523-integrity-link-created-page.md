# Session 2523 — a page a link creates passes the integrity check (#5741)

**Found:** while writing `e2e-tauri/app-health.e2e.ts` (#5819), Settings ›
App health reported "1 row diverged in `pages_cache.last_edited_ms`". This
happened after an import linked to a missing page, and after a typed
`[[NewPage]]` → Create page.

**Cause:**
- `CommandTx::commit_and_dispatch` raises `last_edited_ms` only for the op
  records in its dispatch queue.
- Each create-page path stamps the new page's `space` with
  `set_property_in_tx`, then drops the record on purpose: a fresh block has
  nothing to re-scope (#5275), and a dispatch would queue three rebuilds.
- So the page kept its create's time while its newest op landed a few ms
  later. A page with children hides this, because their ops raise it. A link
  target or an untouched journal day has none.
- The oracle's floor (the newest op) is right.

**Fix:**
- `CommandTx::enqueue_without_dispatch` holds a record the commit raises for
  but never dispatches.
- The `space` stamps use it in four places: `create_page_in_space_inner`
  (the editor's Create page), the journal day, the bibliography page, and
  the import's `stamp_space_property` (page, link targets, tags).
- `create_tag` is left alone: a tag has no `pages_cache` row.

**Tests:**
- `page_cmd_tests.rs`: three tests, each over ten pages, assert
  `last_edited_ms` equals the page's newest op:
  - an import's link target;
  - `create_page_in_space`;
  - a journal day.
- Each test also fails if no stamp landed after its create. There is no
  injectable clock.
- `app-health.e2e.ts`: the import now links to a page it creates, and a
  typed `[[…]]` adds another.
  - The integrity `it` runs last: a regression's diverged row would
    otherwise reach every later check.
  - The bug-report `it` closes its dialog, because the next `it` could not
    reach the sidebar.

**Shown red:**
- With the `.chain` dropped, all three Rust tests fail.
- Dropping one call site reddens only its own test (editor, import,
  journal).
- On the real binary, the chain dropped makes the integrity `it` report 2
  diverged rows, one per link-created page.

**Review:**
- An instrumented run over every `agaric` test logged each committed op
  that neither queue held on a page row: none.
- Its positive control (two call sites removed) logged both.
- The other `commit_without_dispatch` callers commit before they append an
  op.

**Ran:**
- nextest over the commands, `CommandTx`, reconciliation and import filters;
- clippy over the workspace with all targets;
- `cargo fmt --check` and `SQLX_OFFLINE=true cargo check`;
- `app-health.e2e.ts` twice on a rebuilt binary;
- `npm run typecheck:e2e-tauri`, oxlint and oxfmt.
