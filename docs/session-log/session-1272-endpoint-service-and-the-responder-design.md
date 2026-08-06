# Session 1272 — the endpoint service, and reading the responder properly

**Date:** 2026-08-06
**Issues:** #3464 (plan), #3470 (decided)
**PRs:** #3486

Continues session-1271. That session built the session driver — one loop for both
roles. This one puts a door in front of it, and then spends its remaining effort on
the thing the port has been deferring: reading the responder closely enough to know
what the cutover actually deletes.

## Admission control belongs at the connection

`transport/service.rs` binds the LAN-only endpoint, accepts connections, and holds
the 16-slot cap that `MAX_CONCURRENT_RESPONDER_SESSIONS` has always named. The
substantive change from the old stack is *where* the cap is enforced: a permit is
taken with `try_acquire_owned()` **before** the handshake, and an over-capacity
connection is refused via `Incoming::refuse()` rather than accepted and then
disappointed.

### The spec was wrong, and the build caught it

The design I handed the builder had `accept()` awaiting the handshake and
`accept_bi()` inline. That is wrong in a way that makes the cap decorative: a peer
that completes the QUIC handshake and then never opens a stream parks the entire
accept loop, so the 15 free slots are unreachable. A cap that cannot be reached is
not a cap.

Both are now bounded by `CONNECTION_SETUP_TIMEOUT` (10 s, carried from
`TLS_HANDSHAKE_TIMEOUT`). The residual — that setup is still *serialized* even
though it is now bounded — is filed as #3485 rather than fixed here, because
fixing it means spawning per connection and that is a different change with a
different failure mode.

## Three review findings, one of which was more interesting than it looked

### A shared constant that made its own tests vacuous

`driver` and `session` each carried a test-local `const SYNC_ALPN: &[u8] =
b"agaric/sync/0"`. The obvious complaint is duplication. The real problem showed
up only when forcing it red: **bumping the canonical constant left every test in
both modules green.** Each test builds *both* ends of the connection from its own
local copy, so the two ends agree with each other at any value whatsoever, while
disagreeing with production.

The copies are gone in favour of importing the canonical constant, which makes
drift structurally impossible. But that leaves the finding with no assertion of
its own — so `SYNC_ALPN` is now pinned as a literal, the way `driver` already pins
its limits. Changing the ALPN is a wire-compatibility break that strands every
device that has not upgraded; it should cost a deliberate edit and a migration
story.

The general shape is worth keeping: **a constant shared by both sides of a test's
own fixture cannot be tested by that fixture.** Symmetry hides it.

### A test that could not catch the mistake it was named for

`accept()` returns `None` only when the endpoint is closed. Two ways to get that
wrong: return an error instead, or `continue` instead. The new test catches the
first. Forcing the second proved it **cannot** catch it — `Endpoint::accept`
returns `None` immediately once closed, so the loop never yields, and
`tokio::time::timeout` never gets scheduled to observe its own deadline. The
failure surfaces as nextest's hard timeout instead.

No in-process deadline can preempt a non-yielding loop. Written at the constant
rather than left looking like coverage, because a reader would otherwise
reasonably assume the deadline covers both.

### A bound that was measuring the wrong peer

`TEST_SETUP_TIMEOUT` (300 ms) was introduced to make the stalled-peer test cheap.
It also bounded the *well-behaved* peer in that test. On a loaded runner the
healthy peer would be dropped during its own setup, and the test would fail
announcing that the accept loop was parked on the stalled peer — a confidently
wrong diagnosis, which is worse than a plain failure. Now 1 s, sized as ~14x the
0.07 s LAN handshake measured in the #3462 spike, with the arithmetic written down
at both constants.

### And one the review caught after that

The approving review raised, non-blocking, that `CONNECTION_SETUP_TIMEOUT`'s real
scope is wider than its docs claimed — and it was right, in a way that made it
worth fixing rather than filing.

A locally-opened QUIC stream is invisible to the peer until something is sent on
it. The test module already knew this (its `dial` helper has to write a byte for
exactly that reason) without drawing the consequence: `accept_bi` does not resolve
when the initiator *opens* its stream, it resolves when the initiator *speaks*.
And the initiator's first message comes from `orch.start()`, which reads the local
heads, collects the Loro version vectors, and looks up the pending pairing proof.
That is database work on a device that may hold a large vault.

So one 10 s budget was covering both a handshake and a wait for peer-side database
work — tightening the first-message window from the **180 s** the old responder
gave it (`RECV_TIMEOUT`, which bounded its first `recv`) down to a handshake's
budget. `TLS_HANDSHAKE_TIMEOUT` covered TLS plus the WebSocket upgrade, neither of
which required the initiator to touch the database, so it was never the right
analogy for this half.

Now split: `CONNECTION_SETUP_TIMEOUT` (10 s) for the handshake,
`FIRST_FRAME_TIMEOUT` (180 s) for the first frame, each pinned by its own literal.
The old pinning test asserted `CONNECTION_SETUP_TIMEOUT < HANDSHAKE_TIMEOUT` on
the rationale that the two "cover disjoint phases" — a rationale that was false for
exactly this window, which is why pinning them separately is what makes the two
phases visibly two.

**This is #3481 in the opposite direction.** There, a constant kept its value while
its scope silently *widened*. Here, one was applied to a scope it never covered.
Both come of carrying a number across a transport swap by its **name** rather than
by what it bounds — and both were invisible because the number itself never
changed. Worth stating as a rule for the rest of the port: when a constant moves
to a new transport, the thing to re-derive is not its value but its *scope*, and
the test that pins it should assert the scope's boundary, not just the number.

