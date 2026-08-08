# Session 1279 — when the issue was wrong

**Date:** 2026-08-08
**Issues:** #3344, #3280, #3281, #3644, #3645 (done); #3641, #3642, #3643, #3646, #3647 (filed)
**PRs:** #3640 (merged); #3648

Scoped to the `severity:critical` and `severity:high` backlog. No open code-scanning or
Dependabot alerts, so the whole set was the label taxonomy: seven issues, of which #3351
is the umbrella plan and #3345/#3347/#2927 are `cost:high`.

The through-line this session is narrower than 1278's. Every defect found was a **claim
of coverage that did not survive being tested** — a brand that gated one axis and blessed
another, an oracle asserted to hold two SQL copies honest that caught none of the drifts,
a verification command that cannot observe the thing it was trusted for. Twice the
correct fix required contradicting the filed issue.

## The review that overruled the issue

#3281 asked for #2549's `is_replicated = 0` provenance guard to be added at the two sites
that lacked it, one of which is `find_prev_edit_in_tx` — the query that *stamps*
`prev_edit`. We implemented exactly that. `agaric-reviewer` blocked it.

For a block that originated on a peer, the only op_log row on this device is the
replicated audit row; the content arrived through Loro. So the uniform guard meant that
after the user's first local edit of any synced block, the pointer resolved to nothing,
the timestamp scan resolved to nothing, and **Ctrl+Z returned a hard error**. Re-examining
it turned up a second, worse case: where a peer edits a block this device already had,
the guard made the pointer name the *stale local row*, so undo silently restored
superseded text — the #1526 failure mode the pointer exists to prevent.

The reviewer's cut is the right one, and it is sharper than what either issue proposed.
The guard belongs on the axis of **how the candidate was chosen**:

- `StrictlyBefore` **guesses** — it takes whatever row sorts nearest under a bound.
  Nobody named that row, so it can land on content this device never applied. That is
  what #2549 protects against; unchanged.
- `prev_edit` is a **recorded fact**, authored locally at edit time, naming one specific
  op. It cannot drift onto the wrong row, and the op it names is by construction the
  value the block held when the edit was written.
