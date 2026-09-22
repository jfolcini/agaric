# Session 1796 — the opt-in internet fallback for sync (#4549)

The reported case is a daily one: a phone on an enterprise VPN whose tunnel
captured the home LAN's unicast but not its multicast, so the desktop kept
appearing in the device list and every dial died. #4299 taught the app to name
that case; this session gives it a remedy, at the scope the maintainer narrowed
the issue to on 2026-09-02: one off-by-default `app_settings` row
(`sync.internet_relay`), one control in Sync & Devices, one pinned relay on both
devices, effect at the next launch, and the two doc corrections.

## What shipped

`lan_only_with_host_addrs` and a new `lan_with_relay_with_host_addrs` share one
private `confined_builder`; the only knob is the `RelayMode`. Layers 2 and 3
(no address lookup, egress confined to the bound subnet) are shared by
construction. The relay is `RelayMode::Custom` over a one-entry map, n0's NA-east
relay, because with address lookup cleared nothing tells a dialer which relay its
peer is on — a single URL makes both ends share a home relay, and the dial site
adds that URL to every `EndpointAddr`, which is what iroh's `connect` contract
requires once the direct addresses are unreachable. `SyncService::bind` takes it
as an `Option<RelayUrl>`, `SyncDaemonContext` carries the bool, and `lib.rs`
reads the row once when the daemon is spawned.

`bring_up_endpoint` used to take seven positional arguments and forward six of
them; it now takes `&SyncDaemonContext`, which is how the eighth value arrived
without a `too_many_arguments` suppression.

The module doc's claim that `clear_relay_transports()` is "strictly stronger
than `RelayMode::Disabled`" was wrong for the pinned iroh 1.1.0 (both
`retain`-remove the relay transport, and `presets::Minimal` seeds none to
remove) and is corrected in place. The issue body said the same of 1.0.3.

Frontend: `InternetRelaySetting` (a `ToggleRow`) mounted in `DeviceManagement`
above the pair button, mirroring `NotificationsTab`'s load/save/rollback shape.
The mock, the conformance fixtures (`query_sync_relay_settings`, seeded on;
`sync_relay_settings_writes`, switched off and re-read) and the TS/Rust
conformance twins follow the reminders precedent exactly.

`SECURITY.md` and `docs/features/sync.md` now say "no cloud by default" and
describe what the relay can and cannot see. The remaining five doc edits the
issue listed were dropped by the maintainer's scoping comment and stay dropped.

## Verified

- New guard `relay_endpoint_resolves_only_the_pinned_relay`: the relay
  hostname appears in the recorder and, across a keyed-only dial, nothing else
  does. The dial is load-bearing: n0's resolvers query on `connect`, not at
  bind, so the first draft (bind, settle, read) stayed green under every mutant.
  Falsified by swapping `presets::Minimal` for `presets::N0` **and** dropping
  `clear_address_lookup()` together (31–35 `dns.iroh.link` lookups appear).
  Either alone leaves it green — `Minimal` installs no lookup service, the
  clear removes `N0`'s — so the issue's acceptance criterion 2 ("forced red by
  deleting that call") was not achievable as written, and the test's header
  says so.
- The two `lan_only` guards are unmodified and green: the negative control.
- `relay_settings_tests`: no row reads off, a write round-trips, off stores
  `'0'` and keeps one row.
- Not verified here, and said plainly: a sync actually carried over the relay
  (acceptance criteria 3, 5, 6, 7, 8 need two devices and a blackholed LAN).
