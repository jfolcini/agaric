# Session 4378 — search-replace Ctrl+Z spec raced the undo window

`e2e/search-replace.spec.ts`, "Ctrl+Z on a page opened after a run undoes that page's part only", failed in CI on #6985 and in a parallel session's repeat runs, reading `[""]` after the undo.

- **Cause.** The page is opened after the run, so the undo store has no entry for it and Ctrl+Z takes the positional fallback, `undo_page_group` with `UNDO_GROUP_WINDOW_MS` (500 ms). The test seeds its blocks through IPC and then runs the replace. Logged op timestamps put the seed's `create_block` ops 530–590 ms before the run's `edit_block` ops here, so the margin is a few tens of milliseconds. On a faster runner the seed falls inside the window, the undo also reverses the two block creations, and the page is left with its empty placeholder block.
- **Not a regression.** The test landed in ef34551 (#6887) and has raced the window since. Nothing between cd98d00a and 9b9360b changes the undo path or the run's timing. Main and the fixed spec both passed every local repeat, so a bisect had nothing to split on.
- **Not a product bug.** Grouping ops less than 500 ms apart is the positional contract on the backend and in the mock. A user can't create blocks and finish a replace from the Search view in under 500 ms.
- **Fix.** The test installs `page.clock` before boot and fast-forwards 1000 ms after seeding, the pattern `e2e/AGENTS.md` prescribes for edits closer than the window.
- **Shown red.** With the clock frozen by `setFixedTime` and no fast-forward, so every op shares one timestamp, the spec failed 3/3 at :136 with the CI message (`[""]`). With the fix: 30/30 at 3 workers, and the whole file passed 3 repeats.
- **No vitest.** The store and the mock do what they are specified to do, so a store-level test would only restate the window.
