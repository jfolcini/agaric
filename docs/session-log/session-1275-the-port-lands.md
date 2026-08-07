# Session 1275 — the port lands, and four ways a green check lied

**Date:** 2026-08-07
**PRs merged:** #3517, #3520, #3521, #3522, #3524, #3527, #3528, #3530, #3531, #3534, #3535, #3537, #3544, #3548, #3549
**Issues closed:** #3430, #3476, #3485, #3494, #3495, #3496, #3498, #3501, #3502, #3508, #3518, #3523, #3526
**Issues filed:** #3538, #3539, #3540, #3541, #3542, #3543, #3545, #3546, #3547

Continues session-1274. That one fixed pairing and mapped the identity question; this one
landed the port and drained the board from thirteen open PRs to zero.

## What is on `main` now

Both sync roles run over iroh QUIC (#3517). The old TLS/WebSocket transport is deleted
(#3544) — `sync_cert.rs`, `sync_net/`, `sync_daemon/wire.rs` and the app-side mirror, about
5,900 lines. The #3502 initiation deadlock is fixed (#3535). The sync documentation has been
re-derived against the code that exists (#3527). And #3507's two-device pairing test exists
(#3549), driving a real initiator against a real responder over real QUIC.

**Q2 still gates release.** Two in-process endpoints over real QUIC is a large step up from
unit tests and is still not two devices; Android/UDP and restrictive WiFi need hardware.

## The recurring lesson: a green check answered a different question

Four distinct shapes turned up in one night, all of which look identical in `gh pr checks`.

**Green with `CHANGES_REQUESTED`.** #3520 and #3521 both reported GREEN with substantive
blocking reviews attached. So did #3499 and #3548 later. Merging on the rollup would have
landed four known defects. The check status and the review verdict answer different
questions, and only one of them is about whether the code is right.

**Green with no CI at all.** `ci.yml` triggers on `pull_request: branches: [main]`, so a PR
stacked on any other branch runs nothing but `claude-review` — and that renders as a green
rollup. #3528 sat green for hours and failed to **compile** the moment it was retargeted.
The fix was to stop reading the rollup and start counting `validate` jobs on the head SHA:
zero means unvalidated, not passing.

**Green on a stale SHA.** #3499's pre-fix commit was green, and its rollup looked exactly
like the fixed one's. Checking `headRefOid` against the commit the fix landed in is the only
thing that distinguishes them.

**Green while the documentation was false.** Covered below; it is the same failure in prose.

The habit that caught all four: before every merge, compare the rollup's SHA to the current
head, count the `validate` jobs, and read the review body. It costs one API call and it
caught something in five of fifteen merges.

## Prose that was true when it was written

Two doc PRs shipped claims that were accurate at authoring time and had quietly become
false — the same shape as a vacuous test, which also looks verified because it once was.

#3548 restored a bullet verbatim from `be13080d2` describing an `is_conflict = 0` predicate.
The text was correct when written; the column was dropped in migration 0058. A PR repairing
prose that a mechanical commit had falsified was itself falsifying prose, by recovering
history without re-checking the current schema.

#3527 was about to publish, in user-facing docs, **"Pairing a new device does not currently
work … no firewall or network change fixes it"** — for a defect fixed hours earlier by
#3535. It also contradicted itself across two files, one saying the old modules were
"deleted by the follow-up PR" and another saying "deleted outright in #3544".

Both were caught by reviewers who checked claims against the current tree rather than
reading the prose for coherence. Internally consistent and externally false is exactly what
prose review cannot see.

A related find while fixing #3548: chasing the reviewer's completeness challenge turned up a
**27th** damaged site the original audit missed, in a file the PR was already editing. The
audit grepped for known-damaged *shapes*, which finds what it is shaped to find; the
survivors were each grammatical enough to read past. That is also why they had survived
seven weeks.

## Three blocking defects in the cutover, each proven by running code

The keystone PR had 8,538 additions, zero reviews, and gated five stacked PRs. Reviewing it
adversarially was the highest-value hour of the night.

**B1 — an empty `device_id` wrote a peer row invisible to the UI but trusted by the
responder.** `list_peer_refs` filters `WHERE peer_id != ''`; `get_peer_ref_by_endpoint_id`
did not. So the row could not be seen or unpaired, yet still resolved the S-1 lookup — and
being "bound" skips the #855 proof and the self-check. Proven against a migrated pool.

This was a **regression**, not an inherited wart. The old stack wrote the same row but it was
inert, because the old responder rejected an empty `remote_id` outright. The port re-keyed
the lookup onto the endpoint id (making the row findable) and dropped that rejection. The
corroborating detail: `Rejection::peer_message` reproduces five of the old six peer-facing
strings verbatim, and the missing sixth is exactly `"cannot identify remote device"`.

Fixed at four independent points, because they fail independently and the bad row is
unremovable through the UI once written.

**B2 — the cutover guard could not see the only spelling it needed to catch.** `NEEDLES`
matched `super::wire::` and `sync_daemon::wire`, but every retired call site was
`use super::wire;` followed by bare `wire::`. Planting exactly that back in left the guard
passing. The guard was sold as the paid-for substitute for the completeness check that real
deletion gives; the forced-red demo happened to use a spelling that matched.

Widening the scan to all workspace roots then found a **live** offender: a real
`use agaric_sync::sync_net::SyncConnection` in `sync_files/mod.rs`, dead but masked by that
file's own `#![cfg_attr(test, allow(unused_imports))]`, which would have broken the
mechanical deletion. Two independent agents found that import by different routes.

**B3 — `recv_sync_message` is not cancel-safe, and the file-transfer loop dropped it every
150 ms.** Framing state lives in the future's locals and `read_exact` has already consumed
bytes into it, so dropping mid-frame discards them and the next iteration reads body bytes
as a length prefix. The loop was **correct under the old transport**, where
`WebSocketStream::next()` kept partial state in the stream object; the comment saying "the
normal path is unchanged" carried over verbatim and had become false. Availability, not
integrity — JSON bytes are all ≥ 0x20, so any resync window exceeds the frame cap.

## The test that would have caught three bugs

#3507's premise: three defects (#3463, #3469, #3502) reached `main` through one flow, and
the same missing test would have caught all three. It exists now — and catches **two**.

#3469 is a frontend defect with no Rust production fix to revert, so no Rust test can go red
on it. Reporting two of three is the honest answer; claiming three would have been the easy
lie, and a test that would not have caught the bugs it was written for is worse than none,
because it reads as coverage.

The issue's suggested scaffolding turned out to be the wrong one: `SyncDaemon` exposes no
endpoint, no bound address and no `EndpointId`, so there is no in-process way to make one
daemon dial another without multicast. `ServiceHarness` is the pair that works — a real
responder whose `InboundSession` has no public constructor, so admission cannot be faked.

Two findings fell out of building it. **#3491 reproduces hard**: `reject()` writes to the
wire and the log and touches no event sink, so the rejecting device's own sink is literally
empty. That test is `#[ignore]`d **stating the property** rather than pinning today's
behaviour — asserting `is_empty()` would go red on the fix, which is backwards. And **#3503
does not reproduce in Rust at all**: the host's sink does receive its `Complete`; the gap is
only that `PairingDialog` never subscribes.

## Operational notes worth keeping

**GitHub Actions was in major outage twice.** The diagnostic that separates "my push failed"
from "GitHub is down" is one command: compare local `HEAD` against `git ls-remote` per
branch. All seven force-pushes had landed; the missing runs were upstream. Without that
check the obvious inference — that force-pushing had silently failed — would have sent the
session into a retry loop against an outage.

**Two worktree traps cost three failed pushes, both diagnosable.** A worktree's `dev.db`
goes stale the moment a migration lands on `main` while it is alive, and the online sqlx
check then fails a change that has nothing to do with it (`no such column: endpoint_id` on a
docs-only branch). And any diff touching `src/mcp/` needs the prebuilt sidecar or the gate
fails at `stub_binary_roundtrips_initialize_over_uds`. Both present as code failures on
branches whose diff cannot possibly cause them.

**My own push queue deadlocked on itself.** The guard `pgrep -f 'git push'` matches the
wrapper script running the guard, so four branches sat waiting for themselves. `pgrep -x`
against the real binary names is the fix. Worth noting it looked exactly like "still
waiting".

**Concurrent heavy pushes get killed.** Starting the cutover's full gate while the queue was
still running lost both. The postcondition check is what made the damage legible — three of
five had landed, and the remaining two were unambiguous rather than mysterious.

## Where sync actually stands

Structurally complete. The transport is QUIC, the dead stack is gone, the docs describe what
exists, and the regressions that shipped three times are now mechanically caught.

What is not done: #3511's S-5 lock asymmetry (in flight), #3491's one-sided rejection,
#3503's unsubscribed host, #3120's cross-crate testability (whose headline number was
corrected from "25.2K across four modules" to ~24.5K across three — the falling count is
misleading, since the module that evaporated was the only pure-transport one and the
coupling it was filed about is untouched), and #3547's newly-found interaction where
accumulated backoff can swallow the very post-confirm dial the #3502 fix exists to make.

And the thing no amount of unit testing settles: two live devices, on real hardware, over a
network we do not control.
