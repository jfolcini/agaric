# Session 1789 — mutation-survivor triage: the chunk ceiling nobody had measured

Set out to work the open mutation-testing issues: #4690 (rust, 27 survivors across
#4652 `snapshot.rs`, #4653 `sync.rs`, #4656 `reverse/batch.rs`) and #4691 (frontend,
7 no-coverage plus 58 survivors across jex-import and #3766 vault-import).

Most of the rust lane was re-triage, not new findings. The 2026-09-18 run dropped 25
accepted-equivalent entries because the files shifted under them, and re-reported the
same mutants at new ids — the churn `scripts/file-mutation-survivors.mjs` documents as
deliberate, and the same shape as the 2026-09-07 re-anchor #4690's own triage comment
worked through. Each verdict was re-derived from the code rather than carried forward,
per that comment's standard. Seventeen came back equivalent. **Eight came back
killable, and the previous acceptance was wrong for a reason worth recording.**

## The correction

The accepted argument for the `/ -> *` chunk-size mutants in `reverse/batch.rs` was
that `MAX_SQL_PARAMS` (999) sits far below SQLite's real 32766 bind limit, so a wider
chunk still binds fine. True, and beside the point. Five of those helpers emit one
`UNION ALL SELECT` term per op, and the ceiling that binds is
`SQLITE_MAX_COMPOUND_SELECT`, which is **500** — this build does not override it
(`libsqlite3-sys` 0.30.1 bundles SQLite and only forwards `-DSQLITE_MAX_*` for
`MAX_VARIABLE_NUMBER`, `MAX_EXPR_DEPTH` and `MAX_COLUMN`, none of which are set).
`999 / 3`, `999 / 7`, `999 / 8` and `999 / 2` all land under 500 by arithmetic
coincidence; the mutants raise them to 2997–7992, and the statement stops preparing at
501 ops. `reject_replicated_targets` fails the same way one limit over, on
`SQLITE_MAX_EXPR_DEPTH`.

The mutants survived because the suite's largest batch was 400 ops. `MAX_REVERT_OPS`
is 1000, so 501–1000 is legal input, and `get_op_records_batch` runs on every revert
path. **No bug shipped** — every current chunk size is under 500 and the code is
correct today. What was missing was anything holding it there: raising
`MAX_SQL_PARAMS` toward the 32766 headroom its own doc-comment advertises, or widening
a bind count, would have broken batch undo and "restore page to this point" over ~500
ops with a raw database error, and nothing in the suite would have noticed.

Four fixture constants went 200/400 -> 501 and two tests were added. All eight mutants
now redden with SQLite naming the limit itself: seven `too many terms in compound
SELECT`, one `Expression tree is too large (maximum depth 1000)`. At 400 ops not one of
them reddens; 501 is the whole difference. A comment at the bind-width constants
records the constraint, and a stale doc sentence on `reject_replicated_targets` that
blamed "SQLite's bind limit" now names the limit that actually bites.

## Deletions

Six `if i < out.len()` guards in `batch.rs` are gone. Every `idx` read back is one the
same statement bound, always a position inside `out`, so the false branch was
unreachable — and it silently dropped a row that cannot exist, which is what invariant
5 rules out. Falsifying the deletion showed why it matters: injecting a plausible index
drift into `fetch_prev_edit_rows_batch` now aborts with `index out of bounds: the len
is 501 but the index is 666`, where the guard used to swallow the row, leave
`prev_edit` unresolved, and let the op fall through to the timestamp scan and return
plausible but wrong prior text. Five `base = chunk_no * chunk_size -> base = 0`
mutants pin the cross-chunk mapping the guards had been masking.

Four of the seven no-coverage mutants in `jex-import.ts` were likewise deleted rather
than tested: `(lines.at(-1) ?? '')` behind a length guard that already made `.at(-1)`
total, the same shape in `normalizeBody`, `known[mime] ?? 'bin'` behind `mime in
known`, and a `str.length === 0` early return that `Number.parseInt('', 8) -> NaN -> 0`
already covers. The two that remain are compiler-mandated totality under
`noUncheckedIndexedAccess` — deleting them is `TS18048`, so they are not dead code.

## Corrected in review

Two claims did not survive checking. The builder's hand-back called the batch.rs
exposure "real and shipped"; it is latent, as above, and the PR body says so. And the
rewritten `ACCEPTED GAPS` header in the jex-import tests asserted that `unserialize`'s
blank-line and no-colon branches were equally unpinnable — measurement showed the
no-colon branch's `separatorIndex = i + 1` is already pinned by an existing test —
mutating it to `i` reddens the "ends the metadata block at a line that is not a
key/value pair" case. Left uncorrected, that bullet would have told the next sweep to
skip a killable mutant. This is the prose-drift failure AGENTS.md § Testing names:
a claim that something was checked is a hypothesis until re-run.

Two of the ten new jex-import tests kill no mutant. They were kept anyway, for a reason
the review did not credit: they are the only tests that execute `props['id'] ?? ''` and
a notebook's `parent_id ?? ''`, converting two no-coverage mutants into executed ones.
#4691 ranks no-coverage above survivors precisely because code nothing has run is the
worse finding.

## Verified

- `cargo nextest run --workspace -E 'package(agaric-engine)'` — 1038 passed, 0 skipped
  (baseline 1036), 95.8 s against 99.5 s before, so 200 -> 501 cost nothing measurable.
- `cargo nextest run -p agaric -E 'test(revert) + test(reverse) + test(undo) +
  test(restore_page)'` — 199 passed.
- `npx vitest run` — 838 files, 19266 passed, 1 expected fail, 51 skipped.
- `npm run typecheck`, `cargo clippy -p agaric-engine --all-targets`, `rustfmt
  --check` — clean.
- Module mutation score for jex-import, two full `node scripts/run-mutation.mjs
  jex-import` runs either side of the change: 86.85% -> 89.71%, survivors 59 -> 48,
  no-coverage 7 -> 2.

Every test added in this session was shown red against the exact mutation it claims to
kill, against a `/tmp` copy, restored and `cmp`-verified.

## Left open

jex-import keeps 48 survivors with written equivalence arguments; `snapshot.rs`,
`sync.rs` and vault-import are re-accepted unchanged at their current ids. The
`snapshot.rs` hop-cap counters were raised as a deletion candidate — five of the six
entries there exist only because two `1_000_000` guards cannot be reached — but #4690's
2026-09-08 comment already ruled that those caps stay, being the only thing between a
corrupt tree and an infinite loop on a read path. Reversing that needs a `visited` set
first, which is its own change, not a survivor-count optimisation.

`cargo-nextest` was not installed in this environment and `cargo binstall
cargo-nextest` fails to build under rustc 1.95 (`locked-tripwire`); the prebuilt binary
from `get.nexte.st` works.
