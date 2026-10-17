# Session 2455 — Happy-path specs for pickers, the slash menu and keyboard chords

These are #5734's mock-lane items, part of the #5726 sweep. Each assertion
was shown red by a product mutation, and a reviewer re-ran every mutation.

**Shipped:**
- **`keyboard-chords-page.spec.ts`**
  - Ctrl+Shift+E puts the page's Markdown on the clipboard under its title.
  - Ctrl+Shift+G opens the graph in local mode on the page.
  - F3 and Shift+F3 step the find match.
  - The Tab indents blocks switch decides whether Tab indents, durably, or
    moves focus.
- **`slash-commands-happy-paths.spec.ts`**
  - `/cancelled`, `/schedule`, `/bullet-list` and `/code` each survive a
    reopen.
  - `/duplicate` copies the just-typed text.
  - A used command leads a Recent group in the empty-query menu.
- **`picker-happy-paths.spec.ts`**
  - `[[` offers a page by an alias its title lacks, and links the page.
  - `/link`, `/tag` and `/block-ref` each insert a chip that survives a
    reopen.

**Premises that were wrong:**
- **Ctrl+Space** can only remove the last-selected block from a selection,
  never add one, and it does nothing while editing. That is a design
  question, asked on #5734; no spec pins the half that works.
- **The issue's `proj` alias** matches a page by its title too, so it never
  exercises the alias. The spec uses `huddle` on Meetings. The alias shows
  in the option label, not a breadcrumb.
- **There is no `/property` command.** `docs/features/pickers-and-slash.md`
  claimed one, and said `effort` offers a custom value. Both claims are
  corrected.

**Fixes found on the way, each in its own PR:**
- the slash formatting marks inserted literal delimiters;
- `/table 4x6` couldn't be typed;
- an emoji picked from the emoji picker never reached the block.

**Not here:**
- `/emoji`'s spec, which ships with its fix;
- `/table-no-header`, removed by the maintainer;
- the table size, now a grid that `/table` opens, in its own PR;
- `/repeat`, an `e2e-tauri` item.

**Ran:**
- the three spec files together after rebasing on main, and the two slash
  and picker files with `--repeat-each=3`;
- `npm run typecheck` and oxlint.
