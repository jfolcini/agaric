# Session 1392 — a purge that came back, and the switch that was holding it (2026-08-25)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-25 |
| **Issues closed** | `#4287`, `#4289`, `#4290` |
| **Subagents** | 1 builder, 1 adversarial reviewer |
| **Branch** | `claude/recovery-cascade-4287` |

**Summary:** the session opened on an inherited working tree — 916 lines of uncommitted
`recovery.rs` — that looked finished and was not. Its two acceptance tests failed. The
cause was a literal `if false &&` in front of the repair's call site, so the entire
#4287 fix was compiled in and never reached.

## #4287 — a truncated purge cascade resurrected hard-purged content

`purge_block` cascades stop at `DESCENDANT_DEPTH_CAP`. The row one level past the cap
survives the `DELETE` still pointing at a parent that no longer exists, and the
head-shaped rebuild runs under `PRAGMA defer_foreign_keys = ON`, so that dangling
reference does not abort the statement. The blanket orphan cleanup then NULLs it, the
deferred check passes at COMMIT, and the tail commits as a live, top-level block.

The resurrection is only *partly* reachable, and the reachable half is the bad half.
`parent_id IS NULL` plus `block_type = 'content'` leaves `page_id` NULL, so every
page-scoped read misses it; `deleted_at IS NULL` keeps it out of the trash, so it cannot
be re-deleted. But `rebuild_fts_index` indexes on `deleted_at IS NULL AND content IS NOT
NULL` with no tree filter at all — so content the user hard-purged returns as a live,
**searchable** block they can neither find in the outline nor delete again.

The fix takes the issue's option 3: delete rather than adopt. `purge_truncated_tails`
re-anchors on each unreached frontier child and runs another capped cascade, so a
subtree of any depth finishes in `ceil(depth / CAP)` steps without giving this
pre-migration pass an unbounded walk it deliberately does not have. Deleting is also the
only option that keeps the FK check satisfiable: leaving the dangling `parent_id` would
fail the deferred check at COMMIT and drop the whole rebuild into the #3269 scaffold
fallback, which has no FK constraints at all and resurrects the tail unconditionally.

The `still_orphaned` guard is what stops it over-reaching — a frontier child is purged
only while its `parent_id` is *still* dangling at cleanup time, so a later `move_block`
that re-parented it, or a `create_block` that re-made the id it pointed at, means the
op_log says the block survived and the log wins over a frontier captured mid-replay.

**The test asserts on the search path, not the table.** The table state is what makes
the resurrection plausible; the search hit is what makes it a broken deletion guarantee.
It seeds two levels past the cap on purpose, so a fix that removed only the frontier row
would still leave the subtree beneath it searchable.

## The `if false` — the finding that was not in any issue

Both #4287 tests failed on the first run. `recover_purge_cascade_reports_its_depth_cap_truncation`
reported the tail surviving; the acceptance test reported `search returned ["P101", "P102"]`.
The repair was guarded by `if false && !purge_truncation_frontier.is_empty()`, a
bisection stub left behind by the session that wrote the fix. Removing the two tokens
turned both tests green.

Worth recording because of what it implies about the inherited state: a diff can be
complete, documented, formatted and internally consistent and still be inert. The tests
are what caught it — nothing about reading the diff would have.

## The review's two findings — the repair had to move inside the loop

An adversarial review of the finished diff found the repair was correct only for a
replay in which nothing else happened. It ran as a post-loop pass over a frontier
captured during the loop, and both `create_block` (`INSERT OR IGNORE`) and `move_block`
(an unconditional `UPDATE`) accept a `parent_id` that does not exist — so ops replayed
after the purge could still restructure the surviving tail. That was wrong in **both**
directions:

- **Over-delete.** A later op parking a live block `X` under the surviving tail made `X`
  and its whole subtree part of the re-anchored cascade — hard-deleting content that was
  never purged, with no trash row and no op naming it. This is the everyday "peer B
  edited under a subtree peer A purged" merge, and an unbounded cascade would have left
  `X` alone: orphaned at purge time, then adopted by the cleanup.
- **Under-delete.** A later op moving a row *out* of the tail let it escape the cascade
  entirely, leaving hard-purged content live and FTS-indexed — the exact resurrection
  #4287 exists to stop, reintroduced by its own fix.

