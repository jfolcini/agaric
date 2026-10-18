# Session 2658 — an undo in page mode gives each text back the id it had, even after a peer rewrote the joined block

The #5908 row for `page-mode.property.test.ts`: a counterexample, and the test
hitting its 20 s timeout under load.

- **The counterexample** (CI run 39056549471, seed 966892422): two "alpha"
  blocks; cut the second's text and paste it at the start of the first; a peer
  rewrites the joined block; undo twice. The second undo brought "alpha" back
  under a new id, which breaks any `((ref))` to it. #5911 fixed the variant
  where the peer creates a block, not this one.
- **Cause:** after an undo, `page-block-ids.ts` reassigned every id by which
  character starts each block. The peer's rewrite had replaced the joined
  block's text, so its new first character carried the second block's id,
  overriding the id the undo had put back; the next undo then found that id
  taken and made a new one.
- **Fix:** `restoredIds`: after an undo or redo, each block keeps the id the
  undo put back unless another block holds it too; every other block goes by
  the character rule, unless its id was already kept. The peer's text then
  sits under the first block's id and the next save gives the second block
  its cut text back, page mode's existing local-change-wins rule.
- **Pinned** as the fifth entry of the test's `EXAMPLES`; red without
  `restoredIds` at the CI's assertion.
- **Runtime:** almost all the cost is driving TipTap (typing, clipboard,
  paste rules, a new editor per run), not the mock. Runs drop from 150 to
  `EXAMPLES.length + 50`, so every pinned example always runs: median 6.9 s
  to 2.9 s at load 20–29. Each run now explores 50 random sequences instead
  of 146; every CI run takes a new seed.

Ran: `vitest run src/editor/page-mode` (260), 5,000 extra random runs with the
fix, `npm run typecheck`, `oxlint src/editor/page-mode`.
