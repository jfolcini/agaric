# Session 4339 — a slash command commits the editor's pending text first

Fix for #6935, found while moving `page-mode.spec.ts` onto the bridge (#6926 slice 7).

**Cause:** a block-mode slash command that rewrites the block (`/h2`, a callout, a divider) goes through `applyContentEdit` (`src/components/block-tree/use-block-slash-commands/helpers.ts`), which writes with `edit_block` and then remounts the editor. The editor's debounced commit of its text, `call mom ` once the `/h2` query is stripped, was still pending. On the mock the IPC answers at once and the remount lands first. With real IPC latency the commit fired during the write, issued after it with its pre-command base `call mom`, and the backend's merge kept both trailing spaces: `## call mom  `. On the bridge, *a slash command leaves the backend as block mode's does* failed 3 to 5 runs in 10.

**Fix:** `applyContentEdit` flushes the pending commit before its write, through `flushActiveDraft`, as the list-style path already does (#4577). Page mode's own `blockText` path is unchanged.

**Test:** `useSlashCommandStructural.test.ts`'s *writes the pending in-editor content before the heading, never after it (#6935)* registers a pending commit and runs `/h2`. It expects the pending text written first and the heading last. Without the fix it reads `['## hello', 'call mom ']`, the pending commit landing after the heading, which is the order the bridge showed.
**The bridge test:** *a slash command leaves the backend as block mode's does* moves back into `page-mode.spec.ts`, which `REAL_BACKEND_SPECS` already lists, and `e2e/page-mode-slash-parity.spec.ts` goes with its copied helpers (#6947's review). On the bridge it failed 4 runs in 10 with the flush taken out, and passed 20 of 20 with it.

**Also:** `read()`'s docstring in `PageModeEditor.tsx` no longer reads as a ban on subscribing, which it now does while it waits (#6942's review).

**Ran:** `npx vitest run src/components/block-tree src/components/editor src/editor` (235 files, 7643 passed); the mock-lane `slash*` specs and `kind-change-undo` (57 passed); `npm run typecheck`.
