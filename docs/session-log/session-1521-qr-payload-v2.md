# Session 1521 — the pairing QR carries where to dial (#4037)

A first pair depended entirely on multicast. On an AP with client isolation, a guest VLAN, or an
Android build whose background firewall chain drops the packets, it could not happen at all. The QR
now carries `endpoint_id` plus the addresses the endpoint actually bound, so the joiner has a path
to race.

## What v2 is, and what it is not

Additive. mDNS is untouched and remains both the discovery path and the staleness fallback — a DHCP
lease that turns over between the QR being rendered and being scanned invalidates every candidate
in it. The candidates buy the *first* pair on a network where multicast does not work; they do not
replace discovery.

A payload with no endpoint to advertise is tagged **v1, not a lesser v2**, because that is what it
is: passphrase only, mDNS owning discovery. Tagging it `2` would promise a joiner fields it does not
carry. Hence two constants, `PAIRING_QR_VERSION = 2` and
`PAIRING_QR_VERSION_PASSPHRASE_ONLY = 1`.

`endpoint_id` alone would not have been enough. A dial naming only a key, on a LAN-only endpoint
with no relay and no discovery service, has no path to try and fails in well under a millisecond —
measured, and pinned by `a_dial_naming_only_an_endpoint_id_fails_fast_instead_of_hanging`. That
measurement is also why a stale candidate is cheap: it costs the joiner microseconds before mDNS
gets its turn, not a dial budget.

## The candidate list was unbounded, and the QR is read by a camera

`publish_local_endpoint` was handed `service.addr().ip_addrs().copied().collect()` — every address
the endpoint bound, with nothing about the user's network limiting how many that is. Wi-Fi and
Ethernet both up, a VPN tunnel, a container bridge, or any IPv6 address (more than twice an IPv4
one in this payload). The QR is read by a phone camera out of a 200 px box, so payload bytes are a
scannability budget.

`MAX_QR_ADDR_CANDIDATES = 2`. Truncating is safe in a way that dropping an mDNS record would not
be: a candidate only ever *races* mDNS, so a dropped one costs a first pair nothing unless
multicast is also broken AND the reachable address was the one dropped.

## The payload could not produce a dialable peer, and the diff said so

The first design here was wrong, and the evidence was already in this branch's own docs.

`DiscoveredPeers` is keyed by **device id**, and `try_sync_with_peer` spends that id twice: as the
orchestrator's `expected_remote_id`, and as the `peer_refs.peer_id` that `bind_endpoint_id` writes
on TOFU success. That bind refuses to be re-pointed, so a synthesised id would be permanent and
would lock the real peer out forever. The v2 payload carried `endpoint_id` and `addrs` and no device
id, so no amount of joiner-side plumbing could have dialled with it — and
`docs/architecture/sync-and-network.md`, added by this same branch, already stated it: "a
`DiscoveredPeer` needs a `device_id`, which the QR does not carry."

So `device_id` joins the v2 shape. `LocalEndpointAdvert` carries it, published by `daemon_loop`,
which already had it.

## The density numbers, re-measured after that

Every figure transcribed from a failing run, never computed:

| payload | bytes | QR version | modules | px/module across 176 px |
|---|---|---|---|---|
| v1, passphrase only | 61 | 4 | 33 | 4.3 |
| v2, one candidate | 224 | 11 | 61 | 2.6 |
| v2, two candidates (the cap) | 241 | 12 | 65 | 2.4 |
| v2, three candidates | 260 | 12 | 65 | 2.4 |

**The cap's original justification is now false.** It read "two is the last rung before density
degrades"; with `device_id` in the payload a third address costs no version at all. The cap stays at
two because that is what a multi-homed host actually has and because an uncapped `ip_addrs()` is
unbounded — not because of a cliff that no longer exists. Worth revisiting deliberately.

This is the third time in this change a QR number was asserted before it was run. The first two —
"two candidates cost no more than one" and "three stay on version 10" — were caught by the test
that calls itself "a record, not a limit". The third was the whole table above, invalidated by a
field the design needed all along.

## The dormant waiter consumed the wake it was supposed to pass on

`start_pairing_armed` waits for the endpoint publish, which cannot happen until the dormant waiter
leaves its `select!`. It used `wait_for_debounced_change()`, so it burned the full 3 s
`DEFAULT_DEBOUNCE` before binding: **3.29 s → 0.37 s** on `dormant_daemon_wakes_on_pair_notification`.

The latency was the visible half. `wait_for_debounced_change` also advances `debounced_through`, so
the dormant waiter *consumed* the pairing wake and the freshly-started `daemon_loop`'s Branch B
parked waiting for a second change a quiet device need never produce — a first-ever pair with
nothing to dial. `wait_for_change_after` leaves the change owed.

## Verified

`cargo nextest run -p agaric-sync -E 'test(pairing) or test(4037) or test(local_endpoint)'` — **38
passed**. `PairingDialog.test.tsx` — **83 passed**, covering the v2 shape, the v1 shape, a bare
non-JSON passphrase (the TS parser accepts one and does not check `v`), and `axe`.
`cargo check -p agaric-sync -p agaric-store --all-targets` — clean.