- `AtOrBefore` is **anchored on the user's click**, and `get_block_history` deliberately
  lists replicated foreign ops (#2481) — so filtering them from the preview means the
  History panel offers a row and then refuses to render it.

Filtering the pointer does not substitute a safer answer. For a peer-originated block
that value only ever existed as an audit row plus Loro state, so the filter removes the
only answer there is. #3281's own Impact paragraph already contained the counter-argument
— it concedes the content reached the device — but the prescription was written from
outside the code and generalized "add the guard where it is missing" without separating
scans from pointers.

**What let it through our own review:** the reviewer agent *found* this. It is §2 of its
report. It classified it as an accepted trade and filed it as a follow-up, on the grounds
that both issues had explicitly asked for the behaviour. That deference is the error
worth recording. "The issue prescribed it" is not evidence that it is correct, and it is
the one justification that makes a reviewer stop reviewing.

The rationale now sits at all three sites, each telling a future reader **not** to restore
the apparent consistency — because that tidy-up is precisely what reintroduces the bug.

## The oracle that was asserted, not tested

#3280 exists because one decision was implemented twice and the copies drifted, while a
parity oracle claimed to hold them equal. The oracle was blind: every fixture seeded
`prev_edit: None`, a shape production never emits.

The first fix changed every fixture to carry a realistic pointer — and thereby made
*every* edit resolve its pointer, so the fallback scan was never consulted. It swapped
the original blindness for its exact mirror image, leaving `fetch_prior_text_batch` with
zero coverage. The module header then asserted the oracle was what held the two SQL
copies honest.

Testing that assertion by mutating the batch copy:

| Mutation | As submitted | After |
|---|---|---|
| drop `is_replicated = 0` from `fetch_prior_text_batch` | **passed (blind)** | fails |
| invert its `ORDER BY` | **passed (blind)** | fails |
| add `is_replicated = 0` to `fetch_prev_edit_rows_batch` | passed | fails |
| drop only `, device_id DESC` | passed | **still passes** (#3646) |

The oracle now seeds both arms: one edit deliberately keeps `prev_edit: None` with an
order-decisive second local candidate and a replicated decoy that is the timestamp-newest
row. The header records, per predicate, which test pins it — and carries an explicit
`NOT COVERED:` line for the tie-break, because a blanket "the oracle covers this" is the
sin the issue was filed about.

Loosening the pointer path afterwards could have re-blinded it. It did the opposite: a
new fixture pins the deliberate *absence* of the predicate on the pointer scan, which is
the drift direction that now matters and previously had no guard at all.

## A brand is only as good as the axes it separates

#3344's instances (#3251, #3252) were already fixed, so the runtime was correct and the
work was purely the structural gate — make the un-zoomed list uncompilable so it cannot
come back.

The first implementation branded both lists with a single bit. But `selectAllIds` and
`visibleIds` are not the same contract: at page root `visibleIds` is collapse-filtered and
mount-capped, while `selectAllIds` is the full page, uncapped. Both are in scope in the
same hook, so `extendSelection('down', selectAllIds)` compiled — wiring Shift+Arrow to the
list literally named *the zoom-scoped ids* would walk the selection through rows the pane
never rendered, and batch delete would act on them. That is T5 verbatim with the collapse
transform in place of the zoom transform, which #3344 explicitly says counts.

The brand now carries a discriminant kind. The telling detail: when that landed, an
existing keyboard-shortcuts fixture stopped compiling, because it had been feeding a
view-branded list in as the select-all scope. The guard found a live instance of the
confusion inside the test suite on its first run.

The mount cap remains a third transform the brand does not distinguish (#3641), and the
gate sits at the component boundary while the store still takes `string[]` (#3642) — sound
today, since a full sweep confirmed `BlockTree`'s three adapters are the only production
callers, but not durable against the ~30 modules that import the store.

## Two gates caught what two agents did not

Neither of these is a review finding. Both were caught by tooling after both a builder and
a reviewer had signed off, which is the useful part.

**`cargo fmt --check`** flagged three violations in the builder's own code. The pre-commit
hook runs fmt in check mode, so this would have aborted the commit with HEAD silently not
advancing.

**`cargo sqlx prepare --check`** rejected the push. There are **four** `.sqlx` caches —
`src-tauri/` plus one per crate — and only the top-level one had been regenerated. The
reviewer had verified with `SQLX_OFFLINE=true cargo check --workspace --all-targets`, which
passes anyway: it validates the queries a given build compiles, not whether the cache is
*complete*. The two commands look interchangeable and are not. `just gen-sqlx` is the
canonical recipe; it drives all four and gives each crate its own migrated database.

## Discovery output is a hypothesis, not a finding

A cheap read-only sweep of #2927 returned three headline claims. Checking them cost about
two minutes and refuted most of it:

- "One submodule-path mock exists, contradicting the issue" — true, but framed as a
  ratchet blind spot. `check-tauri-import-baseline.mjs` already matches submodule paths,
  dynamic imports and side-effect-only imports, strips comments, and avoids false-matching
  `@/lib/tauri-mock`. Blind spot #3196 was fixed; the guard is green at 56 entries.
- "`notifications.ts` and `logging.ts` have zero consumers, delete them" — that was a
  *path-import* count. Both are reached through the barrel re-export, which says nothing
  about whether their symbols are called.
- A "~25 min effort" estimate for repointing two guards, invented rather than measured.

What did survive is worth having, and was posted to #2927: the phase-3 notes recommend
predicting test breakage by intersecting the reverse-transitive closure with test files
containing `vi.mock('@/lib/tauri'` — with the closing quote — so the one submodule mock is
invisible to that method, and a properties slice would hit an unpredicted breakage.

The lesson is not that the sweep was bad. It is that a discovery agent's output is input to
verification, and acting on it directly would have commissioned a fix for a guard that was
already correct.

## Operational

- Two heavy Rust pushes were run in the foreground with `NEXTEST_TEST_THREADS=4` and
  `CARGO_BUILD_JOBS=4`; both landed and both were confirmed by the postcondition rather
  than by an exit code.
- `gh pr edit --body` fails with a projects-classic GraphQL deprecation error;
  `gh api -X PATCH repos/:owner/:repo/pulls/:n -F body=@file` works.
- #3346 (the T2 equivalence oracle) was deliberately **not** started in parallel: it is the
  oracle for exactly the divergence #3280 fixes and edits the same file. Two batches
  touching the same module are not disjoint.
