# Session 1274 — pairing fixed, and the identity question the port actually raises

**Date:** 2026-08-06 / 07
**Issues:** #3502 (fixed), #3430 (fixed), #3494 (fixed), #3353 (fixed), #3433 / #3523 / #3450 (fixed), #3529 / #3532 / #3533 (filed), #3510 / #3511 (corrected)
**PRs:** #3527, #3528, #3530, #3531, and the #3502 fix

Continues session-1273, which found *why* pairing never worked. This one fixed it, and
then spent its blocked time on the question the fix exposed: after the port, what is a
peer's identity?

## The fix, and the part of the issue that was wrong

#3502's two unreachable sites are now reachable. `should_attempt_sync_with_discovered_peer`
reorders its arms to self → `pairing_pending` → `already_discovered` → `peer_refs`, and
`process_discovery_event` drops the `if already_discovered { return None; }` that sat
between the map insert and the decision. The timestamp refresh stays unconditional —
Branch C's staleness sweep depends on it; only the *decision* moved.

The interesting part is Part 2, where the issue's own design is wrong.

#3502 asks for a fourth `select!` branch triggered on the `pairing_pending` **false→true**
transition. That edge never occurs in the scenario the issue describes. The dialog defaults
to the host role and calls `initHost()` on every open, so both devices arm their marker
*before* the user types anything. `pairing_pending` is already `true`; `confirm_pairing`
then overwrites the marker's **proof** while the bool never changes. An edge-triggered
branch would sit out the exact deadlock it was written for.

The content changed, and the content is what the wire-side #855 gate compares. So Branch B
— already parked on the `Notify` that both pairing commands fire — gates on "the window is
open at this wake" instead.

### The falsification that mattered

Session 1273 recorded that the bypass is unreachable at *two* sites, so a fix touching one
looks right and changes nothing. That made the test requirement specific: it had to catch a
half-fix, not just a full revert.

`process_discovery_unpaired_returns_some_only_while_pairing_pending` drives one map across
a `false → true` flip, so it reds if *either* site is broken. It was verified against three
separate defect injections — full revert, function-fixed-caller-broken, and
caller-fixed-function-broken — and goes red in all three. Its previous incarnation could
not fail for the reason it appeared to test, because it swapped in a fresh map to avoid the
guard it was named after.

### What is still not covered, stated rather than buried

Branch B's *wiring* has no test. `discovered` is private to `daemon_loop` and only real
mDNS populates it, so the extracted helper is the only available seam; reverting the
wiring alone turns nothing red. Filed as #3533. #3507's two-device test remains the only
thing that would prove any of this end to end.

## The identity question (#3529)

Four open issues turned out to be one decision, and each was being taken separately.

The port introduces an identifier with properties none of the previous ones had.
`EndpointId` is authenticated *before any application byte* — it is the ed25519 key the
QUIC/TLS 1.3 handshake proves possession of, not a claim carried in a frame — and it is
available to both roles unconditionally, because the responder gets it from the handshake
and the initiator must have it to dial at all.

The daemon still keys its machinery on identifiers that are strictly weaker:

| identifier | responder has it | initiator has it | authenticated |
| --- | --- | --- | --- |
| `device_id` | only from `HeadExchange`, only if the peer advertised a head | always | no — a claim in a frame |
| `cert_hash` | after the TLS handshake | after connecting | pins a key to a *separately claimed* identity |
| `EndpointId` | before byte one | before dialling | yes — the key **is** the identity |

**S-5's per-peer lock is the sharpest case.** Inbound keys on `remote_id` when the frame
supplied one and falls back to the endpoint id otherwise; outbound always keys on
`device_id`. During the pairing window the two roles on one device disagree, so an inbound
and an outbound session with the same physical peer can overlap. The code concedes this in
its own comment — the old stack had no such gap, because the cert CN gave the responder a
device id unconditionally.

The obvious fix is to add `device_id` to `HeadExchange`. That is the wrong lever: the field
would arrive *after* the connection is accepted, so the responder would still have to
choose a key before it had one, and it costs a wire field forever. Keying both sides on
`EndpointId` needs no wire change and is a two-step reorder — `try_sync_with_peer` locks at
step 2 and only resolves `peer.endpoint_id` at step 3, and that resolution touches neither
the network nor the database. Swapping them also stops taking a lock for a peer that has no
endpoint id and therefore cannot be dialled at all.

The line the issue proposes: **`device_id` answers "whose data is this?", `EndpointId`
answers "who am I talking to right now?"** The bugs come from using the first to answer the
second. `device_id` stays the durable identity — `EndpointId` is 1:1 with an *install*, so
a reinstall mints a new one, which is exactly why it must not become the durable key.

One product question is left open rather than decided: #3514 means every already-paired
install re-TOFUs once after upgrade, unavoidably, because a certificate hash cannot be
turned into a public key. Silent re-pin is the smallest change and matches what the old
initiator did — but it also means the one moment an attacker could substitute an identity
is the moment we say nothing.

## PR B is much smaller than its inventory says

#3510's deletion inventory was built before PR A landed. Re-measured against the tree that
now exists, most of it is stale in the good direction:

