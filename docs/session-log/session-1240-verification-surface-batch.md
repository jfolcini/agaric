# Session 1240 — the verification surface

`/loop /batch-issues` run, 2026-07-30. Fourth log for the day (1237–1239 precede it).

All three items in this batch came from *this day's own reviews* rather than from the
standing backlog. Two of the three turned out to be about the verification surface itself —
the tools that tell you whether the code works — rather than about the code.

## #3212 — the documented "full suite" ran a third of it

`cd src-tauri && cargo nextest run` is package-scoped to `agaric`.

| Form | Tests |
| --- | --- |
| bare | 3365 |
| `--workspace` | 5452 |

The 2087-test gap is six workspace members, each excluded **entirely**: `agaric-store`
(1238), `agaric-engine` (425 — all the CRDT/sync correctness), `agaric-sync` (182),
`agaric-core` (173), `agaric-observability` (41), diagnostics (28).

The danger is the silence. A bare `-E package(agaric-observability)` filter fails loudly
("no tests to run", exit 4); a bare *unfiltered* run just reports green on a subset. This is
how #3190/#3194's four new engine tests were invisible to the documented command while
passing CI's coverage job.

Fixed everywhere it is documented, including the batch-issues skill's own subagent prompt
template, which carried the same latent bug. Also a real CI bug: `scheduled-deep-checks.yml`
had a step literally named *"Cargo nextest (full suite) + doc-tests"* running the bare form
for both commands.

`[workspace] default-members` would also work and was rejected deliberately —
`cargo metadata` confirms `workspace_default_members` is already `[agaric]`, so setting it
would change bare `cargo build`/`check`/`clippy` too. That reasoning is now a comment in
`Cargo.toml` so it is not re-litigated.

**#3220 is the other half of the same hole**, found in review: `test-related-rust.sh` builds
targeted filters only from `src-tauri/src/*`, so a change confined to any of those six crates
produces zero filters and the local pre-commit/pre-push gate runs **no** Rust tests. The
engine had neither a working targeted gate nor a correct full-suite command.

## #3206 — a cursor that silently dropped rows

`list_projected_agenda` paginated on `(projected_date, block_id)`, which is not unique:
the PK is `(block_id, projected_date, source)` and `recurrence_math` emits both a `due_date`
and a `scheduled_date` row per block per day. A page boundary between two such rows skipped
the second.

Uniqueness was verified against a migrated scratch DB rather than assumed — the triple is a
permutation of the only UNIQUE index, all three columns `NOT NULL`, so no rowid tiebreaker
was needed. Every other keyset cursor in the tree already terminates in a unique column.

The review was sent after a specific hypothesis — that SQLite's three-valued logic would
break legacy cursors, since `x > NULL` is NULL rather than false — and **refuted it**, with
three empirical variants returning identical rows. It then found two things that had not been
asked about: cross-branch cursor portability was untested (the cache and projector paths are
swappable mid-pagination), and the `CURSOR_PART_SEP` doc claimed an invariant nothing
enforces — nothing in production validates block-id shape.

It also corrected the builder's own test claim: "3 run, 0 passed" was wrong; 5 tests were
added and 2 fail without the fix.

## #3209 — the issue's two buckets were both wrong

Filed as "14 wrappers with no production callers — dead, or not yet adopted?" Neither. All 13
function wrappers have a **live** command already called directly via `commands.*`, with the
marshalling reproduced inline. That third bucket — live command, migrated call site,
vestigial wrapper — is the expected steady state of the #2927 migration.

Adopting the wrapper was not even available: `check-tauri-import-baseline.mjs` is a monotonic
ratchet, so adding 14 `@/lib/tauri` importers fails by construction. Deletion was the only
compliant direction.

Two divergences from the deleted wrappers are recorded in the allowlist comment rather than
glossed: a `requireActiveScope` tripwire lost on two journal call sites (deliberately not
restored — those evaluate synchronously in an effect body, so a throw becomes an uncaught
render error where the async wrapper had a `.catch`), and the `SafeLimit` brand lost at three
seams.

**#3218** came out of this: the parity guard and the import ratchet pull in opposite
directions. Every #2927 phase mechanically moves entries into `KNOWN_UNWRAPPED` (now 33 of
141), so the guard trends toward allowlisting everything and asserting nothing — while still
costing a hook run per commit. It is also name-parity only; the signature-drift class it
advertises is Phase 2, still deferred.

## Issues filed

#3217 (an order-dependent test that fails 3/3 in isolation and misdirected a bisect), #3218,
#3220.

## Notes

- Two long Rust pushes were killed with no output at healthy memory (15 GB free, no orphaned
  `rustc`). Both succeeded on retry with `NEXTEST_TEST_THREADS=4 CARGO_BUILD_JOBS=4`. No
  explanation beyond duration; recorded rather than diagnosed.
- Every one of the three reviews changed the outcome — one refuted a claim, one refuted the
  issue's framing, one found an untested path and a wrong test count. None of the three was a
  rubber stamp.