Both collapse to one cause, so both take one fix: run the re-anchoring immediately after
the purge arm's own cascade, inside the replay loop, where nothing has happened in
between. That also retires the `still_orphaned` guard the deferred version needed — a
frontier child at `CAP + 1` is necessarily orphaned the instant the cascade above it
commits, so the guard could only ever be trivially true, or wrongly *false* after a later
op had already corrupted the answer.

**The two new regression tests were falsified against the old structure**, which is what
makes them worth having: with the deferred version restored, both fail and the two
original #4287 tests still pass. The defects would have shipped green.

Two smaller review points went in with them. `purge_tails_finished` reported the raw
captured frontier rather than the heads actually purged, so a seed the guard skipped was
still logged as "finished" — sending a post-mortem reader after an id still alive in the
vault; it now records only heads whose step removed rows. And the TEMP cohort table is
now dropped at the end of the replay instead of riding a pooled connection back into
normal app traffic.

## #4289 — the probe doubled every cascade's walk, and its site list was unbounded

Both halves are about the cost of #4232's truncation reporting on exactly the vault that
reporting exists for. The separate `EXISTS` probe enumerated the whole subtree, then the
cascade enumerated it again — unconditionally, including on the vast majority of vaults
nowhere near the cap. `materialize_cascade_cohort` now folds the question into the
cascade's own walk, materialising the cohort once into a TEMP table and reading
truncation off it, which also makes the two answers structurally unable to diverge
rather than merely textually identical.

The site list is the one `ReplayDiagnostics` field with a documented high-frequency
benign trigger: on a merged tree deeper than the cap with no tombstone, *every*
`move_block` under that chain reports a correct-but-harmless truncation. So the record
most likely to matter was the one most likely to be flooded. `bounded_site_list` keeps a
head-N window with an `…and N more` suffix carrying the true total.

`CascadeTruncation::depth` went too (the second half of #4290). It was populated from
`DESCENDANT_DEPTH_CAP` at every construction site — invariant by construction, not
merely constant in practice, since the cap is a literal in the single recursive arm. The
number is still named, once, by `emit`'s `depth_cap` field rather than copied per record.

## #4290 part 1 — the plain-log fallback was preempted by the files it exists to outlive

`recent_errors_from_log_dir_at` consulted a plain `agaric.log` only when no usable
in-window dated file existed. The comment justified the fallback as tolerance for a
future rotation-policy change — under which it goes blind for a full retention window,
because dated files written before the switch stay in-window and keep winning while the
live plain log is ignored.

The fix compares **recency, not category**, because the two shapes that matter — a stale
plain leftover beside live dated files (#4127) and a live plain file beside dated files
frozen by a `Rotation::NEVER` switch — are the same shape to the old predicate, and only
the clock separates them. Everything ambiguous resolves toward #4127's conservative
default: ties lose (strictly-newer), and an unreadable mtime loses on either side.

**Both fixes were proven RED before being trusted.** #4287's tests failed for free, via
the `if false`. For #4290 the comparison was temporarily stubbed to the pre-fix
behaviour: exactly one test failed — the new "live plain log wins" case — while #4127's
two existing tests stayed green, which is the evidence that the change fixes the inverse
case without loosening the original guarantee. Restored immediately.

**Verification:** 348 tests green across the `recovery|cascade|truncat|purge|recent_errors`
filters, run against a base rebased onto 37 newer commits (the first post-rebase run
failed to build against a stale local dev DB — `SQLX_OFFLINE=true` pins it to the
checked-in `.sqlx` cache, which is what CI uses). `cargo clippy --all-targets --workspace`
clean; `cargo fmt` applied; the `check-dynamic-sql` baseline re-anchored 46 → 50 for
`recovery.rs`, entry count preserved at 62 so nothing new was grandfathered. Test runs
were capped to 6 cores under `nice`/`taskset` throughout — the machine was shared with
the user's own work.

**Every behavioural claim here was falsified before it was trusted:** #4287's two tests
by the `if false`, #4290's by stubbing the recency comparison, and the review's two by
restoring the deferred structure.

**Commit plan:** one commit, three `Closes` lines.
