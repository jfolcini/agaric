# Session 1284 — the reports were wrong, not the code

**Date:** 2026-08-09
**Issues:** #3628, #3326, #3272, #3273, #3693, #3686, #3700 (done); #3714, #3715,
#3716, #3722 (filed)
**PRs:** #3713, #3717, #3718, #3720 (merged); #3719, #3721, #3723, #3724, #3725
(open at close)

The continuation of session 1283, same batch loop, same six-agent shape. 1283's
through-line was guards that passed while the property they guard did not hold.
This half found the sibling failure, and it was more uncomfortable: the code was
usually right, and the thing that was wrong was the **account of the code** — the
PR body, the check status, the tracking issue, the baseline, the commit author.

Every instance below was caught by reading a report against the thing it described,
not by a test going red. That is the point: none of them had a test that could.

## Six accounts that did not match their subject

**A dispatched deep-checks run computed its finding and threw it away.**
`scheduled-deep-checks.yml` runs `--dry-run` on any non-`schedule` event, and the
lane is weekly, so a `workflow_dispatch` is simultaneously the only way to get an
off-cycle answer and the mode that discards it. Run 30981051402 printed
`2 lanes newly failing: full-suite, prek-all-files` and wrote nothing. Four days
later the tracking issue still named `file-mutation-survivors` and `mutants` — one
skipped, one green in that very run — while omitting both lanes that were actually
red. Not stale: **inverted**, under a heading that tells readers it is
machine-readable and authoritative. Filed as #3716; ground truth recorded on #3394
by hand. Both red lanes turned out to be already fixed on main (a zizmor
`impostor-commit` false positive on a `dtolnay/rust-toolchain` pin that has since
moved). That was luck, not the reporting path working.

**A PR body described a different change.** #3719 fixes the op-log frontier and the
attachment GC. Its body was the *docs* PR's description, carrying `Closes #3272`
and `Closes #3273` — two issues it does not touch — and omitting `Closes #3325`,
the one it does. The review approved the diff and blocked on the body alone. Every
gate was green: the code was correct, the tests passed, the sign-off matched. There
is no check in this repo that reads a PR body against its diff.

**A review reported SUCCESS with seven findings in a comment.** Known since #3702;
#3723 fixes it. The review of that fix then found the fix carries the same defect
one level up — `summarize-review-findings.mjs` picks the last bot review with no
`commit_id` filter, so a push whose reviewer step fails silently inherits the
previous push's clean review and reports success on a commit nobody read. Sent back
rather than merged-and-filed. A PR arguing that a signal must report the property it
measures cannot ship a signal that does not.

**A docs-accuracy PR introduced two inaccuracies.** #3718 corrected five claims the
code contradicted; review found two of its *new* claims were themselves false — that
the sync protocol does not consume the snapshot module
(`sync_daemon/snapshot_transfer.rs` imports and calls `apply_snapshot`), and that
the journal month view mounts one BlockTree per day (`MonthlyView` renders a
`MonthlyDayCell` calendar grid and mounts none; `<BlockTree` appears in exactly two
non-test files). Both were copied from stale comments in the source, so the comments
were corrected too — otherwise the next reader reintroduces them from the same place.

**A baseline was green in isolation and would have landed a red main.** #3724's
re-anchored `dynamic-sql-baseline.txt` predated #3717's merge. Self-consistent on its
own branch, every check green; merged, main would have carried a baseline saying 1
where the code has 2. This is #3672 exactly, and it was caught by checking rather
than by trusting the green.

**A self-test wrote to the real repository.** Writing the #3690 fixture, a subagent
ran `git init`/`git config` inside throwaway repos via `git -C <fixture>`. Running as
a pre-commit hook, it inherited git's exported `GIT_DIR` and `GIT_INDEX_FILE`, which
**outrank `-C`**. `core.bare` flipped to true, `core.worktree` pointed at a temp
directory, and the identity was overwritten with `self test
<selftest@example.invalid>`. Two commits made in unrelated worktrees during that
window were authored and signed off as that identity — and `dco` reported **SUCCESS**,
because a bogus author that signs off as itself is internally consistent. Filed as
#3722 for the class, since fixing the one hook does not stop the next one.

## What actually shipped

**#3713** — pairing's `backendArmedRef` was set on IPC resolution, leaving the whole
`await initHost()` round-trip unguarded: a close during it tore nothing down, and the
device spent the full 5-minute TTL announcing over mDNS and admitting any peer with
the proof, **for a passphrase never rendered on screen**. The fix records the arm at
dispatch and puts one FIFO in charge of every pairing mutation. Its own review then
caught the regression that created — the close guard, keyed on the ref, popped
"Cancel pairing?" over a "Failed to start pairing" banner — so the guard now keys on
`hostWindowShowing`, which means "a code is on screen", while the backend clear stays
keyed on the ref, because that arm may well be real.

**#3717** — `collect_ops_for_peer` scanned the whole op log with payloads and filtered
in Rust. Pushed the frontier into SQL: at 300K rows a caught-up peer goes 1.12 s →
87 µs, measured against a payload distribution taken from a real vault, with the old
implementation retained as a test oracle asserting full result equality across nine
frontier shapes.

**#3720** — the tauri-mock's restore skipped the backend's upward ancestor walk;
`ValidationCode`'s wire pin was a hand-written literal a new variant could skip; and
`BlockTree.scale-envelope`'s 10 s mount budget measured ambient machine load. The last
was fixed by measuring the structure the budget was proxying for (render counts,
zero layout reads) rather than by raising the number.

## Two agent-handling lessons

**Serena reads the main checkout, and it goes stale.** Known that its *edits* leak out
of a worktree; this session found its *reads* are worse, because they look fine. The
main checkout was 218 lines behind `origin/main`, so `find_symbol` returned a
pre-#3705 function body and an agent nearly analysed a defect that was already fixed.
It caught this only because the code did not match the issue. Fast-forward the main
checkout before spawning worktree agents.

**Prune worktrees on PR merged, never on agent-completed.** A finished agent can be
resumed with its full transcript — far better than briefing a fresh one — but only if
its worktree still exists. Two worktrees were pruned the moment their agents reported,
both PRs came back with changes requested, and both had to be rebuilt from cold.
