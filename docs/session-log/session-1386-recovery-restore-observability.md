# Session 1386 — silent failures in recovery, links, and the bug report (2026-08-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-23 |
| **Issues closed** | `#4232`, `#4209`, `#4216` |
| **Subagents** | 3 builders, 3 adversarial reviewers |
| **Branch** | `claude/recovery-restore-observability` |

**Summary:** three unrelated items chosen for one shared property — in each, the
failure was indistinguishable from success. A recovery cascade that truncated
silently, a link edge that never healed, and a bug report that showed no errors
because the incident was twenty minutes and one UTC midnight ago.

Every one of the three reviews found something the builder had not, and two of
them found defects graver than the issue being fixed.

## #4232 — recovery cascades truncate at depth 100 with no diagnostic

Implemented option 2: report through `ReplayDiagnostics` rather than
re-implementing the engine's re-anchoring walk. Report-don't-log, per the
convention that exists because a replay can run twice.

**The denominator was five, not the issue's four.** The fifth is the
`move_block` arm's *upward* ancestor probe, and it is the most silent of all —
it stamps nothing, so a truncated rebuild is byte-identical to a correct no-op.

**Review fixed a hard build break the fix introduced.** `agaric-store`'s
`every_descendants_cte_keeps_depth_cap` greps both crates for the literal
`d.depth < 100` in every `descendants` recursive arm. The new probe added a
fifth arm bounded at `CAP + 1`, so the guard reddened — and the guard's own
documentation says the number stays inline *because* it is grepped, which the
probe's header comment cited while doing the opposite.

The fix was not to loosen the guard. Both probes were rewritten so their
recursive arm is byte-identical to the cascades' and the one-level-deeper
question moved to the outer `EXISTS`: *a node at cap-depth still has a
child* ⟺ *a node exists at CAP+1*. That dissolves the lockstep hazard rather
than documenting it — the probe no longer has a bound of its own to drift —
and removes the `format!`/`AssertSqlSafe` interpolation entirely. The guard is
untouched, and was proven to still bite by stripping the cap from a real
cascade.

**Review also found a vacuous boundary test.** The ancestor negative claimed to
be "the assertion an over-eager probe cannot pass" and was neither: it found a
tombstone, so the probe was never consulted. Dropping the suppression rule
entirely left the suite green. Four tests replaced it, mutation-tested against
that exact shape.

**And it corrected the report's certainty.** The message told an operator the
rebuilt table "holds a TRUNCATED cohort" and to recover from a peer "rather
than trusting this rebuild". The probe answers a *structural* question — was
the walk cut off — never the *semantic* one, because each caller narrows the
CTE with its own predicate the probe does not mirror. Three shapes were
constructed where truncation is reported and the rebuild is correct, the most
frequent being any `move_block` under a deep chain with no tombstone at all.
Telling someone to distrust a correct rebuild, on the one path where the
rebuild may be all they have, is its own kind of harm.

## #4209 — a restored link target never re-links its waiting referrers

One line of substance: `RestoreBlock`'s dispatch arm now enqueues a per-block
`ReindexBlockLinks`. The handler already runs `reindex_one_block_links` then
`resolve_referrers_of`, so no new task kind was needed — the same trick #4118
used for the space stamp.

**The outbound half is a distinct defect class, not a bonus.** A reindex during
the deleted window sees the source as content-less, so its whole edge set is
dropped — and `sync_unresolved_links` correctly records nothing, because only a
live source owes a target. So `resolve_referrers_of` on the target can *never*
reach it. A target-side-only fix would have covered half the issue while
looking complete; only the reindex-self-first ordering closes it.

## #4216 — `recent_errors` was blind to every log day but the current UTC one

The day boundary is a filename fact (`Rotation::DAILY` → `agaric.log.YYYY-MM-DD`),
and the old code built today's name and stat'd exactly it. The walk now spans
the same retention window the bundle already applies, sharing the selection
predicate by construction so the two cannot drift, with the cap applied to the
combined cross-day tail rather than per file.

**Review found three documentation overclaims**, all in reasoning that looked
sound. `MAX_BUNDLE_BYTES` was cited as precedent for accepting a 16 MiB
worst case — that constant exists to *bound* it. The real justification is
stronger anyway: peak *resident* memory is one capped file, since each is
dropped before the next opens. The claimed invariant "the summary never
out-reaches the files that ship with it" is falsifiable, because
`apply_bundle_cap` drops the oldest files *after* selection. And "reached only
when the dated family is absent entirely" was simply false — it also fires on
out-of-window, future-dated, and non-file entries.

## Filed, not fixed

Five issues, each demonstrated with a failing test rather than inferred:

- **#4287** — a truncated purge cascade resurrects hard-purged content as a
  live, FTS-searchable block that cannot be found in the tree or re-deleted
  from trash. The FK deferral converts what would be a hard abort into a silent
  adoption. This is the gravest of the five; #4232 only makes it visible.
- **#4284** — `BlockId::from_string` silently rewrites any ULID whose first
  character exceeds `7`, across deeplink, MCP and IPC boundaries, returning
  `Ok` with a *different* id.
- **#4285** — a cohort restore reindexes only the seed, so referrers of
  restored descendants stay stranded. The fix needs both the replay path and
  the local path, which fan out separately.
- **#4286** — `resolve_referrers_of` reindexes tombstoned referrers, wiping
  their edges to live targets as collateral of an unrelated restore.
- **#4283** — `recent_errors` follows symlinks out of the log directory, and
  its output is embedded in a public issue body.

**Files touched (this session):** 8 — see the PR's file list.

**Verification:** `cargo nextest run --workspace` 6061 passed, 11 skipped;
`SQLX_OFFLINE=true cargo check --workspace --all-targets` clean; dynamic-SQL
and raw-tx guards green; specta bindings regenerated.

**Lessons learned:** all three items were chosen because the failure looked
like success, and in two of them the review found a *second* silent failure
underneath the first. The purge resurrection in particular was reachable only
by asking "what happens to the rows the truncated cascade left behind" — a
question the issue did not ask.

**Commit plan:** one commit, three `Closes` lines.
