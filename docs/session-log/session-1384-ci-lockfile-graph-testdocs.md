# Session 1384 — lockfile graph check, and the runner the test docs pointed at

| | |
|---|---|
| **Issues** | #4142, #4102 |
| **Branch** | `claude/ci-lockfile-graph-testdocs` |
| **Files touched** | see the PR's file list |

Two unrelated items sharing a light toolchain. Both had their issue's premise
falsified during the work, and in both cases the correction changed what
shipped.

## #4142 — nothing verified a Cargo.lock edit was graph-consistent

The issue proposed three options and preferred option 3, a dedicated job running
`cargo metadata --locked`. Falsifying first rather than after showed that option
3 **does not satisfy the issue's own first acceptance criterion**, and neither
does option 1.

Against a lockfile carrying a `dependencies` entry that names a package with no
`[[package]]` stanza, on the repo's pinned cargo 1.95.0:

```
cargo metadata --locked         EXIT=0
cargo tree --locked             EXIT=0
cargo fetch --locked            EXIT=0
cargo update --locked --dry-run EXIT=0
cargo check --locked            EXIT=0
cargo build --locked            EXIT=0
```

Cargo's lockfile reader silently **drops** an entry it cannot resolve, so the
parsed graph equals the pristine one and `--locked` has nothing to object to.
Two controls prove the harness was not simply broken: the corruption is
well-formed, and the issue's *other* named corruption — a version bumped without
a satisfying stanza — is caught, exit 101, with a dependency-chain trace.

So the job runs option 3 **plus** option 2, which the issue listed as
alternatives rather than complements: `cargo metadata --locked` per workspace,
then snapshot / re-resolve unlocked / `diff -u`. Only the second half reddens on
the ghost entry. Both lockfiles are covered — `src-tauri/Cargo.lock` and
`src-tauri/fuzz/Cargo.lock`, the latter confirmed a genuinely separate workspace
by `workspace_root` and behaviourally (a fuzz-only corruption reddens only the
fuzz iteration).

`cargo generate-lockfile --locked` catches both and is unusable: it exits 101 on
a pristine lock too, a permanent false red.

**Review found three defects in the implementation.** The unlocked re-resolve had
no failure guard, so a registry hiccup aborted the step under `set -e` — no error
annotation, an unterminated `::group::` swallowing the rest of the log, and the
second lockfile never checked; precisely the "reds as a code failure" mode #4163
exists for. The check also **rewrote the lockfile and did not restore it**, which
is harmless on a throwaway runner but silently edits the developer's `Cargo.lock`
when the block is run locally — which is exactly how the issue's acceptance
criterion asks it to be exercised. And the re-resolve now runs `--offline`: once
check 1 passes, cargo needs no resolution change, so check 2 can only drop residue
already in the lock and can never need a package check 1 did not download.
Verified from an empty `CARGO_HOME` at full scale.

