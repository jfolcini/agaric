# Session 4341: "Add block" on a new day no longer adds a second block under the caret

#3394, #6529. This is the cause of the scheduled full-suite real-backend failure: `e2e/spaces-happy-paths.spec.ts:125` › "a journal block added after a space switch is the new space's", timing out at :147.

**Repro:** on the bridge at three workers the test failed 2 of 12, then 5 of 12. Each time, Work's day held a block reading "ork line" or "rk line": the first one or two characters were gone.

**Cause, from an IPC, event and keydown trace:**
1. Opening the journal in daily mode creates today's page (`useJournalAutoCreate`).
2. The day's `BlockTree` then creates its empty first block (`useBlockAutoCreateFirstBlock`, `create_block` at 1721 ms) and focuses it once the answer lands, about 170 ms later on the real backend.
3. The test pressed "Add block" in that window. `handleAddBlock`'s existing-page branch looked for a blank last block to focus, found the store still empty, and created a second block (1924 ms). It then loaded and moved focus to that second block.
4. Typing had begun in the first block, so "wo" was saved there (`edit_block` at 2020 ms) and "rk line" went to the second.

A user who opens a new day and presses "Add block" within that window gets two blocks, with their text split as the caret jumps. The mock answers too fast to show it.

**Fix:**
- The page store gains `seeding`: the first block's create while it is in flight, resolving to the block's id once it is in the store, or to `null`. `useBlockAutoCreateFirstBlock` publishes it and clears it when it settles.
- `handleAddBlock` awaits it on an existing page and focuses that block instead of adding another. It awaits only while a seed is in flight, so other "Add block" presses keep their timing.

**Tests, each shown red:**
- `useJournalBlockCreation`: "takes the first block the day is still creating instead of adding a second" (red with the await removed), and "adds a block when the first block the day was creating never arrived".
- `useBlockAutoCreateFirstBlock`: "publishes the block it is creating as the page store's seeding, until it is in" and "resolves its seeding to null when the create fails" (both red with the publish removed).

**The spec had a second race, of its own.** With the app fix in, the test still failed 2 runs in 12 at load, now keeping only "line":
- The day's first block had already landed and held focus when the test pressed "Add block".
- With a blank block focused, "Add block" adds another by design (`useJournalBlockCreation`'s "creates a block when the blank last block is the focused one"). An unfocused blank block is reused instead.
- The new block took focus a round trip later. The test's `toBeFocused` had matched the first block's editor, so "work " went there and "line" went to the new block.
- Whether "Add block" adds a block on a new day turns on whether its first block holds focus, which no test can time.

So for Work the spec now types into the block the journal opens a new day with, after waiting for exactly that one block with its editor focused. For Personal, where the seed's daily page ends in text, it presses "Add block" and waits for the sixth block's editor. The app race is pinned by the two vitest pairs above; the spec no longer presses "Add block" on a new day.

**Ran:**
- The test on the bridge at three workers: 15 of 15, against 2 of 12 and 5 of 12 failing before.
- All of `spaces-happy-paths` on the bridge, twice (4 of 4 each), and on the mock (4 of 4).
- The `useJournalBlockCreation` and `useBlockAutoCreateFirstBlock` tests (34), typecheck, and `oxlint --type-aware` are clean.

**CI's vitest found a third race of the same family**, in `AppShellErrorBoundaries` › "Retry recovers the crashed TabBar in place": "called a Tauri command with no mock registered: delete_draft".
- The test mounts the app. The journal makes today's page and focuses its empty first block.
- A Retry click that lands once that block holds focus blurs it, and the blur discards its empty draft through `delete_draft`, which the test's strict stub list lacked.
- Waiting for the editor's focus before the click made it red every time. The stub is now listed with its reason.

**Rebased onto main:** #6953's `adoptLateWrite` rewrites a block's content in the live store and does not touch the first-block create, so `seeding` is unaffected. The `src/stores` tests and the files above pass (1306), typecheck is clean, and `spaces-happy-paths` on the bridge passes 16 of 16 at three workers.
