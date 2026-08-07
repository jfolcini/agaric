# Session 1276 — two guards that could not fire, and one that was already fixed

**Date:** 2026-08-07
**Issues:** #3541 (fixed), #3550 (fixed), #3545 (closed — already on `main`), #3539 (closed — declined), #3555 / #3556 / #3561 / #3562 (filed)
**PRs:** one batch PR off `claude/batch-issues-loop-1500-jxk8c6`

Continues session-1275, which filed most of this board. Two of the four items picked up
turned out to need no code at all — one was already fixed and one had already been decided
against — which is itself worth recording, because both were sitting on the open list
looking like work.

## The shape that keeps recurring: a guard that reads as protective and cannot fire

Both code items this session were the same defect class, arrived at independently.

**#3550 — the busy probe.** `start_sync_inner` probed the daemon's per-peer lock with
`try_lock_peer(&peer_id)`, a *device* id, while #3511 had moved the S-5 lock to be keyed on
`EndpointId`. The probe compared a device id against a table keyed by endpoint id, so it
could never collide, and the user-visible "Sync already in progress for this peer" error
was unreachable. #3552 recorded it rather than papering over it. No test asserted that
branch, so nothing went red when it died.

**And then the fix reproduced it.** The first cut of `peer_lock_key_for_stored` was
`.parse().ok().map(peer_lock_key)`. That makes an unparseable stored endpoint id
indistinguishable from a legitimate pre-iroh peer with `endpoint_id IS NULL` — both skip
the probe, silently, with no log line. A guard that looks present and cannot fire, added by
the change closing a guard that looked present and could not fire.

The parse failure is not hypothetical. `validate_endpoint_id` and migration `0107`'s CHECK
admit any 64-char lowercase hex, but an `EndpointId` is a compressed Edwards point, so
roughly half of all 32-byte values fail `FromStr`. `"deadbeef".repeat(8)` passes the write
side and does not parse. The review verified this in Rust rather than reasoning about it.

