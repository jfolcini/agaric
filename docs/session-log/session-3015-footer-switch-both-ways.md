# Session 3015 — Switch between page mode and Edit as Markdown from the footer, both ways (#5691)

Set out to build PR-B of the three-modes review: GitLab's "Switch to plain text editing" and back, for page mode and *Edit as Markdown* (`modes-code-review.md` § (d)).

**Shipped.**
- **Page mode's document footer** holds the hint on the left and an *Edit as Markdown* link on the right. The link goes through `handleEditSource`: flush, reload, swap.
- **The Markdown buffer** has a *Page* link at the left of its Cancel/Save row, and `Ctrl+E` / `Ctrl+Shift+M` does the same. A changed buffer is saved through Save's own dialogs (conflict, refusal, emptying). Page mode then opens on the reloaded page, with the caret at the page's start. An unchanged buffer switches straight away and writes nothing.
- **The link is optional everywhere.** No handler means no link: the journal's day, touch and tag pages. Over the block cap the *Page* link is shown disabled, with the reason as its description.

**Decisions and traps:**
- **One exit ref, `exitTo`.** Save sets it to close and the link sets it to page, so a stale "page" cannot outlive a refusal, Keep editing, Reload or a cancelled emptying. Merge and Overwrite continue the save that opened their dialog, so they keep its exit.
- **Review found two defects in the Markdown → Page direction:**
  - `Ctrl+E` in an unchanged buffer bubbled to the header's mode switch, which mounted in time to toggle the same key back to Blocks. The buffer's branch now stops propagation, as its Escape branch already did.
  - After the switch, the focus fell to `<body>`, because no block was focused for page mode to retake. The switch now focuses the page's first block.
- **The e2e enters the buffer from block mode,** so the *Page* link landing in page mode tells a switch from a close.
- **Kebab focus:** a switch remounts the header, re-reading properties, aliases and tags, but only Cancel returns the focus to the kebab.
- **Left alone:** if the save itself pushes the page over the cap, the page lands in Blocks without the "too many blocks" notice. No data is lost.

**Suites, after the rebase onto the bullets PR (#6154):**
- vitest over `src/components/pages`, `src/editor/page-mode` and `src/components/journal` (2,084 tests);
- typecheck and lint;
- Playwright: `page-mode-markdown-switch`, `page-mode.spec.ts`, `page-source-edit`, `page-mode-look` and `journal-page-mode` (74).
- In review: the manual hooks, plus `page-kebab`, `page-mode-toolbar`, `page-mode-bubbles`, `keyboard-collisions`, `page-mode-setting` and `obsidian-keymap`.
