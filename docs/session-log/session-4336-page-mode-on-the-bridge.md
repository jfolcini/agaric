# Session 4336 — page mode on the bridge

Slice 7 of #6926: the page-mode specs move onto the headless bridge (#6529), and nine WebdriverIO specs are ported into them or deleted. Built on the #6937 fix (#6942).

**Promoted to `REAL_BACKEND_SPECS`:** `page-mode`, `page-mode-durability`, `page-mode-keys`, `page-mode-block-menu`, `page-mode-batch-writes`. One test is `@mock-only`: the durability test that drives `__injectMockError`.

**Ported, then deleted from `e2e-tauri/`:**
- `page-mode-lists`: deleted as a duplicate of `page-mode.spec.ts`'s bullet-and-numbered test, which reads the stored styles after a reopen.
- `page-mode-tasks`, `page-mode-block-menu`: the Agenda lists the task the typed marker and the menu set (`expectInAgenda`). `/todo` and `/due` on a block added in page mode is the slash-menu test, now on the bridge.
- `page-mode-typed-tag`: the Tags list (`tags_cache`) lists the typed tag, and its page lists the block.
- `page-mode-priority-dates`: a due date moved to today in page mode reaches today's Due panel (`agenda_cache`), dated by the real clock.
- `page-mode-properties`: completing a repeating task brings in its next occurrence, due a week on, and both stay.
- `page-mode-queries-embeds`: a query over a tag typed in page mode, and an embed of its block, show that block.
- `page-mode-batch-paste-undo`: one Ctrl+Z takes back a 300-line paste, and the page keeps its one block.
- `page-mode-deleted-elsewhere`: a block deleted through the IPC with no sync keeps the text typed into it as a new block.

**Test races the bridge showed, fixed in the specs:** a picker's Enter before its FTS results came in; a one-shot read of a block's text right after the backend's; a blur before block mode's delayed focus landed after a mode switch; a caret placed before the query builder's close took the focus; an undo group split by `page.clock`, which does not reach the backend (the test now also waits in real time); the delete-elsewhere test racing the delete's own change event; and the Properties sheet, where an Escape while it still loads closes the tooltip of the control that took the focus (the test closes it with its button).

**Real bugs the bridge showed:**
- #6937: leaving page mode right after a change could log `page mode could not read the page`. Fixed first, in #6942. The test that hit it then passed 30 of 30.
- #6935: block mode's save of the text from before a slash command, issued after the command's write, which the backend merges, doubling a space (5 runs in 10). The test moves to `e2e/page-mode-slash-parity.spec.ts`, off `REAL_BACKEND_SPECS` until that is fixed.

**Shown red on the bridge**, each at the predicted assertion: `RebuildAgendaCache` a no-op (Due panel), `build_recurrence_sibling_in_tx` finding no rule (2 blocks, not 3), `ReindexBlockTagRefs` a no-op (no query result), `delete_blocks_by_ids` dropping one id (a pasted block left), a reserved-column filter matching `IS NULL` (both Agenda reads), and page mode's `dropDeleted` treating a typed-in block as untouched (no kept-as-new notice). `RebuildTagsCache` as a no-op reddened the typed-tag test at its existing `list_all_tags_in_space` read, before the added Tags-view read; that read was not shown red on its own.

**Ran:**
- the five files on the bridge, rebased on the fix, four repeats: 316 passed; the test #6937 hit, 30 of 30;
- the same files plus `page-mode-slash-parity` on the mock, two repeats: 162 passed;
- `npm run typecheck`.