- Its headline risk — `src/sync_daemon/tests.rs`, 9,673 lines, **165 references**, called
  "the riskiest deletion, and it is not on any list" — is down to **one**, and it is a
  comment. PR A re-pointed the other 164 as a side effect of crossing both roles.
- `snapshot_transfer_tests.rs`, listed as "do not delete — 21 of 28 are transport-coupled
  but must be *ported*", has **zero** `SyncConnection` and **zero** `test_connection_pair`.
  Already ported. That was the largest judgement-heavy item on the list.
- `sync_files/tests.rs` went from 21 references to 1.

What remains is one genuinely per-test file (`src/sync_net/tests.rs`, 1,729 lines), four
wholesale deletions, two `pub mod` lines, and ~10 doc comments. Total live references
across the workspace: 142 across 29 files, mostly inside files being deleted anyway.

Two decisions the original plan did not contain: `transport/identity.rs` cites `sync_cert`
as the **rationale** for its file permissions, so deleting the module without rewriting
leaves the new code's justification pointing at nothing; and the `NEEDLES` cutover guard
becomes trivially satisfied once the modules are gone, which is the same question #3508
raises about `snapshot_chunk_size_under_max_msg_size` and should be answered the same way.

## A mechanical commit that damaged prose, repo-wide

#3430 reports two stale wordings in the MCP docs and blames PR #3420. That attribution is
wrong. `git log -L` puts the damage at `b35bdcee6` ("remove legacy task-tracking shorthand
codes", 2026-06-20), which stripped codes like `FEAT-4` and took surrounding characters
with them. #3420 later edited one of the same blocks without noticing.

Two shapes, 26 sites across 23 files:

- **Dropped `- ` list markers**, which make rustdoc render the item as continuation text of
  the previous bullet. `materializer/retry_queue.rs` is the worst: it announces "Three
  families:" and lost the markers on families two and three, so it currently reads as
  though per-block tasks are keyed by real block id *and* `GLOBAL_TASK_SENTINEL` *and*
  `(device_id, seq)` at once.
- **Subjectless sentences** — "The ring is pure in-memory state. explicitly rejected a new
  table", and `e2e/starred-pages.spec.ts`, which lost two subjects and had "sort order
  applies" mangled into "sort Applies".

One site predated that commit and was recovered from `be13080d2`: `spaces.rs` read
`- ** predicate.**`, an empty heading, where the original was ``- **`is_conflict = 0`
predicate.**``. The backticked SQL was presumably mistaken for a task code.

The general lesson is narrow but real: **a mechanical strip across 889 files needs a
rendered-output check, not just a compile.** Every one of these sites compiles fine and
renders wrong.

## Two things this session got wrong

**Basing follow-up issues on the wrong branch.** #3495 and #3496 are follow-ups to PR
#3499's content, which is not on `main`. The worktree was cut from `main` anyway. The agent
found no `joinerPhase`, concluded it needed building, and re-implemented ~250 lines of
#3499 from scratch plus 556 lines of tests. All of it was discarded and redone on
`claude/pairing-outcome-dialog`, carrying the *diagnoses* forward — which were sound and
were the expensive part. Cost: one agent run. The check that would have caught it takes one
command: does the base contain the symbol the issue talks about?

**Trusting a green pre-push gate to mean the branch is fine, and then trusting a red one to
mean it isn't.** A docs-only branch stacked on the cutover failed Phase D, whose range is
`origin/main...HEAD` and therefore covers the cutover's Rust even for a markdown diff. It
took a full `--workspace` run to establish the truth: **5564/5564 green** on an unloaded
box, and the two failures under load 39 are timeouts, not assertions. One of them,
`find_lca_terminates_on_any_graph`, has no nextest override while its slow peers do (#3532).

## The outage, and what it says about the PR graph

GitHub Actions was in a major outage from 15:22 UTC, with webhooks throttled to ~15%. Nine
PRs sat with zero checks; closing and reopening them to force the `reopened` event landed
1 in 7.

The useful thing it surfaced: `ci.yml` triggers on `pull_request: branches: [main]`, so
**every stacked PR gets zero CI**, outage or not. #3527, #3528 and the #3502 fix are all
based on `claude/sync-cutover`. Retargeting them to `main` after #3517 merges is not
hygiene, it is the only way they are ever validated — and a stacked PR does not
auto-retarget when its parent squash-merges (the #1380/#1323 incident).

## State

Merged earlier in the port: pairing fix, LAN-only endpoint, snapshot schema pin,
`SyncMessage` over QUIC, LAN bind locality, error-source hygiene, frame-reservation
hardening, the session driver, the endpoint service, bulk transfer.

In flight: the cutover (#3517) and everything stacked on it, plus the CI pin batch, the
undo wedge, the prose repair, and the joiner-wait follow-ups.

**Q2 still gates release, not development** — QUIC/UDP on Android and restrictive WiFi
needs hardware. #3502 no longer gates it. #3507 does: nothing here has been proven against
two live daemons, and until it has, "pairing works" is an inference from unit tests, not an
observation.
