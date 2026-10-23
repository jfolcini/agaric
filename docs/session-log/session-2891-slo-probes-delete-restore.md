# Session 2891 — measurement-only SLO probes for delete, restore and the space-move preview

#5691's backend budget line asks that every command a page-mode save calls stay inside its `interactive_slo` budget at 100K blocks. A command with no probe gets one, measurement-only until `bench-slo` has run it. `create_block`, `edit_block` and `move_block` already had probes; `delete_block` and `restore_block`, which the save also calls, had none.

**Probes:**
- **`delete_block` and `restore_block`** each time one leaf of the write-path fixture (100K blocks plus a 2K-child page) through the `*_inner` command the save calls.
  - One loop runs delete, then restore, and each probe times only its own half, so every iteration has the same shape.
  - Each call asserts its result exactly, outside the timer, and the probe checks the op counts, the leaf, the page's child count and the SQL-only fallback count after the loop.
  - The shape check sits per call rather than in one untimed call first, because a mutator must not be preflighted against the measured fixture (`benches/AGENTS.md`).
- **`preview_space_move`** walks the whole page group, so its cost grows with the page. It is not a save-path command; the cross-space move dialog calls it. Its untimed call asserts exactly one loss of 2000 values.

Budgets come later, from several green warm runs (`benches/AGENTS.md` § Budgets). This PR dispatches `bench-slo` on the branch for the first measurement.

**Parity test** (a #6081 review note): `space_move_losses` and `space_move_loss_values` repeat one CTE and filter. `query!` takes only a string literal, so the fragment cannot be shared, and the test pins the two together instead. A drift would not refuse a move: the acknowledgement compares against the counts, and the values query then picks which values the move drops, so the move would drop values the dialog never showed. The test is shown red by removing the type filter, and separately the options filter, from the values query only. It also asserts that one page holds every value it compares.

**Also here:** `ctutils` moves to 0.4.4 in both lockfiles for RUSTSEC-2026-0385, which turned `cargo deny` red on every PR. The same bump is #6090.

**Suites:**
- a cold filtered bench run (debug profile; it proves the fixtures run, not the timings);
- each shape assertion shown red once;
- clippy;
- nextest over the space-move tests: 12 passed.
