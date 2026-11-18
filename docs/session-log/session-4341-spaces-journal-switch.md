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
