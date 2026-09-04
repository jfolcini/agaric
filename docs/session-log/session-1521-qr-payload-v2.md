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

`MAX_QR_ADDR_CANDIDATES = 2`, chosen from the measurement rather than picked:

| payload | bytes | QR version | modules | px/module in the 200 px box |
|---|---|---|---|---|
| passphrase only | 61 | 4 | 33 | 5.3 |
| one candidate | 173 | 9 | 53 | 3.3 |
| two candidates | 190 | 10 | 57 | 3.1 |
| three candidates | 209 | 11 | 61 | 2.9 |

Two is the last rung before the density gets worse for a third address that mDNS already covers
whenever multicast works at all. Truncating is safe in a way that dropping an mDNS record would not
be: a candidate only ever *races* mDNS, so a dropped one costs a first pair nothing unless
multicast is also broken AND the reachable address was the one dropped.

## Both wrong numbers in this change came from guessing instead of measuring

`the_v2_payload_costs_five_qr_versions_over_v1` asserted that two candidates land on the same QR
version as one — "so a multi-homed host pays nothing extra". They do not: 190 bytes is version 10,
not 9. The number was hand-computed and the test had never been run green.

Then the cap's own assertion repeated the mistake: three candidates were assumed to stay on version
10, and they are version 11. Both figures in the table above are now transcribed from a failing
run, not derived.

The test's own doc says it is "a record, not a limit" — it exists so a later field that pushes the
QR up a version is a decision someone makes rather than a number that drifts under a QR nobody
re-measured. It did exactly that job here, against its author.

## Verified

`cargo nextest run -p agaric-sync -E 'test(pairing) or test(4037) or test(local_endpoint)'` — **38
passed**. `PairingDialog.test.tsx` — **83 passed**, covering the v2 shape, the v1 shape, a bare
non-JSON passphrase (the TS parser accepts one and does not check `v`), and `axe`.
`cargo check -p agaric-sync -p agaric-store --all-targets` — clean.
