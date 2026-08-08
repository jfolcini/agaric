# Session 1277 — claims that did not survive checking

**Date:** 2026-08-08
**Issues:** #3493, #3509, #3560, #3598, #3599, #3603 (done); #3564, #3601, #3608 (closed — already fixed, or the claim did not hold); #3600, #3602, #3605, #3606, #3609, #3612, #3615, #3617, #3618 (filed); #3602 (fix open at time of writing)
**PRs:** #3595, #3596, #3597, #3604, #3607 (merged); #3610, #3611, #3613, #3614 (opened)

A backlog session that spent an unusual share of its time on a single question: *is this true?* Five separate work items turned out to rest on a claim that was stale, wrong, or narrower than stated. Two of them would have produced actively harmful commits. The pattern is worth recording because none of the claims looked doubtful — they came from reviewers, from issue bodies, and from this session's own earlier reasoning.

## The headline: a fix nobody could reach

#3493 said cancelling a pairing wait leaves the pending-pairing row armed in the database. That is true. `cancel_pairing_inner` cleared only the in-memory `pairing_state`, while the responder admits an unpaired device by reading the `app_settings` marker through `get_pending_pairing_proof`. Nothing cleared the marker, so it stayed live for its full five-minute TTL and a racing inbound connection could complete a pairing the user believed cancelled.

The backend fix is small and correct: clear the marker unconditionally. Unconditionally, specifically, because the joiner's `confirm_pairing_inner` arms the marker and leaves the session `None` by design (#3463) — a session-gated clear would no-op on exactly the role that needs it. The builder found that ordering trap itself and pinned it with a test.

Review found the fix was unreachable.

`handleCancel` gated the IPC on `sessionStartedRef`, which is set only by a successful host-side `startPairing`. A joiner never calls `startPairing`. So the Cancel button on the joiner's waiting screen fired no IPC at all, and the marker armed by `confirm_pairing` survived regardless of what the backend now did. The scenario in the issue's own title could not exercise the fix for it.

This is the **half-covered pair** in its purest form: the guard body had two tests, both green, both genuinely non-vacuous — the builder had demonstrated verbatim RED output for each. The call site had none. Everything that was measured was correct; the thing that was not measured was the thing that mattered.

Renamed the ref to `backendArmedRef` — "is anything armed on the backend", which is the question the gate was always trying to ask — set when `confirmPairing` resolves, cleared on the success path so a completed pair does not fire a cancel on its way out.

### The generation token that was not needed

The obvious worry about an unconditional clear is that it over-clears: a cancel disarming a marker belonging to a *different* attempt, which is the mirror image of the bug being fixed. #3536 solved exactly that shape on the frontend with a generation token, so the instinct was to want one here.

There is nothing to key it on. The marker is a single device-global `app_settings` row, and `set_pending_pairing` upserts it with no ownership check — a second attempt already overwrites the first's proof. Two attempts never coexist as distinct rows, so a clear has no attempt identity to respect. #3536's situation was genuinely different: a stale *poll result* had to be judged against a newer wait, and both existed at once.

The real over-clear risk lived on the caller side, and `backendArmedRef` handles it. Reasoning recorded on the function so the next reader does not re-derive it.

One window remains and is now documented rather than implied: the responder reads the marker once at admission and pins the peer later in the same handshake, so a cancel landing in between cannot abort an in-flight connection. That is inherent — cancel is local state, not a wire abort — but it is bounded to a single handshake instead of the full TTL.

## Three issues that were already fixed

**#3564** (pinned zizmor unbuildable under pinned rustc) described two mutually unsatisfiable pins and a local provisioning path that compiled from source while CI downloaded a prebuilt binary. The root cause is gone: provisioning now reaches `cargo binstall` before `cargo install`, which is option (3) from the issue's own Options list, so the MSRV of zizmor's dependency tree is never consulted.

**This section is also where the session's own discipline failed, and the failure is left in rather than tidied away.** The first evidence recorded for that closure was:

```
$ cargo binstall --dry-run --no-confirm zizmor
 WARN The package zizmor v1.29.0 (x86_64-unknown-linux-gnu) has been downloaded from github.com
```

That tests **unpinned latest**. The version the issue turns on is the *pinned* `1.28.0`, and an unpinned resolution says nothing about whether a prebuilt exists for the pinned one — the check was applied to something adjacent to the thing under test rather than to the thing the claim protects, which is the exact failure this log names two sections later. Review of this very file caught it.

Re-run against the version actually requested, forced past the already-installed short-circuit that made a first retry inconclusive:

