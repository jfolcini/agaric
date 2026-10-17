# Session 2401 — Happy-path specs for the page editor, templates, tabs, trash and history

These are #5737's mock-lane items, part of the #5726 sweep. Each spec
drives the UI and asserts a re-read effect, and each was shown red by a
product mutation.

**Shipped:**
- **`page-kebab.spec.ts`**
  - The kebab's Undo, Undo, Redo walks two block edits back and forward.
    `page.clock` keeps the two edits apart, because edits closer than
    `UNDO_GROUP_WINDOW_MS` merge into one undo entry.
  - Insert emoji writes into the page title, not a block
    (`handleTitleEmojiSelect`).
- **`templates-view.spec.ts`**: a journal template's row shows its first
  block and the Journal template badge. A plain template's row shows the
  Page template badge.
- **`recent-pages-strip.spec.ts`**
  - The strip hides the page in the active tab. It lists newest first, and
    a click moves the page to the front.
  - A middle click and a Ctrl click each open a background tab. They are
    separate code paths.
- **`sidebar-resize.spec.ts`**: a dragged width comes back on a fresh
  boot, in a second page of the same context.
  - A navigation round-trip can't fail here, because `SidebarProvider`
    never remounts.
  - The `consoleErrorGate` fixture in `helpers.ts` now watches every page
    of the context, so the second page's console errors aren't dropped.
- **`trash-badge.spec.ts`**: the Pages-header Trash count, each row's
  `from:` breadcrumb, and the count dropping after a restore.
- **`history-advanced.spec.ts`**: a durable op-type filter test replaces
  the call-shape test. The header said the mock ignores `opTypeFilter`, but
  `matchesOpType` applies it.
- **`block-history-sheet.spec.ts`**: Ctrl+Shift+Y lists only the focused
  block's edits.

**Premises that were wrong:**
- The page property table item was already covered by
  `properties-table-and-refusals.spec.ts`, and the table has no chips.
- The vim-keys item found a bug. End and PageDown don't reach rows outside
  the History list's virtualised window. That fix ships in its own PR with
  `history-keyboard.spec.ts`.

**Trap:** a falsification that leaves a variable unused fails `tsc -b` in
`build:e2e`, so the web server never starts. That is a build break, not a
kill. One builder's red was this, and its reviewer re-ran the mutation in a
type-correct form.

**Running in a cloud session:** run the parallel Playwright worktrees each
on its own port, through a gitignored wrapper under `pw.local/` that
overrides `baseURL`, the storage-state origin and the web server port. This
box's Playwright pins a newer Chromium than `/opt/pw-browsers`, so the
wrapper also sets `launchOptions.executablePath`.

**Ran:**
- every new and changed spec with `--repeat-each=3`, and all of them
  together once;
- `npm run typecheck`, `npx oxlint e2e/` and oxfmt.
