# Session 1278 — the review that said do not ship

**Date:** 2026-08-08
**Issues:** #3336, #3340, #3556, #3617, #3615, #3620, #3618 (done); #3626, #3627, #3628 (filed)
**PRs:** #3621, #3624 (merged); #3629 and the rest of this batch (opened)

Every item this session went through an adversarial reviewer on a separate agent, never
a weaker model tier than its builder. Four of six reviews changed the outcome, and one
of them rejected a diff outright. That is a high enough hit rate to record what the
reviews were actually doing that the builders were not.

## The one that mattered: a fix that shipped the bug it was fixing

#3615 asked for something modest — the host role had no pairing success detection, so
closing the dialog after a completed pair fired a `cancel_pairing` that owned nothing.
The builder implemented it, wrote a symmetric joiner/host test pair, demonstrated
verbatim RED for all four sub-fixes, and reported cleanly.

The reviewer found that the new host poll could fire a **false** "Device paired
successfully".

`initHost` sets `pairingInfo` inside `executeStartPairing`'s `onSuccess`, but
establishes `knownPeerIdsRef` and bumps `waitSessionRef` *after* it, and
`usePollingQuery` loads immediately when `enabled` flips true. So whenever
`start_pairing` resolved before the peer read, the poll armed against the previous
attempt's baseline — or, on first open, the initial empty set — under a wait id that
still matched. The device's already-paired peers then read as a fresh pin.

The consequence is worse than a spurious toast: the dialog auto-closes and
`backendArmedRef` is disarmed, orphaning the host's genuinely live pairing window on
the backend for its full five-minute TTL. That is the #3469 failure this entire issue
family exists to remove, reintroduced through #3615's own new poll.

It is also the exact class `63934328a` fixed for the joiner earlier the same day —
*scope poll results to the wait they are judged against*. The joiner path obeys that
discipline; the new host path did not. Fixed with two guards: `hostWindowShowing` now
includes `!loading`, which `initHost` holds across both steps, and the baseline is
nulled on entry so anything slipping through fails closed.

**What let it through the builder:** the builder justified a production change by
saying it "mirrors the QR block's own render gate". The actual gate is
`!loading && role === 'host' && pairingInfo`. It reached for the right token and
stopped one short — and the omitted conjunct was the load-bearing one. A justification
that names a real thing in the codebase reads as verified even when nobody checked that
it says what it is claimed to say.

## Reviews are not for finding bugs in the diff

Three of the other four reviews found nothing wrong with the change itself and were
still worth their cost, because what they corrected was the *claims* around it.

**#3340** — the builder moved the journal-page highlight fetch from mount to dropdown
open and called it "strictly less eager IPC overall". The reviewer measured it:
`inflightByKey` is an in-flight-only map that clears on settle, so it dedupes concurrent
subscribers and never successive opens. In the journal view, where `JournalPage` already
fetches the same range on mount, the old cost was 1 IPC total and the new cost is 1 on
mount plus 1 per open. Open/close/reopen: 2 calls, not 1. The change is still right —
the correctness win is what the issue is about — but the PR would have shipped a false
statement about its own cost. The builder also claimed to mirror `DonePanel`;
`DonePanel` wipes on refetch and merges only on append, which is a different shape.

**#3617** — the builder added vectors to `conformance/reference-tokens.vectors.json`
and ran only the TypeScript consumer. That file is a *shared* corpus: the Rust
`page_link_re_parity_boundaries_1920` test drives the same vectors through the real
importer. The whole premise of the fix was "Rust is already correct", and nobody had
checked that the new expected values were what Rust actually produces. They were — but
that was luck plus a correct premise, not evidence, until the reviewer ran it.

**#3556** — the builder proved both arms of the environment gate and reported a clean
mutation battery. The reviewer ran more mutations and found three that survived,
including deleting the strict argument parsing: a typo'd `--install-system-dep` then
degrades silently to a no-flag run, which on a remote VM is indistinguishable from
success while the headers never arrive. It also found the harness used `basename`, an
external command, so under a restricted `PATH` the `uname` fake died and the helper
reported "not Linux, skipping" with exit 0 — a false green in the safety test itself.

## Two premises checked before building, one issue declined

#3605 was labelled `idea` and its body ends in "Decision needed" — whether code-span
protection should extend to page links. It has no maintainer comment. It was left
alone rather than built on a guess; either answer is defensible and the point of the
issue is to get one on record.

The other five had their premises verified against current `main` before any code was
written, and every builder prompt carried an explicit instruction to stop and report
rather than invent a fix if the premise did not hold. All five held.

## Follow-ups filed rather than bundled

Three defects were found that were real but **pre-existing**, each verified as such by
re-running the probe with the fix reverted:

- **#3626** — the per-open highlight refetch above; needs a result cache, not just an
  in-flight one, and invalidation on page create/delete.
- **#3627** — a bare fence opener records `fence_open_depth` from the preceding block in
  Rust and from the delimiter's own indent in TS. They agree only when those are equal,
  which every existing vector happens to satisfy. Same structural gap #3617 closed for
  bullets: two implementations of one mechanism agreeing on every vector anyone thought
  to write.
- **#3628** — closing the pairing dialog during `initHost` lets `start_pairing`'s
  `onSuccess` arm a marker after the close cleanup already ran.

Bundling any of them would have meant altering carefully-reasoned code (#2866's
`openDepth` gate, the cancel invariant) under cover of an unrelated fix, which is how
that reasoning gets silently invalidated.

## Operational notes

The push queue, not agent slots, was the binding constraint. Six agents ran
concurrently without trouble, but the pre-push gate is serial and a `prek.toml` change
pulls in the full Rust lane, so a shell-only diff took ~25 minutes to land. Pushes were
deliberately serialized: at one point 10 GB was available against 28 GB of nearly
exhausted swap with `earlyoom` live, and this repo has a recorded failure where
concurrent hook-heavy pushes were silently OOM-killed while reporting exit 0. Every
push was confirmed by comparing the remote SHA, never by its exit code.

One builder ran `git stash` despite an explicit prohibition. It recovered honestly and
the tree was verified intact — exactly two modified files, correct HEAD, no third stash
entry — but the verification was done by the orchestrator, not taken on the builder's
word.