```
$ cargo binstall --dry-run --force --no-confirm zizmor@1.28.0
 INFO resolve: Resolving package: 'zizmor@=1.28.0'
 WARN The package zizmor v1.28.0 (x86_64-unknown-linux-gnu) has been downloaded from github.com
 INFO This will install the following binaries:
 INFO   - zizmor => /home/javier/.cargo/bin/zizmor
```

A prebuilt does exist for the pinned version, so the closure stands. But it stands on evidence gathered *after* the fact: the conclusion was right and the check that produced it was not, which is indistinguishable from luck.

Also corrected: an earlier draft of this log asserted that `ZIZMOR_PINNED_VERSION` no longer exists anywhere in the tree. **It does** — `scripts/zizmor-hook.sh:67`, and it is actively consumed (`setup-hooks.sh` seds it back out and passes it to `cargo_get_pinned`; `prek.toml` treats that file as the single source of truth). The pin is alive; what is gone is the compile-from-source path that made it unsatisfiable.

**#3601** was filed *by this session* from a reviewer's non-blocking notes on #3597, and was entirely stale — the reviewer had written against an earlier commit of that PR and the follow-ups landed before merge. The Stryker module was already registered; running it gave 12 mutants generated, 12 killed, over the one file in its mutate scope. All four "stale JSDoc" sites already matched their code, and one of the four paths did not exist.

**#3608** was filed *during* this session, by the agent investigating #3560, and closed within the hour by the reviewer checking it. It reported that draft recovery's supersession query used the `op_log` PK autoindex rather than `idx_op_log_block_id`, defeating migration 0030 for legacy `draft_anchor_seq = 0` drafts. The observation reproduced; the diagnosis was wrong. `EXPLAIN QUERY PLAN` never sees bound values, so the plan cannot depend on `draft_anchor_seq` at all — the cause was missing `sqlite_stat1` on a fresh pool. On a production-shape database the intended index is chosen, so migration 0030 holds in production. Closed as not-planned with the evidence table. Filed and refuted inside one session is the cheap case; the expensive ones are the three below that sat for weeks.

**#3509** (dead `PersistedCert` managed state) had its code half done by #3544, which deleted `sync_cert.rs` wholesale — precisely the incidental removal the issue predicted the port would perform.

The instructive part is what was left. `AGENTS.md` still described `sync_cert.rs` and a "TLS WebSocket server", so the bootstrap document pointed readers at a module that no longer existed and described the wire protocol as something it no longer was. Worse than the overstatement the issue reported. The subagent's own first attempt at the doc fix *also* cited the deleted file. Replaced both bullets with `transport/` (QUIC over iroh) and `transport/identity.rs`, and recorded the two constraints a reader most needs and cannot infer: that `endpoint::lan_only` exists because iroh's defaults publish device addresses to n0's services and `presets::N0DisableRelay` — whose name reads like the requirement — disables only the relay; and that the identity key must persist because `peer_refs.endpoint_id` is the pinned column the responder resolves against.

Deliberately left alone: the #1559/#855 residual-risk bullet, whose heading still says "pinned certificate". Its body already reasons about the iroh transition and asks to be re-analysed. Rewriting security prose that requests re-analysis is a maintainer's call, not a staleness cleanup.

## A stranded branch that was pure duplicate

The session opened on a local branch with two unpushed commits and a 1,174-line diff. Both were fully superseded: #3499 landed the first, and #3528 and #3536 had since *deliberately deleted* `PeerRefRow` and `waitErrorBaselineRef` — the two symbols the second commit reintroduced. Even its test existed verbatim on `main`. Rebasing and shipping would have reverted two intentional removals under a plausible commit message.

## A reviewer dispute settled by reproduction

PR #3596 carried three reviews: two approvals and, eleven minutes after the second, a `CHANGES_REQUESTED` claiming that deriving `totalCount` from `data.pages[0]` lets a cursor fetch re-adopt the stale pre-delete total. The second approval asserted the opposite. One was wrong.

Reproduced the exact repro given rather than choosing a reviewer. The finding does not hold: the `isPureRemoval` branch writes the decremented total into the react-query cache itself, and `fetchNextPage` leaves already-cached pages untouched, so page 1 keeps the decremented count.

The review was right that the ordering was **untested** — the nearest existing test loads more *before* deleting, which is the one ordering that cannot reproduce the claim. So the gap was real even though the defect was not. Pinned it; reverting the cache decrement reddens the new test with `expected 3 to be 2`.

## Guards, and what they are over

