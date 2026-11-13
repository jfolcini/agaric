# Session 4062 — review audit of the PRs merged 2026-11-12/13

The maintainer asked that no PR merged in the last 24 hours carry an unaddressed review comment. This session read every review body, inline comment and conversation comment on the 53 PRs merged between 2026-11-12T16:30Z and 2026-11-13T16:41Z, checked each note against the code on `main`, posted the table on #6667, and fixed what was still open and unclaimed.

What the audit found:

- One blocking review (#6691, a reused session-log number), resolved before its merge. No inline comment on any of the 53.
- 44 distinct non-blocking notes. On the 19 PRs this session owned: 11 already addressed, 4 fixed here, 2 waiting on #6687, 1 for the maintainer, 9 not done with the reason in the table, and the rest decided or tracked elsewhere. On the 9 PRs another session owns, 6 notes were in no brief; three are still open (#6685's "on every PR" in two places, #6680's double prefill, #6684's lock window).
- #6653 merged with no review: it was force-pushed twice after opening and a push starts none. Nine other PRs took their own commits after their only review.

Shipped (one commit per source PR):

- #6655: `createViewPage` carries the reason its callers check the name first, and names the window that check leaves.
- #6665: `loro_snapshot_bench` uses `sync_import_bench::Acc`; `mean_secs` moved with it.
- #6666: `docs/architecture/op-log-format.md` puts the NUL check in `verify_remote_record_integrity`.
- #6672: `rederive_space_ids_in_tx` takes `&[&String]`, what its one caller holds.

Corrections to merged logs:

- session-4028 said #6656's count SQL "cannot be one string under `query!`". It can: #6689's `with_computed_page_counts!` is a `macro_rules!` that hands `query!` one literal for the read half, the write half and the oracle.
- session-4010 says `Refs #6564`; its PR closed #6564, and the open question it mentions lives in #6519.

Traps:

- The reviewer's fix for #6655 (check the returned id against the name snapshot, or for children) does not hold: a page that lands after the snapshot is in no snapshot, and a freshly synced page has no children. Only the command can say whether it created the page.
- #6673's note asked to drop the frontend `trim()` because Rust's differs on U+0085. It differs the other way too: JS strips U+FEFF and Rust does not, so the frontend trim is what keeps a pasted BOM out of a title.
- #6656's `map_or(true, …)` note covers no reachable case: both flags are computed only after `parsed_op` matched `Ok(..)`.
- A commit's prek hooks stash unstaged changes while they run. A cargo build started before the commit can compile the stashed-away tree; stop the build, commit, start it again.
- A cloud session's hook setup installs `cargo-nextest` and `just` last; `bash scripts/setup-hooks.sh` in the foreground fills them in.

Ran: the full vitest suite (1101 files, 26781 tests pass), `npm run typecheck`, `npm run lint`, `prek run --hook-stage manual --all-files` (31 hooks pass). `just e2e-related` selects the whole Playwright and WebdriverIO lanes for the comment in `src/lib/saved-views.ts`, so CI's run is that check. Rust: `cargo nextest run --workspace` in two halves (4014 and 4008 tests pass), `cargo test --workspace --doc`, `just gen-sqlx` and `just gen-bindings` (no diff), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, and `cargo clippy --workspace --all-targets -- -D warnings`. No bench lane was dispatched: the bench change moves a struct and touches no fixture or SQL.
