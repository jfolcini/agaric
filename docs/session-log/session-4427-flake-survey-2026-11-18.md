# Session 4427 — three CI flakes from the 2026-11-18 survey

**Ask.** Root-cause three reds a CI survey called flakes, and fix each cause.

**PageModeEditor caption read (vitest).** Run 44444707231 failed with `no [data-testid="image-caption-input"] in the photo block`. The Shift+Tab redraw remounts `AttachmentImage` with no object URL yet. The section's `data-alignment` is there at once, so the `waitFor` on it passed, but the caption input mounts only once `readAttachment` resolves. The read now waits. The other one-shot reads in the test follow a wait on the loaded image, whose render holds the toolbar and caption too. `page-attachments.test.tsx` never redraws, so it does not have the race.

**Mirror inbound `diverged` (e2e-tauri).** Run 44231948303 was on PR #6882, a branch cut before #6890. #6890 replaced that one-shot status read with a wait for the end of the next pass. The spec has since moved to `e2e/mirror-inbound.spec.ts` on the bridge, where `mirrorPassAfter` does the same. Listing a settling file as diverged is intended (`read_edit` in `src-tauri/src/mirror/mod.rs`), so nothing in the product changes. The sibling read in `e2e-tauri/mirror-outbound.e2e.ts` waits on the file holding the write-back, and `page_ok` runs right after that write, so it has no window.

**Android launch (scheduled).** Not a flake. Run 44309605975 tested 65b939e, which sits between #6908 (catalog `Get Started` became `Get started`) and ebe2b8d (the script reads its labels from the catalog). At 65b939e the script's hardcoded `Get Started` no longer matched the welcome dialog's button, so it never dismissed the dialog. Main already has the fix.

**Falsified.** A 50 ms delay injected into the `readAttachment` chain turns the old test red with the CI error, and the fixed test passes under it.

**Ran:** `npx vitest run src/editor/page-mode/__tests__/PageModeEditor.test.tsx`, with and without the delay.
