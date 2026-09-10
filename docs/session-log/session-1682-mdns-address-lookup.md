# Session 1682 — discovery moves onto iroh's mDNS lookup

#3464, the last code item. The sync daemon discovered LAN peers with
`mdns-sd`, announcing a `_agaric._udp.local.` service whose TXT records
carried `endpoint_id` and `device_id`, and read the answers back through a
blocking bridge thread and a hand-built daemon monitor. D6 of the plan had
kept it that way until the Android multicast question was answered; the
maintainer decided on 2026-09-10 to make the swap as a PR that they verify
on two devices.

`iroh-mdns-address-lookup` 0.4 (over `swarm-discovery`) replaces it. The
lookup is added to the bound endpoint through `endpoint.address_lookup()`,
after `lan_only` has cleared the defaults, never in the builder: `lan_only`
is byte-identical and its two guard tests pass unmodified, which is the
evidence the change landed in the right layer. The instance name is the
`endpoint_id`; `device_id` travels as iroh `UserData`, and a discovered
peer without one is dropped, the way a record without `endpoint_id` was.
The service name is `agaricv1`, so a device on the previous release does
not see one on this release; that break is silent by design and belongs in
the release notes. The announce policy is the old bound-address behaviour
(IPv4 that is neither loopback nor unspecified), ported into an
`AddrFilter`; the RFC 1918 helper only ever filtered the interface
enumeration fallback, which no longer exists because iroh's direct
addresses under `lan_only` are the bound socket.

An expired peer now arrives as its `endpoint_id`, not its `device_id`, so
eviction scans the discovered map for that key; a test pins it, because
without it the swap would have quietly lost eviction. The blocking bridge,
the daemon monitor and its six tests, the `.shutdown()` call (the crate has
none; dropping the lookup after `Endpoint::close` stops the discoverer), and
the `mdns-sd` and `data-encoding` dependencies are gone. Three things are
lost and said so in the PR: the positive "announced" signal, the degraded
daemon channel, and announcing an address chosen independently of the bind.

The `MdnsDisabled` doc said a first pair required an mDNS resolve; the QR
payload has carried `endpoint_id` and address since #4037, so it now says
that.

## Verified

- `cargo nextest run --workspace -E 'test(discovery) | test(lan_only) | test(sync_daemon) | test(mdns) | test(stable_messages) | test(log_bridge)'`:
  309 passed (reviewer), 304 (builder, narrower filter).
- `two_endpoints_on_this_host_discover_each_other`, ignored in the per-PR
  lane, run with `--run-ignored=all` on this host's Wi-Fi: passed in 0.8 s,
  twice.
- `cargo clippy --workspace --all-targets -- -D warnings` exit 0;
  `cargo deny check` clean (advisory DB fetched by the reviewer).
- vitest on `useMdnsStatus` and the mock suite: 45 files, 870 passed;
  `npm run typecheck` exit 0; `bindings.ts` unchanged.
- Falsified on copies, restored `cmp`-clean: a missing `UserData` defaulted
  to the endpoint id (drop test red); eviction keyed by `device_id` (eviction
  test red); `AddrFilter::unfiltered()` (both filter tests red); `attach`
  skipping `add()` and `attach` never setting `UserData` (the two-endpoint
  test red both times).
- Not run: two devices on a LAN, Android, restrictive Wi-Fi; that is the
  maintainer's checklist in the PR.
