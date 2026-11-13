# Session 4095 — page mode's e2e coverage: text, paste, slash commands, math

Second PR of #6714 (the first is #6716, session 4090): the rows where page mode types, pastes or runs a command through its own path and no spec drove it.

## Shipped

- `e2e/page-mode-text.spec.ts`: the mark chords, Markdown typed as text, the `@` picker and an `@` in prose, `[[Page|label]]`, a `key:: value` line the backend refuses.
- `e2e/page-mode-paste.spec.ts`: HTML from a web page, a `javascript:` link, a task line into an empty block and into text, a URL over selected text.
- `e2e/page-mode-slash.spec.ts`: twelve commands run on the same block of twin pages, one per mode, the stored rows compared with each other and with what the command should write; `/table` in page mode alone.
- `e2e/page-mode-math.spec.ts`: typed `$…$`, the math source field, a Mermaid fence.

No product code changed.

## Found

- **A bug, not fixed here:** HTML pasted in page mode keeps an `<img>` whatever its `src`, so `<img src="javascript:…">` is stored as `![alt](javascript:…)` and drawn. Block mode drops it (`html-paste-1439.spec.ts`). The typed `![…](…)` rule already gates on `isValidImageSrc`; the image node's HTML parse rule does not. The fix and its spec are the next PR of #6714.
- **A difference, left for the maintainer:** `/table` on a block that holds text puts the table in that block in page mode and in a block of its own in block mode. A list pasted as HTML is one block in page mode and a block per item in block mode. Both are in #6714.

## Traps

- Three arms were written, could not be shown red by breaking app code, and were dropped rather than shipped: typed arithmetic staying text (the input rule's pattern, not the flank check, refuses it), a URL pasted alone becoming a link (the paste handler, autolink and the library's paste rule each do it), and Backspace in the math source field not joining blocks (TipTap stops an input's keys before the two guards in the app).
- A slash command with the pointer left where its popup opens: `/table`'s grid takes its size from a hover, so the spec picks the command from the keyboard.
- `oxlint` rejects a `then` field on an object literal (`unicorn/no-thenable`); `npm run typecheck` and the Playwright run both pass with it.

## What ran

- The four specs, green on one worker; the same with `--repeat-each=8 --workers=6`, all green after the grid fix above.
- Each test shown red once by one mutation of the code it covers, listed in the PR body; `git status` clean after.
- `npm run typecheck`, `npm run lint`, `node --test scripts/e2e-related.test.mjs`, `prek run --hook-stage manual --all-files`.

Not run: vitest and the Rust suites (no `src/` or `src-tauri/` change), the full Playwright lane, the real-backend lane.
