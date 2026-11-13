# Session 4090 — page mode's e2e coverage: data loss and structure keys

The maintainer asked whether page mode lags block mode in end-to-end coverage, and for the gaps to be listed and closed. #6714 holds the comparison, behaviour by behaviour, with the commands that reproduce it. This is the first of its PRs: the rows where a regression loses text or structure.

## Shipped

- `e2e/page-mode.ts`: the seeded page, the *Editing mode* switch, the document as shown and as the backend holds it, and the caret, for page-mode specs on the mock lane. `e2e-tauri/page-mode.ts` is its twin. The existing page-mode specs keep their own copies; moving them is not this PR.
- `e2e/page-mode-durability.spec.ts`: typing that never pauses, the window hidden and closing, a refused save, redo in the text, the page's undo and redo shown in the open document, an agent's write, a search hit landing the cursor.
- `e2e/page-mode-keys.spec.ts`: Delete at a block's end, Enter at and inside a heading, Shift+Enter and Enter in a code block, Backspace and typing over a selection across blocks, Ctrl+A then Backspace, *Tab indents blocks* off.

No product code changed: every behaviour was already there and already right.

## Traps

- `page.keyboard.press('Control+Shift+k')` sends `key: 'k'` with Shift held. ProseMirror's keymap then falls back to the binding without Shift, so the inline-code chord opened the link popover and looked like a page-mode bug. A real keyboard sends `K`; press `'Control+Shift+K'`.
- The window-hidden, window-closing and never-pausing specs stop the clock (`page.clock.pauseAt`) before typing. With time running, the idle save lands inside the assertion's poll and the spec passes with the code under test removed.
- Returning early from the page store's subscription in `PageModeEditor` did not redden the two reload specs; removing the `applyRemote` call in `bringIn` did. The patch has more than one caller.
- A diff that adds `e2e/page-mode.ts` runs the whole Playwright lane in CI (`scripts/classify-changes.sh`); the later PRs of #6714 add specs only and run just those.

## What ran

- The two new specs, green, one worker; each test shown red once by one mutation of the code it covers (the PR body lists them), `git status` clean after.
- `npm run typecheck`, `npm run lint`, `node --test scripts/e2e-related.test.mjs`, `prek run --hook-stage manual --all-files`.

Not run: vitest and the Rust suites (no `src/` or `src-tauri/` change), the full Playwright lane, the real-backend lane. CI is the check.
