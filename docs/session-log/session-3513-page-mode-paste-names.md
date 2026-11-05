# Session 3513 — Page mode's paste resolves names (#6033 S12)

Set out to build #6033 S12. In page mode, a pasted `[[Name]]`, one line or many, was saved as escaped text (`\[\[Name\]\]`), so no page was linked or created. Foreign forms were missed the same way.

**Premise check: the plan's mechanism (Q7) could not work.**
- The plan was a leave-time commit that scans each block's saved markdown and saves through a thin command over `edit_block_resolving_names`.
- But the serializer always escapes `[` and `]`, and `scanNameTokens` skips escaped tokens, so the scan finds nothing.
- On a multi-line paste, `parse` had already decoded `\(x\)` to `(x)`.
- Three options went back on #6033. The maintainer chose A (comment 6649048892): reuse block mode's path, with nothing new in Rust.

**What shipped.**
- A page-mode paste that block mode would send to the block path (`needsBlockPath`, or a multi-line paste that `onlyBlockPathReads`) is no longer inserted into the document.
- Instead, page mode saves the block and lands the paste through the existing `paste_blocks` with a page-mode splice (`spliceAround`, shared with block mode). It then re-reads the page and puts the caret at the join, scrolled into view.
- The paste counts as a write (`save.writes += 1`, the idiom page tags use), so the store's own queued reads go to the backend instead of bringing in stale rows.
- A refused paste, or a block that could not be saved, goes in as plain text, so nothing is lost.
- Pastes that don't qualify, dropped text, HTML clipboards, and pastes inside a list or table or across blocks keep today's path.

**Review fixes.**
- `clipboardTextParser` also runs for drops, so the first build swallowed dropped text that held a name. The parser now claims only during a DOM `paste`.
- The caret is now scrolled into view after a routed paste.
- Three vacuous or missing tests were replaced: the cross-block case, the list-line route, and the end-of-block guard.

**Trades.**
- Ctrl+Z in the editor doesn't undo the routed paste; page-level undo does, and an e2e test pins it.
- Typing in the block while its `paste_blocks` call is in flight loses text. Block mode loses the typing instead. That is filed as #6364, with why each fix the review tried fails.

**Tests.**
- `e2e/page-mode-paste-names-6033.spec.ts` covers one line, several lines, page-level undo and a drop. It was red before the fix.
- New vitest: `page-paste-block-path.test.ts` and `PageModeEditor.block-path-paste.test.tsx`.
- Reds shown for every new guard: the route decision, the splice end, the refusal and save-failure fallbacks, the caret, the `save.writes` bump, the range mapping, the drop gate and the undo entry.
- Gates: typecheck, lint, all hooks (including the manual stage), the editor, block-tree and lib vitest suites (12261 passed), 262 paste and page-mode Playwright tests, and the bundle budget.
