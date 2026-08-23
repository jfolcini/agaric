# Session 1387 — a stale rationale and an unstated margin (2026-08-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-23 |
| **Issues closed** | `#4276`, `#4282` |
| **Subagents** | 2 builders |
| **Branch** | `claude/agents-nextest-rationale` |

**Summary:** two follow-ups filed earlier in the same session, both about documentation
that had outlived the code it described.

## #4276 — the nextest requirement cited a cause #2249 fixed

Root `AGENTS.md` attributed the requirement to a process-global Loro engine registry
shared by `conformance` and `undo_integration`. #2249 replaced that `OnceLock` global
with an explicit `&LoroState` threaded down the apply path, and both files' module docs
already record #1079 as resolved. The requirement is still correct; the reason was not.

The live reason is the `sql_only_fallback_count()` delta assertion — a monotonic
process-global `AtomicU64` read before and after a test's own work, asserted to have not
moved, which is how #891 proves an op took the engine path rather than the SQL-only
fallback. Under `cargo test` a crate's tests run as threads in one process, so a
sibling's event lands between the two reads.

**Why the correction matters more than the fact:** the two reasons imply different rules
for a *new* test. A shared registry reads as a property of two files. A process-global
counter read as a delta is a shape any test can inherit. The rewritten text states it as
a shape, names the counter and the assertion, and explicitly records the #2249
resolution so the registry rationale is not reinstated by someone who remembers it.

Two in-file contracts needed work too, and they needed *different* work.
`conformance.rs` claimed the module is safe under both runners — false, since it is the
counter reader. `undo_integration.rs` makes the same claim and is correct, because it
never reads the counter; it gained a scope limit saying the clean bill covers that file
and not a whole-module `cargo test` run.

The flake itself was **not** reproduced — this worktree has no build cache and the cost
exceeded the foreground budget. The mechanism was verified statically instead, and the
prior session's "1 failure in 10 runs" is recorded as a prior observation rather than
restated as a fresh measurement.

## #4282 — the residency tests inherited a 60s kill with no stated margin

Measured rather than assumed, and the issue's premise turned out to be half right. The
100k residency point is **joint**-slowest, not decisively slowest: 4.51s against the
sweep's 4.43s in the same run. So the trio's headroom was already about the same as the
sweep's — roughly 13x. The margin was fine; it was only unstated.

**The four tests are not alike in what the kill does, and that decided the fix.** For
`..._scale_sweep_4241` the 60s terminate **is** the assertion: it asserts no wall-clock
bound, so termination is its only failure mode, and the injected-O(n²) run at 142.3s
clears the kill by 2.4x. A 120s leash would cut that to 1.19x and blunt the only thing
that makes the guard bite. For the residency trio the kill guards nothing — their gate
is an equality assertion and the RSS figures are printed, not bounded, so a termination
can only destroy a diagnostic and redden the lane on runner noise.

So the leash covers the trio only, `profile.default` only (`--run-ignored=only` is passed
by `bench-slo` alone, with no `--profile`; all three `--profile ci` invocations never run
ignored tests). The 30s SLOW flag still fires underneath it, so decay stays visible — the
leash removes a spurious kill, not the warning.

**The override was proven to bind rather than assumed.** Temporarily set to 1s, the 50k
and 100k points terminated and the sweep was untouched at 4.94s — confirming both the
filter's membership and the sweep's exclusion. Restored immediately.

Three smaller accuracy items, each verified against the code first: the "cold-ish arena"
bias argument overstated itself (the seeder churns ~42 MB before *both* arms, so arm 1 is
not cold either — direction unchanged, size of the understatement smaller); the `_4242`
equivalence pin's comment claimed more than its fixture exercises (empty `block_links`,
one token per source, so neither the `NOT EXISTS` discharge nor multi-token dedup runs);
and a dead modulo in the sweep's chain that read as though a wrap-around edge existed.

## Recorded, not fixed

`agaric-store/src/cache/block_links.rs` carries the same over-wide "both folds must
derive byte-identical obligations" sentence corrected here, and was outside this change's
file scope.

**Files touched (this session):** 8 — see the PR's file list.

**Verification:** targeted nextest over the affected filters, including
`--run-ignored=only` for the four lane tests (4 passed); `cargo fmt --check` clean for
both crates; `nextest.toml` parses; doc-citation guard green with no new warnings.

**Commit plan:** one commit, two `Closes` lines.
