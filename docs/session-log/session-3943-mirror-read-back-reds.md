# Session 3943 — The mirror's read-back specs, red every time their gate is removed

#5363: #6623's checkout spec went red in only 1 of 2 real-app runs with the read-back gate removed, and the first test in the same spec never did. Both now go red reliably with that break. This PR also carries #6623's one review note.

## What the waits rest on

The real-app trace shows the order. A saved file is first left to settle: the next pass lists it as diverged and pending, and reads nothing. The pass after that reads it in, while reading back is on. A pass writes its pages sorted by id, and a page created later has a later id. So the first new page's file shows that the settle pass ran, and the second's shows that the read-in pass had already handled every older page.

- **The first read-back test** made its "page unchanged" check right after the save was listed as pending, before any pass could have read it. It now waits on `twoLaterPasses`.
- **The checkout test's** two-pass wait moves into `twoLaterPasses`, shared by both tests.
- **#6623's review note:** the default idle-tick setting calls nothing. Before, it had a `get_mirror_status_inner` arm only to have something to unwrap.

## Not a defect

Every save in the traces was read in on the pass after it settled, about one `TICK` later. No save sat unread for longer, so the earlier misses were the tests checking too early, not a delay a user would see.

One run with the gate removed (`red3`) left both tests green, and I did not find why. The eight runs since, three of them traced and the three below untraced, all went red.

## Tests

- **Falsified:** the ingest no longer gated on reading back (`self.ingest.clone()`), each run in one command that restored `src/mirror/mod.rs` on exit. `just e2e-real e2e-tauri/mirror-read-back.e2e.ts`:

  | Run | Gate removed | Gate restored |
  | --- | --- | --- |
  | 1 | red: line 120 (the first test's block) and 189 (the checkout's pages) | green |
  | 2 | red: lines 120 and 189 | green |
  | 3 | red: lines 120 and 189 | green |

- **Rust:** with the same break, 6 of the 10 read-back unit tests in `src/mirror/ingest_tests.rs` fail.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean. `npm run typecheck`: clean.

## Mutation testing

`cargo mutants` on `src/mirror` is 518 mutants, each a rebuild and a run of the mirror tests, so many hours. It goes in its own PR.
