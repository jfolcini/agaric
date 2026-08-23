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

## Round-three review — the obligation the check creates for every backend PR

The round-two fix made a *version bump* regenerate `src-tauri/fuzz/Cargo.lock`.
The round-three review pointed at the other direction, and it is the larger
half: step (1) of `verify-lockfiles` runs `cargo metadata --locked` against
`fuzz/Cargo.toml`, and the fuzz crate path-depends on `agaric`, `agaric-store`,
`agaric-sync` and `agaric-engine` — so **any** added or changed dependency
*requirement* in any `src-tauri/**/Cargo.toml` invalidates the fuzz lock too,
on a PR that never went near `src-tauri/fuzz`.

Reproduced rather than argued. `mdns-sd` is declared `"0.20"` in both
`src-tauri/Cargo.toml` and `agaric-sync/Cargo.toml` and 0.21.0 is the current
release — exactly the shape Dependabot's default `increase-if-necessary`
produces, because 0.21.0 does not satisfy `^0.20`. Editing those two
requirements and nothing else made step (1) fail on `fuzz/Cargo.lock` with
`cannot update the lock file … because --locked was passed`.

**The remedy named in the annotation is a conservative re-resolve, not
`cargo generate-lockfile`.** Measured on this lock: `cargo generate-lockfile`
relocked **882 packages** and moved `loro` 1.13.6 → 1.13.9, straight through the
deliberate #3161 hold that `.github/dependabot.yml` pins — it would turn a
one-line fix into a silent engine bump. Any cargo command *without* `--locked`
rewrites the lock conservatively instead; `cargo metadata --format-version 1
>/dev/null` is the cheapest (no build). On the simulated bump it relocked
exactly one package, a four-line diff, `loro` untouched, and step (1) then
passed.

**Dependabot cannot repair this itself, and that is the right trade.** The
`/src-tauri` entry sets no `versioning-strategy`, so it defaults to
`increase-if-necessary` and may edit `src-tauri/Cargo.toml`; the
`/src-tauri/fuzz` entry is `lockfile-only`, which by definition cannot touch a
manifest — and that is load-bearing, not incidental: #3432 shipped an `rmcp`
`^2.0` → `^3.0` breaking major into the shared parent manifest from inside a
PR titled as confined to `/src-tauri/fuzz`, and `lockfile-only` is what stops
it recurring. Relaxing it to let the fuzz entry self-heal would restore that
hazard to buy back a one-command manual step, and gating the fuzz half of step
(1) off on dependency PRs would blind the check on exactly the PRs most likely
to break the lock. So the manual step is kept and made loud: the failing
annotation now carries the paste-ready `cd src-tauri/fuzz && cargo metadata …`
command, plus a second annotation on the fuzz lock explaining why a PR that
never touched `src-tauri/fuzz` is being asked to regenerate it. The obligation
is documented in `AGENTS.md` § Coupled Dependency Updates, in `docs/BUILD.md`
beside the release steps, and in the job's own header comment — including
"do not fix this by relaxing the fuzz entry's strategy".

Three smaller items from the same review:

**A truncated snapshot could be written over a real lockfile.** `cp "$lock"
"$snap"` dying partway (ENOSPC) left a short file at the snapshot name, and
`restore_locks` decides purely on `[ -f "$restore_snap" ]` — so the trap copied
the truncation over the committed `Cargo.lock`. Harmless on a throwaway runner,
fatal to the "safe to run verbatim locally" property the trap exists to
provide. The snapshot is now written to `$snap.partial` and `mv`'d into place.
`rm -f` on the failure branch was the cheaper fix and was rejected: a SIGINT
landing mid-`cp` runs the INT trap without ever reaching that branch, whereas a
rename within one directory means the snapshot name only ever appears complete.
Demonstrated with a real partial write (`ulimit -f 1`, so `cp` takes SIGXFSZ
mid-copy): before, a 20012-byte lockfile came back as 1024 bytes; after, it is
byte-identical.

**Self-test case 15 assumed a rustup default toolchain.** It runs real `cargo`
from a fixture outside the repo, so `rust-toolchain.toml` does not apply; a
machine whose rustup has only directory overrides gets "rustup could not choose
a version of cargo to run" and the case reported a hard failure — reddening an
unrelated commit through the prek hook, the exact outcome the `command -v
cargo` skip exists to prevent. The skip now also probes `cargo --version` from
the fixture's own directory, under the same scrubbed `HOME`, restored
`RUSTUP_HOME` and scratch `CARGO_HOME` as the real calls, so it cannot pass
where they would fail. Verified both ways with an empty `RUSTUP_HOME`: before,
`FAIL - the fuzz-lock fixture resolves offline` and exit 1; after, a named SKIP
and exit 0.

**The "authoritative sweep" grep returns 13 paths, not 12.** The extra hit is
`src/integration_tests.rs`, which is comment-only — the `Engine-path helpers
(#1689)` block names the counter solely to contrast it with the
engine-tree-presence guard that file uses instead. It mattered because that is
the very module the recipe two sections earlier declares safe under plain
`cargo test`, so a reader following the doc's own "re-run the grep" instruction
hit an apparent contradiction with no exception noted. Both non-hazard paths
are now named in the parenthetical with their reasons.