It now matches, `tracing::warn!`s the stored value and the parse error, and returns `None`
deliberately — per the rule already written down in `src-tauri/tests/AGENTS.md` ("`.ok()`
swallowing errors on core paths — warn + explicit fallback over silent discard"). Both
`None` arms skip the probe; only one of them is a bug worth seeing.

The write side is still looser than the key side. That is #3561, not fixed here, because
narrowing the invariant is a migration rather than a probe fix.

## Adversarial review earned its cost again, on both items

Neither builder shipped what was reviewed. This is the third session running where the
review pass found something the builder was confident about.

**On #3550** the review found the `.ok()` swallow above; two `cargo fmt` violations that
would have reddened CI lint; and a missing test for the one property the fix depends on —
every busy test passed because the *daemon* held the lock, and none asserted that the probe
*releases* its own guard. Hoisting `_probe_guard` out of the `if let`, or holding it across
`notify_change()`, would have starved the daemon unnoticed. `peer_lock_key_for_stored` had
zero tests; it now has three.

**On #3541** the review found the test's name was false. The filler construction
(`base` 14 chars + `'// x\n'` × N) reached 29,998 characters against a 30,000 cap, so
"still highlights a block right at the cap boundary" never exercised the boundary it is
named for. The remainder is now padded explicitly and the assertion tightened from
`toBeLessThanOrEqual` to `toBe`.

Both reviews were told which specific claims to attack rather than to "review the diff",
and in both cases the finding came from the named claim. On #3550 the brief said the
`Option` path was suspected of being the same defect class as the issue itself; it was.

## #3541 — a flake that had not flaked yet

`code.test.tsx`'s cap-boundary test raced a real `setTimeout(0)` → dynamic import →
synchronous `lowlight.highlight()` chain against `waitFor`'s 8000ms budget. The trigger is
**low core count with contention, not high load**: 40/40 passed with 265 spinners spread
across 16 cores, but pinning vitest to 2 cores alongside 4 spinners failed 2/40 at 24–29s.
Every CI job runs on `ubuntu-24.04` standard runners, which are exactly in that range.

Raising a timeout was rejected. `asyncUtilTimeout` had already been raised to 8000ms
globally for this class of problem and this test still blew through it under contention;
raising it again moves the threshold without removing the race.

`scheduleIdle` is now swappable from tests. Production behaviour is unchanged, and real
deferral keeps its coverage — all 18 tests in the file were enumerated, and the small-body
ones still drive a real, non-short-circuited highlight through the default `setTimeout`
path. Only the combination that caused the flake stopped happening.

The two `*ForTest` exports are a new *kind* of hook here: the ~15 existing ones reset state,
none swap behaviour. #3555 records the module extraction that would remove them. They are
tree-shaken out of the production bundle — checked against a real `vite build` and a grep of
`dist/assets/*.js`, not assumed.

## Two items that were not work

**#3545 was already fixed on `main`.** Commits `d60c9ba` and `d057ae2` shipped both halves —
the single `ZIZMOR_VERSION_AWK` constant sourced by `setup-hooks.sh`, and the restored
qualification at `frontend.md:172` — without a `Closes` reference, so the issue stayed open
looking like work. Verified against the tree per half before closing rather than trusting
the commit titles.

**#3539 was already decided.** The issue carried an owner comment recommending Option 1
(accept the Medium `ref-version-mismatch`, build no new infra), with Options 2 and 3 checked
and found non-viable rather than merely deprioritised. Closed `not_planned` with the
rationale and an explicit revisit trigger written into the thread, so it is not
re-litigated from zero.

Both of these cost minutes and removed two items from the board. Worth checking for before
assuming an open issue is open because it needs doing.

## Process notes

**The commit-message issue numbers were guessed wrong.** The #3550 message referenced #3557
and #3558 for two follow-ups filed moments later; GitHub assigned #3561 and #3562, because a
second Claude session in another VM was filing against the same repo concurrently. Caught by
checking the returned numbers instead of assuming, and fixed by amending before the push.
Do not write a forward reference to an issue number you have not seen returned.

**prek stashes unstaged changes around every hook.** Committing the frontend half while the
Rust builder was still writing showed four `Temporarily saving them to .../patch` →
`Restored unstaged changes` cycles against files another agent had open. It restored
cleanly, but it is a live clobber risk. Commits were serialised behind agent completion
after that. The one safe case is a commit whose staged files match no `types = [...]` filter
that any concurrent toolchain uses — the cargo hooks are all `types = ["rust"]`, so a
frontend-only commit touches no cargo state.

**Disk is the binding constraint in this sandbox, not CPU.** 26GB free at session start with
no `target/`; the review hit 100% mid-run and recovered by deleting
`src-tauri/target/debug/incremental` (14GB) and building with `CARGO_INCREMENTAL=0`. Only
one Rust item was scheduled for this reason, and no worktrees were used.

**The `agaric` crate would not build at all until GTK/WebKit dev headers were installed by
hand.** `scripts/setup.sh` only warns, and its wording says "before running the Tauri app",
which understates it — the missing headers block compiling, and therefore all testing.
Filed as #3556.

## Verification

- `cargo nextest run --workspace` — 5477 run, 5476 passed. The single failure,
  `control_relay_disabled_preset_still_queries_n0_dns`, is environmental and untouched by
  this diff: `HTTPS_PROXY` makes reqwest dial an IP literal, so no DNS query is ever issued
  and the recording resolver sees nothing. Its sibling `control_n0_preset_does_look_for_relays`
  passes, so the mechanism is wired correctly. It passes in 0.14s with the proxy vars unset.
  Filed as #3562.
- `npx vitest run` — 732 files, 15,985 tests passed.
- `cargo check --all-targets`, `cargo clippy --workspace --all-targets`, `cargo fmt --check`
  — clean.
- Bindings verified unchanged by regeneration, not by inspection: `src/lib/bindings.ts` diff
  empty, 139/139 IPC commands mocked.
