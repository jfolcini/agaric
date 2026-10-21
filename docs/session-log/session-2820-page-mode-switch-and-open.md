# Session 2820 — page mode opens on the current text, keeps typing bounded, and does not let a failed save switch away

Four findings of the #5691 review of 2026-10-21, verified by a second pass, were fixed together because they share the switching and opening code.

- **The shortcut opened page mode on a stale page.** `Ctrl+Shift+M` within the idle delay of the last key opened page mode without that text: the draft flush had saved it, but nothing refreshed the page store, and the first page-mode edit of the block wrote the old text back. Clicking the switch was fine because the click blurs the editor first. `takeCursor` (`use-page-mode.ts`) now blurs the active editor before taking the cursor, so block mode's own blur commits through the store on every path, including page mode coming back by itself once a page fits the cap again.
- **A failed flush let the user switch away.** `flush()` resolved the same after a failed save, so the switch back to blocks and Edit as Markdown unmounted page mode with the unsaved text. `flush()` now resolves whether the document still holds a write the save did not make, and both stay in page mode when it does. Leaving the page by navigation still runs the unmount flush and its toast but cannot be held back; page mode has no draft row for boot recovery to restore from.
- **Steady typing never saved.** The idle timer restarted on every key, so typing without a pause wrote nothing and a hard kill lost the whole run. A deadline set at the first unsaved change now caps the wait at block mode's `DRAFT_MAX_LATENCY_MS`.
- **A new or empty page did not take typing.** When page mode opens on a page whose only block is empty, it now focuses the document, as block mode focuses its first block; a page with text keeps the focus where it was.

`usePageMode` also selects the block count instead of the whole block array.

Suites run: `npx vitest run src/editor/page-mode src/components/pages/__tests__/PageEditor.test.tsx`, typecheck, lint, and `e2e/page-mode.spec.ts` with `e2e/page-mode-setting.spec.ts` on fresh builds. Each new test, including the two new Playwright cases, was shown red by breaking the code it covers, and both e2e cases also failed on the unfixed build.
