# Session 2500 — embed render states (#5736)

Mock-lane specs for #5736 item 10, in `e2e/embed-render-states.spec.ts`.

**Setup:** the embed tokens are written through the mock, as sync would
write them. Everything else is driven through the UI.

**Specs:**
- **A block embed:**
  - It renders its subtree from depth 0 under its source strip, page title
    and crumb.
  - Collapsing it is still collapsed after leaving the page and coming back,
    and expanding restores the rows.
  - Open source lands on the page.
- **A page embed** renders the page's top-level blocks under the page title
  alone.
- **A trashed source:**
  - The embed shows *Source deleted*.
  - *Restore from Trash* opens the Trash view, and restoring the row there
    brings the source back, in the embed and on its page.
- **A cycle:** A embedding B embedding A shows *Already shown above* inside
  the embed where the loop closes.
- **An unrepeated chain** stops at `MAX_EMBED_DEPTH` with *Nested too deep*
  inside the innermost embed.

**Corrections to the issue:**
- **Restore:** *Restore from Trash* restores nothing itself. It opens the
  Trash view, where the user restores the block.

**Item 14 is not covered:**
- **The premise is false:** clicking a broken cross-space chip shows a
  toast and changes nothing, so Ctrl+Z has nothing to restore.
- **The promise exists elsewhere:** the docs and two unused strings promise
  click-to-remove.
- **Next:** the choice between correcting the docs and building it is asked
  on #5736.

**Shown red:**
- **Block embed:** the collapse state never saved.
- **Page embed:** the page-target branch skipped.
- **Restore:** the button opening the journal instead of the Trash view.
- **Cycle:** the cycle check disabled.
- **Depth:** the depth cap off by one.

**Ran:** the new file with `--repeat-each=3`, the existing embed spec,
`npm run typecheck`, oxlint and oxfmt.