**#3603** — `expectNoHorizontalOverflow` walked `parentElement` to decide whether a `data-overflow-clip="intentional"` marker covered an offending element. DOM ancestry is the wrong chain: an absolutely-positioned element is clipped by its containing block, and a marked container with `position: static` establishes none, so the descendant's containing block resolves straight past it and the element is painted unclipped while the guard counts it as covered. A false negative in a guard whose entire job is catching overflow.

Confirmed on real Chromium before fixing — the fixture's offender is checked with `document.elementFromPoint` at its edge to prove it is genuinely painted and clipped by nothing. Two meta-tests, because "the guard now flags my fixture" is satisfiable by a guard that flags everything: one that must be flagged, one that must still pass.

**#3560** — `perf26_draft_recovery_at_10k_ops_is_fast` asserted correctness only; its name asserted speed. The only way it could fail for slowness was the nextest harness timeout, which exists for CPU-contention headroom, not as a budget.

The honest answer to "assert work done, not time" turned out to be nuanced, and was reported as such rather than rounded to whichever option was cheaper. Measurement showed the boot replay of 10K seeded ops through the Materializer/Loro pipeline is >98% of the runtime — proportional production work, for which no query-count proxy can catch a per-op latency regression without becoming a disguised wall-clock assertion. So the name lost `_is_fast`. But a *narrower* stable proxy does exist for what migration 0030 cared about, and it was added: an `EXPLAIN QUERY PLAN` assertion that the supersession-check query resolves by index seek rather than degrading to a full-table `json_extract` scan.

That is the shape worth copying — the guard covers what it can actually cover, and the name no longer claims more.

### The RED output that proved nothing

The first version of that `EXPLAIN QUERY PLAN` guard was **vacuous**, and how it was vacuous is the sharpest thing this session found.

`EXPLAIN QUERY PLAN` never sees bound values, and a fresh test pool has no `sqlite_stat1` — `PRAGMA optimize` runs at pool creation, while `op_log` is still empty. Without statistics SQLite picks the `(device_id, seq)` PK autoindex, and **that plan is identical when the block indexes do not exist**. Review proved it in situ: dropping `idx_op_log_block_id`, `idx_op_log_block_created` and `idx_op_log_block_key_created` inside the test left it green.

The guard had come with a falsification demonstration — verbatim RED output, exactly as this repo's practice demands. It wrapped the query's columns in non-sargable expressions and showed the test failing. But it wrapped them in *the test's own copy of the SQL string*. It proved something about that string and nothing about production.

So a demonstration of teeth can itself be vacuous. The question is not "did the test go red when I broke something" but **"did it go red when I broke the thing it claims to protect"** — here, the indexes, not the literal. Fixed with `ANALYZE` on a pinned connection (SQLite caches `sqlite_stat1` per connection, so analyzing through the pool hands the EXPLAIN to a sibling holding empty-table stats — a real failure hit while fixing this), and an assertion that now requires a block-scoped seek rather than any seek at all.

The duplicated SQL is unavoidable — `query_scalar!` takes only a literal, so the text cannot be shared through a const — so a drift guard now reddens on a one-character change to `draft_recovery.rs`. Otherwise the copy decays into a test of a string nobody runs.

### A 78× regression that everyone absorbed

Chasing the `<10s` claim in the archive answered a different question than the one asked.

The claim was simply **wrong when written**. The commit that introduced the test (`c5b07d5a3`) says `/// No wall-clock assertion (flaky on loaded CI)` in its own doc comment, while its commit message and the session-log entry it produced both claim a `<10s` budget. `git log --all -S 'as_secs' -- src-tauri/src/recovery/tests.rs` is empty for the file's entire history. No budget was ever deleted, because none ever existed.

The history did surface something worse. The test ran in **0.68s** at `5504ec99b`. It now takes ~53s. `16b12af55` added Step 1.5 boot replay to `recover_at_boot`, and because the fixture seeds through `append_local_op_in_tx` (unmaterialized), boot replay now drives all 10K ops through the Materializer/Loro pipeline — **98.7% of the runtime, measured**.

