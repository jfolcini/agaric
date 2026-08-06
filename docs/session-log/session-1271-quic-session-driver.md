# Session 1271 — the QUIC session driver, and a CI outage that wasn't ours

**Date:** 2026-08-06
**Issues:** #3464 (plan), #3476 (filed)
**PRs:** #3473, #3474, #3475, #3477, #3478

Continues session-1270. That session established the transport primitives — a
LAN-only endpoint and `SyncMessage` framing over QUIC — and fixed the pairing bug that
had made sync unusable since it shipped. This one builds the loop that uses them.

## The session driver

`transport/driver.rs` is one loop for both roles, where the old stack has two.

The duplication was not sloppiness; it was forced. The responder could not know who it
was talking to until it had read `HeadExchange` and inspected the TLS certificate
behind it, so its first message was an *identity* event rather than a protocol one and
its loop had to start a step later than the initiator's. Under QUIC the peer is
authenticated by the handshake, before a single application byte moves. The asymmetry
that required two loops is gone and what remains is one bit: who speaks first.

This is the first place where plan #3464's D3 pays for itself in code rather than in
argument. D3 was written as hardening — "`DeviceId` is never read off the wire" — and
it turns out to be what collapses the two loops into one.

### Two clocks, both nearly lost

A session loop needs a per-dispatch bound and a per-receive bound, and the old stack
had both. `HANDSHAKE_TIMEOUT` (120 s) was easy to carry: it is in `sync_constants` and
already named at all three old dispatch sites.

The receive bound was not. `SyncConnection::RECV_TIMEOUT` (180 s) bounded *every* recv
on the WebSocket stream, it lives in `sync_net` — which this port deletes — and **QUIC
has no equivalent**. `RecvStream::read_exact` against a peer that simply stops talking
waits forever. Losing it would have cost nothing observable until a peer went quiet in
production and pinned a responder permit and a per-peer lock until restart.

It survives because the port went looking for what the old transport was doing *for*
the protocol, not just what it was doing. That is the general shape of the risk here:
the things a transport supplies invisibly are exactly the things a transport swap
drops silently.

`SessionLimits` exists so both clocks are drivable from a test. A 180 s timeout that no
test exercises is indistinguishable from a missing one — which is precisely how the
receive clock would have gone missing.

### Shutdown turned out to be protocol

The responder reaches its terminal state the moment it *queues* `SyncComplete`, one
round trip before the initiator has read it. Returning there drops the connection,
which discards the in-flight frame, and the initiator fails with `connection lost`
having done everything right.

WebSocket's close handshake supplied this for free, which is why nothing in the old
code looks like it. `finish_session` is role-aware for that reason: the responder
finishes its stream and waits for the initiator's close, because that close is the only
available evidence the last frame landed.

Falsification confirmed it rather than merely illustrating it — removing the wait
reproduces `read length prefix: connection lost`, the identical error the first run of
session-1270's handshake test hit.

## Where a fix pointed the wrong way

`recv_sync_message` bounded the announced frame length and then allocated it:
`vec![0u8; capacity]`. The cap bounds what a frame may *cost*; it does not bound what
four bytes may *reserve*. A prefix announcing exactly `MAX_FRAME_SIZE` is within the
cap, so it committed 256 MB before a body byte existed. The existing
`an_oversized_length_prefix_is_refused_before_allocating` could not catch it — that
covers lengths *above* the cap. The hole was the value at the boundary.

The first fix grew the buffer in chunks. Review caught that this made the target case
**worse**: `Vec` grows geometrically, so a real 256 MB frame ended at a ~320 MB capacity
and held both halves live across the final reallocation — a transient peak above the
eager form it replaced, on exactly the 32-bit Android target the change was justified
by. The fix was aimed at Android and made Android's worst case worse.

The correction is that chunking exists to stop an *unpaid claim* from allocating, and
is not something to keep doing once bytes are arriving: one chunk against the announced
length, then one `reserve_exact` for the remainder. What remains is an amplification of
5 MB against 256 MB — a peer must deliver real bytes to reserve, which is the property
that was wanted.