Also verified, so the false-positive question is settled rather than assumed: a
stale-but-still-satisfying locked version is not bumped by an unlocked resolve
(cargo's resolver is conservative), and a `version = 3` lockfile is preserved
rather than migrated. Neither a registry refresh nor a format migration reddens
the check.

## #4102 — the test docs pointed at a runner several tests cannot use

`tests/AGENTS.md` offered `cargo test --workspace` for "all tests + doctests".
The parenthetical was correct and load-bearing — nextest genuinely does skip
doctests, which is why pre-push runs `cargo test --doc --workspace` separately —
so the fix was to make the split explicit, not to delete the line.

The divergence was reproduced rather than restated. Running the same four
logging tests from one built binary: nextest 4/4 green; shared-process 2 of 4
failed, including `log_dir_write_path_and_bug_report_read_path_agree` panicking
with its own message *"this test needs a clean process"*. Under default parallel
threading the failures were non-deterministic across runs — same tests, different
outcomes, purely from scheduling.

**The denominator was larger than the issue's "two".** Sweeping for
global-subscriber / `OnceLock` / env-mutation patterns found at least six
distinct locations, including two proxy tests that mutate `HTTP_PROXY` via
`set_var`, an Android network-block test whose own comment says it is "the ONLY
test that touches the globals", a recovery-kernel parity module requiring nextest
at module scope, and an MCP test that exhausts the process fd budget.

**Three sibling recipes in the same file pointed the wrong way too**, and were
fixed rather than left as a follow-up — fixing the headline line alone would have
reproduced the very failure #4102 is about.

**Review found the recommended command itself was unsafe.** `cargo test`'s filter
is a plain substring match, and `command_integration_tests` *contains*
`integration_tests` — so `cargo test -p agaric -- integration_tests` does not
isolate the safe module at all. It selects 370 tests including the
`sql_only_fallback_count()`-racing conformance tests the doc warns about two lines
later. Now `--skip command_integration_tests`, narrowing it to exactly 27, five
clean runs.

Review also corrected two claims before they were written down as fact. The
flake rate was stated as "2 of 3 runs"; ten default-parallel runs measured **1**
failure, and a different test than the original report — consistent with a real
race rather than a fixed bug, so the doc now says so and warns the rate will not
hold. And the claim that "nextest has no `-- --ignored`" is false; both forms
work, with `--run-ignored=only` recommended as canonical.

The frozen "3359 vs 5446 tests" figures were removed rather than refreshed — they
had already drifted to 3624 / 6023 — in favour of the live commands plus the
#3212 reference.

## Recorded, not fixed

Root `AGENTS.md` still attributes the nextest requirement for
`command_integration_tests` to a process-global Loro registry, a cause #2249
fixed — both files now carry an explicit "Isolation contract (#1079 → resolved by
#2249)". The live reason is the `sql_only_fallback_count()` delta assertion. That
matters because the two reasons imply different rules for new tests: a property of
two files, versus a pattern any test reading that counter inherits. Filed as
#4276.

## Round-two review — the check would have reddened the next release

Investigating a non-blocking note turned up a landmine this PR creates. Both
lockfiles pin the path dep `agaric`, so once `verify-lockfiles` exists, a
version bump that regenerates only `src-tauri/Cargo.lock` reds on the fuzz lock
— from a job whose name gives no hint that a second lockfile needs regenerating.

`scripts/bump-version.sh` contains **no occurrence of `fuzz`**. It regenerates
one lock and stages five files. The consequence is not occasional: **every one
of the last twelve releases left `src-tauri/fuzz/Cargo.lock` stale**, and none
of them touched it. It only ever catches up inside unrelated PRs — the current
agreement at 0.9.8 is an accident of #4139. Simulating the next release
confirmed the red.

Fixed at the source rather than documented as a chore. `bump-version.sh` now
regenerates the fuzz lock and stages it; `verify-version-agreement` checks it as
a sixth file and names it, with the exact regeneration command, in its error
message — so the drift is diagnosed by the job whose name says "version
agreement" rather than by a raw cargo `--locked` error.

Ordering was measured rather than assumed: the call depends on
`src-tauri/Cargo.toml` already carrying the new version, because `--precise`
names the path dependency's own manifest version. It does **not** depend on the
parent lock — the fuzz crate is its own workspace and resolves `agaric` from
`../Cargo.toml`. Both orders were run.

**The counts were replaced with names, not with "6".** A bare number is exactly
what rotted here: "5" read plausibly for twelve releases while being wrong,
because nothing about a number tells a reader which file is missing. A named
list fails visibly. `bump-version.sh`'s own `Files updated:` header is now the
one authoritative list, and the prose points at it. A grep sweep found the stale
count in more places than the review named — `AGENTS.md`, `docs/BUILD.md`,
`release.sh`, `prek.toml`, `check-remove-after-markers.mjs` and five separate
spots in `_validate.yml`.

Two of those were checked rather than reworded. `prek.toml`'s
`remove-after-markers` trigger deliberately still omits the fuzz lock — a bump
touches all five parent manifests so the scan fires anyway, and adding it would
re-scan the whole tree on every Dependabot fuzz-group bump for no gain. That
choice is now documented in place so it does not read as an oversight.

Also fixed from the same review: the lockfile restore is now installed as a
`trap` on `EXIT`/`INT`/`TERM` rather than running only on the paths the script
reaches. Proven by interrupting a run between the re-resolve and the restore —
before, the developer's lockfile was left rewritten and the temp dir leaked;
after, it is byte-identical and nothing is left behind. That guarantee is what
the "run this block verbatim locally" property depends on.
