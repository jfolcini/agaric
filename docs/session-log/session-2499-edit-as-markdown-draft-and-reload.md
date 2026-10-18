# Session 2499 — Edit as Markdown keeps a draft, and Reload saves nothing

Mock-lane specs for #5733 items 7 and 8, in `e2e/page-source-edit.spec.ts`.
#5685 has merged, so the hold on them is released.

**How the product behaves** (`PageSourceEditor.tsx`):
- **The draft:** unsaved buffer text is stored as a draft, keyed by the page,
  when typing pauses and when the editor unmounts. Going to another page
  unmounts it.
- **Reopening** restores the draft silently, with the note "Restored your
  unsaved edits."
- **Clearing:** Save, Cancel → Discard and Reload each clear the draft.
- **Reload** is a choice in the conflict dialog that Save opens when the
  page changed elsewhere. It swaps the buffer for the page as it is now.

**Specs:**
- **A draft:**
  - Typed text left by going to another page is not saved, and reopening
    Edit as Markdown restores it with the note, still on its block's line.
  - Discard clears it: the next reopen shows the page as saved.
- **Reload:**
  - After another device edits the page, Save → Reload shows the other edit
    and the original line, and Save is disabled.
  - Leaving the page then shows nothing was saved, and reopening Edit as
    Markdown finds no draft.

**Corrections to the issue:**
- **Item 7:** the draft is stored on going to another page; there is no
  separate "close" action.
- **Item 8:** Reload is a choice in the conflict dialog, not a control on
  the buffer.

**Review:**
- **A precondition:** the draft test now waits for the saved block before
  asserting it lacks the typed text.
- **Reload's draft clearing:** leaving the page with the buffer open, not
  Cancel, now checks it. Cancel clears the draft itself, so it would have
  hidden a Reload that left one.

**Shown red:**
- **The draft:** never stored, and not cleared by Discard.
- **Reload:** swapping in the opened base instead of the current page, and
  leaving its draft behind.

**Ran:**
- the file with `--repeat-each=3`, and the ULID-token spec;
- `npm run typecheck`, oxlint and oxfmt.
