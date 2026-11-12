# Session 3906 — Review notes from tonight's merged PRs

Collected the non-blocking reviewer notes on #6573, #6574, #6582, #6583, #6592 and #6593, each
checked against the code first.

Done: dropped `testsuites|testsuite` from the flaky-report tag regex (only `testcase` and the
flaky elements are parsed); Phase A2's failure hint now names `SKIP=<hook-id>` (the caller's
`SKIP` is composed into the phase) and `install_nextest`'s fallback URL uses `${platform:-linux}`;
`createStructureButtons` is called once with the indent buttons appended on touch; the
fixture-isolation header no longer narrates the file's past; `findInBlocks` lost its unused
`options`; `syncBlockHighlights` no longer guards `setRevealBlockId(null)` (the only
non-selector subscriber, `useSearchSheetBridge`, returns early on an unchanged container); the
#6544 journal-format tests clear `localStorage` in `afterEach`, not in the test body; the
"defaults to Journal view" App test now waits for the add-block button.

Left alone, on purpose:
- `createHistoryButtons` `touch` default: `PageSourceToolbar` calls it without the argument.
- `PageHeaderMenu` `onOpenHistory` is optional by design (the row is hidden without it, and a
  test pins that); `HistoryRestoreDialog` `pageId` is omitted by its own tests.
- Palette welcome copy: the desktop `<p>` sits above the list because a listbox may hold only
  options; the mobile `CommandEmpty` sits inside it. Different elements for a reason.
- `undoDeleteOf` single-ref `undoOp` branch: its tests assert `undoOp` is the command called
  and that its taken-name rejection surfaces; collapsing would edit them.

Falsification of the App test: with the journal's add-block labels removed in `DaySection`
(the "Add block" icon button and "Add your first block"), the test fails; removing only one of
them does not, since `/add.*block/i` matches both.