The test has silently stopped measuring draft recovery. The property PERF-26 was built to protect is now under 2% of what the test observes. Nobody asked why a test got 78× slower; `d5bdb75bb` (#2621) instead normalised ~50s into the nextest slow-test overrides, and both #3532 and #3560 subsequently treated ~51s as *the baseline*. Filed as #3612.

This is the session's theme with the sign flipped: not a claim that failed checking, but a number nobody thought to check, absorbed step by step into infrastructure until it read as normal.

## The fix that added what it removed

#3598 and #3599 were two TS/Rust divergences in reference-token handling, both invisible in rendered output and visible only as resolver side effects — the vault gains tags nobody asked for. The importer rewrote a bare `#tag` inside an unresolved `[[Project #alpha]]` into the corrupted `[[Project #[ULID]]]`; and for `#[[A #b]]` Rust could mint a stray tag `b` that TypeScript never requested.

Two things are worth recording beyond the fix.

**The guard had to go in the collectors, not the rewriters.** `#[[A #b]]` renders identically either way; only the side effect diverges. A rewrite-only fix looks green while still minting tags — keeping the rewrite guard and disabling the collector-side skip reddens 20 tests.

**The change introduced two new divergences while removing two.** The two sides detect code by different mechanisms, because their inputs differ, and the fix asserted those were deliberately equivalent. Review treated that as the load-bearing claim and constructed the cases:

| input | Rust | TS as authored |
| --- | --- | --- |
| `~~~\n#hushed\n~~~` | `[hushed]` | `[]` |
| `a #before\n```\n#inside\n```\n#after` | `[]` | `[before, inside, after]` |

`FENCE_DELIM_RE` accepted `~~~` where the importer's `is_fence_delim` takes backticks only; and `is_code` was modelled as line ranges when it is a sticky block-level flag the importer OR-s across a folded run. **Before the fix, TypeScript protected nothing, so the two sides trivially agreed** — every divergence here was created by the change that existed to remove divergences.

The corpus could not have caught it: its `isCode` flag was a routing hint nothing checked, so flipping it to `false` passed silently and each side was being graded against its own expectations. It now asserts against what `parse_logseq_markdown` actually produces, and a new `codeFenceCases` set feeds raw text to each side's real mechanism.

A third divergence in the same function survived into merge and is filed as #3617: only the #2866 recovery branch ends a block-run, so an ordinary bullet outside a fence does not, and a fence retroactively marks siblings as code. The corpus still has no bullet-outside-fence vector, which is why it passed again.

## Two gaps found sideways

**#3606** — `e2e/**.ts` is type-checked by no tsconfig. `tsconfig.app.json` includes only `src`, `tsconfig.node.json` only the config files, and `tsconfig.wdio.json` covers `e2e-tauri/**` but not `e2e/**`. The near-identical directory names make it easy to misread as covered; a `typecheck:e2e-tauri` script exists for the other suite, which suggests this one was missed rather than excluded. `npx tsc -p tsconfig.wdio.json --listFiles | grep -c "/e2e/"` returns 0.

Stated carefully, because the temptation was to overclaim: the two type errors that led there are LSP artefacts under default lib settings, fine at ES2023 and at runtime. The defect is the absent gate, not those lines.

**#3602** — CI provisions `sqruff@0.38.0` while local `cargo_get` binstalls *latest* first and reaches the pinned version only on failure. The pin written down to prevent version drift is never consulted. Found while verifying #3564 — the same two-paths-one-value shape, one tool over.

## What generalises

Every item above failed the same way: a claim that was true when written, or true of a narrower population than it named, and nobody checked it against the tree before acting.

- A reviewer's finding is evidence that a reviewer believed it. Two reviewers on #3596 believed opposite things eleven minutes apart.
- An issue body describes the tree *as of filing*. #3564, #3601, and #3509's code half had all been fixed since.
- **This session filed #3601 by relaying a reviewer's note without checking it.** Its sibling #3600 was filed the same way in the same minute; a caveat is now on that issue telling whoever picks it up to verify each item first.
- Green tests bound what was measured, not what matters. #3493's tests were non-vacuous and proved the wrong half.
- A session log is a claim too. #3560's `<10s` budget was contradicted by the very commit that allegedly introduced it, and the contradiction sat unexamined across at least three later issues.
- **A falsification demonstration is a claim.** #3560's guard shipped with verbatim RED output and was still vacuous, because the break was applied to the test's own copy rather than to the thing the guard protects.
- **This log did it too**, in the section arguing for exactly this discipline: #3564's closure was evidenced with a dry-run of *unpinned latest* when the issue turns on the *pinned* version, and asserted a constant no longer existed when it does. Review of the log caught both. Writing the principle down is not the same as applying it, and the section where you feel most certain is where it is least likely to be checked.

Two of the fixes were also *unreachable or wrong in a way their own green tests could not show*: #3493's backend fix could not be invoked from the path the issue described, and #3598/#3599 introduced two new divergences while removing two. Both were caught only because a second agent was told to attack the strongest claim rather than re-run the tests.

The cheap version of the discipline is one question before acting on any inherited claim: *over what, and as of when?* The version that catches the rest is: *if this were wrong, which of my checks would have noticed?*