Worth recording that the reviewer arrived at the design I had considered and discarded
as "muddier" earlier the same session. The tidier invariant was the wrong one.

## Testing an allocation

"Does not reserve what has not arrived" is a claim about capacity, and every
behavioural proxy for it — the error returned, the time taken — is identical before and
after. Two approaches were tried:

1. A `#[global_allocator]` probe recording the largest allocation. Rejected: the crate
   denies `unsafe_code`, and the deny was right.
2. A one-method `BodyReader` trait, so a reader that *refuses to deliver* can drive the
   growth policy and leave the partially-grown buffer observable.

The second is better than the first would have been — deterministic, no allocator
overhead, no cross-test interference. The lint that blocked the first approach improved
the design rather than obstructing it.

It has a stated limit: the guard binds `read_body`, so a `Vec::with_capacity(capacity)`
reintroduced at the call site would restore the amplification with every test green.
Written down at the function rather than left for someone to discover.

## The CI outage

`validate / lint` went red on every open PR with 10 zizmor `ref-version-mismatch`
findings, none from any PR's diff.

`Swatinem/rust-cache` was pinned to an **untagged** commit from March, commented `# v2`.
`v2` is a floating major tag and it moved that morning — v2.9.2 published 06:26 UTC,
about an hour before the first red run. zizmor resolves the comment against the pin, and
they stopped agreeing.

Two things made this worse than a one-line fix:

- The pin was never verifiable. No tag ever pointed at that commit, so the comment was
  decorative from the day it was written.
- **The local gate could not see it.** `ref-version-mismatch` is an *online* audit, and
  `scripts/zizmor-hook.sh` degrades to `--no-online-audits` locally. Compounding it, the
  locally installed zizmor is 1.24.1 and does not have the audit at all —
  `cargo install zizmor --locked` is unpinned, so local and CI drift freely. Filed as
  #3476: every other lint in this repo has the property that green pre-push predicts
  green CI, and zizmor does not, in two independent ways.

Fixed by pinning all three bare-major comments to exact released versions. Only
rust-cache's hash actually moved; `upload-artifact` and `setup-android` already resolved
to their exact tags, so those 16 lines were comment accuracy at zero version change —
which is the whole difference between unbreaking CI and stopping the recurrence, since
`v7` happens to equal `v7.0.1` today exactly as rust-cache's `v2` did until 06:26.

## Code scanning cleared

Three open alerts, all `rust/unused-variable`, all false: CodeQL's Rust extractor does
not model Rust 2021 inline format-arg captures, so a variable used only as `{i}` inside
`panic!` reads as dead. Verified against rustc, which warns on a genuinely unused
binding in the same file and stays silent on these.

The denominator was the finding: **135 alerts of that one rule, 132 already dismissed by
hand**, and these three were the entire open list — a 100% false-positive rate. So the
generator was fixed rather than the instances, via a `query-filters` exclusion. The
argument for it is that clippy answers the same question exactly (`--workspace
--all-targets -- -D warnings`), so nothing is lost; review found the narrow exception —
`src-tauri/fuzz` is its own workspace and clippy never reaches its 5 targets — and the
config now says so instead of claiming absolute safety.

Open alerts: 0.

## State of the port

Merged: pairing fix, LAN-only endpoint with its CI guard, snapshot schema pin,
`SyncMessage` over QUIC, LAN bind locality, error-source hygiene.

In flight: the frame-reservation fix (#3477) and the session driver (#3478).

Everything in `transport/` remains additive — nothing calls it, and both old loops still
run. That is deliberate: the cutover is what lets `sync_net`, `wire.rs` and
`sync_cert.rs` be *deleted* rather than edited, and it wants the driver landed and
reviewed first.

**Q2 still gates release, not development:** QUIC/UDP on Android and restrictive WiFi
needs hardware. Nothing this session is evidence about it.
