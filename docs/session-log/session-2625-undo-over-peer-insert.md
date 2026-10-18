# Session 2625 — an undo replayed over a peer's new block gives each text its id back

#5743's seed-31 counterexample in page mode's remote-patch property:

1. Cut a block's text and paste it where another block starts.
2. A peer creates a block just before the joined one.
3. Undo twice.

The first undo kept the pasted block's id on the wrong text, and the save then wrote that text into it. The second undo brought the original text back under a fresh id, so a `((ref))` to it broke.

**The cause was upstream.** `prosemirror-transform` 1.12.0 reports an insertion right at a position as a deletion after it. `AttrStep` is dropped when its position reads as deleted, so the undo's id-restoring step was lost. 1.12.2 fixes `StepMap.mapResult`. The fix is a lockfile-only bump, still inside `@tiptap/pm`'s `^1.12.0` range.

**Tests:**
- `remote-patch.test.ts` pins the sequence deterministically;
- `page-mode.property.test.ts` adds the minimised sequence to `EXAMPLES`.

Both are red on 1.12.0, with the predicted assertions, and green on 1.12.2.

Ran on 1.12.2: `vitest run src/editor/page-mode` (239); the full vitest suite in 4 shards; the property at 3,000 and 5,000 runs; a multi-peer variant at seed 31 and seeds 1–6; `npm run typecheck`.
