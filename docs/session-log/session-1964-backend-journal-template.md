# Session 1964 — journal days get their template wherever they are created (#5395)

The journal template was applied only when the journal view created the day
page. A day first created by an agent (`journal_for_date`), by Quick Capture,
or as a dated page title got no template, and opening it later added none.

What shipped:

- `apply_journal_template_in_tx` (`src-tauri/src/commands/journal.rs`) copies
  the space's journal template page into a new day inside the caller's
  transaction, so one undo reverts the day and its template.
  `copy_page_blocks_in_tx` (`commands/pages/markdown.rs`) renders the
  template as a source buffer and parses it back, keeping nesting,
  properties and task state within the depth bound and the undo cap.
- Callers: `resolve_or_create_journal_page` (`journal_for_date`,
  `today_journal`, `navigate_journal`, `quick_capture_block`) and
  `create_page_in_space_inner` for a date title. An existing day gets
  nothing re-inserted.
- The template is the live page with `journal-template = true` and the
  smallest id; a second one is logged and ignored; a trashed template or none
  gives an empty day.
- Variables expand against the day being created: `<% today %>`,
  `<% page title %>`, `{{date}}` and `{{title}}` are the date; `<% time %>` is
  the wall clock. Documented in `docs/features/spaces.md`.
- The frontend no longer instantiates the template; it focuses the first
  block the backend created. The mock mirrors the backend, pinned by
  `conformance/fixtures/journal_template_day.json`.
- `e2e-tauri/journal-template-quick-capture.e2e.ts`: Quick Capture into a new
  day, open it, the template is there.

Verified: red with the copy's refusal disabled, with the template call
dropped from `create_page_in_space_inner`, with the mock's old quick-capture
fallback, and with the frontend probe re-throwing (each on a copy, restored
and `cmp`-checked). `cargo nextest run --workspace` 6,738 passed (five
timed out under load and passed alone); clippy, offline sqlx check, `sqlx
prepare --check` and fmt clean; vitest targets, typecheck, oxlint and
oxfmt clean.

Rebased onto #5438 (#5460), which had made the frontend run the template
lookup alongside page creation and park an empty subtree when there was no
template. With the backend owning the template, the frontend lookup goes, and
the park now follows the first-child probe: it parks only when the probe
succeeded and found nothing, since parking an empty subtree for a day the
backend seeded would make `autoCreateFirstBlock` add a block. #5438's two park
tests now drive `first_child_for_blocks` (empty, seeded), plus a failing-probe
arm, which goes red with the probe check removed. The five journal suites
pass (201 tests).