Nothing was lost in the fix: the slot is still released on elapse either way. A
peer stalled after the handshake now holds its slot for up to 180 s rather than
10 s, which is what the old responder did — so it is not a regression this port
introduces, and the real fix for one stalled peer blocking *others* is
per-connection spawning (#3485), not under-budgeting a wait that legitimately
needs the time.

## Reading the responder

`handle_incoming_sync_inner` is 540 lines (`server.rs:177-716`), and most of what
makes it long is one thing: **identity arrives after the connection does.** TLS
here accepts anonymous clients and the certs are self-signed, so `CN=agaric-{victim}`
can be minted by anyone. The CN is a claim, and everything guarding it is app-layer
compensation.

The history of that compensation is the tell — #3324 (a non-`HeadExchange` first
message ran a fully unauthenticated session that could reach the full-snapshot
export), B-34 (a CN-vs-heads check that had to be *removed* as invalid once #2481
frontier advertisement landed), #800, and the B-33/#855/#1519 TOFU-pinning tangle.

`EndpointId` is not a claim. It is an ed25519 public key
(`iroh-base-1.0.3/src/key.rs:70`, `:30`) authenticated by the TLS 1.3 handshake
inside QUIC, before a single application byte moves. So `verify_peer_cert` and
`CertVerifyResult` delete entirely, taking `sync_cert.rs` (977 LOC) with them, and
#3324's whole bug class becomes *unrepresentable* rather than guarded — authorization
can run before the first recv.

### The part that must not be deleted with it

The #855 pairing proof stays. Its comment says "CN-spoof guard", which makes it
read like part of the cert defence that cryptographic identity retires. That
reading is wrong and it is the mistake this port is most likely to make.

QUIC answers *which key is this*. It does not answer *should this key be allowed
to sync my vault*. Anyone can generate a keypair and dial. Without the passphrase
proof the pairing window would admit — and TOFU-pin — any endpoint that connected
during it. What changes is the proof's job, not its necessity: from "defend against
a spoofed identity being pinned as the victim" to "authorize a genuine but unknown
identity". Narrower, still required.

This is also the concrete reason `peer_refs.endpoint_id` must land *with* the
cutover: it replaces `cert_hash` as the pinned-identity store, and the two columns
answer different questions — a key that *is* the identity, versus a hash pinned
*against* a separately-claimed one. Migrations here are append-only.

## Where the cutover is actually blocked

`run_sync_session` does not end at the message loop. It holds `&mut conn` for two
more phases: snapshot catch-up on `ResetRequired` (`session_supervisor.rs:1096`)
and attachment file transfer on success (`:1165`). The responder mirrors both. So
swapping only the loop to QUIC leaves those phases with no connection to run on —
slice 1 cannot ship alone.

The good news is that slice 2 is not the redesign the plan feared. The bulk API is
already generic over the right traits —
`send_binary_streaming_with_progress<R: AsyncRead + Unpin>` (`connection.rs:322`),
`receive_binary_streaming<W: AsyncWrite + Unpin>` (`:389`) — and quinn implements
exactly those, unconditionally: `impl tokio::io::AsyncRead for RecvStream`
(`recv_stream.rs:495`), `impl tokio::io::AsyncWrite for SendStream`
(`send_stream.rs:326`), both outside the `futures-io` cfg directly above them.

So `chunk_size` and `BINARY_FRAME_CHUNK_SIZE` are not logic to port. They exist
only because WebSocket frames have practical size limits. That was already D5's
argument; what is new is that removing them leaves the call sites' own shape
intact. The fear was that iroh-blobs' content-addressed model ("hand over a hash,
let the peer fetch") is a different shape from what these call sites do ("stream
the bytes the peer asked for"). A QUIC stream is the *same* shape, minus the
workaround.

One thing that must survive the simplification: the streaming path never
materialises the payload, which is what lets attachments be multi-gigabyte while
the framed path is capped at 256 MB. The two will look redundant to a future
reader. They are not.

## #3470 decided

"iroh is an unconditional dependency for a module with no production callers"
asked for a decision rather than a default. Decided: leave it ungated, closing
when the cutover gives `transport` production callers.

The body's "~380 transitive crates" is a whole-tree figure, not a marginal one.
Measured (`cargo tree --edges normal`, deduplicated): `agaric-sync` 396,
`iroh`'s own subtree 263, `agaric-core` 124 for scale. The marginal cost is lower
than 263 and deliberately not quoted — getting it honestly means removing the
dependency and re-resolving. The point is that the number the decision was being
weighed against was the wrong number, in the direction that made gating look more
attractive.

The two measurements the issue asks for — clean-build wall-clock and release
binary size — are worth doing *after* the cutover, when they measure a dependency
we use rather than one we are deciding whether to keep.

## State of the port

Merged: pairing fix, LAN-only endpoint and its CI guard, snapshot schema pin,
`SyncMessage` over QUIC, LAN bind locality, error-source hygiene, frame-reservation
hardening, the session driver.

In flight: the endpoint service (#3486).

Everything in `transport/` is still additive — nothing calls it. That remains
deliberate: the cutover is what lets `sync_net`, `wire.rs` and `sync_cert.rs` be
*deleted* rather than edited.

**Q2 still gates release, not development:** QUIC/UDP on Android and restrictive
WiFi needs hardware. Nothing this session is evidence about it.
