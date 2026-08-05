# #78 spike — LAN-only iroh

Time-boxed spike answering the three questions the 2026-07-12 revival comment on #78 put
before any port. **Verdict: go**, with one correction to the plan and one caveat.

Run it:

```sh
cd spikes/iroh-lan && cargo test
```

Nine tests, no network access required (see "These tests do not touch the network" in
`tests/offline_guard.rs`). This crate is deliberately **outside** the `src-tauri`
workspace so it cannot perturb the main build or the release dependency tree.

---

## Q1 — does relay-disabled + mDNS truly stay offline?

**Not as the plan specified it. The plan's config leaks.**

The #78 plan says the LAN-only target is `RelayMode::Disabled` — "no n0 relays, no
external service". iroh ships a preset with exactly that shape, `presets::N0DisableRelay`,
and its implementation is:

```rust
N0.apply(builder).relay_mode(RelayMode::Disabled)
```

`N0` installs `PkarrPublisher::n0_dns()`, `PkarrResolver::n0_dns()` and
`DnsAddressLookup::n0_dns()`. Disabling relays leaves **all three address-lookup services
running**. Measured, with `lan_only` reverted to the plan's config:

```text
LAN-only endpoint attempted 4 DNS lookup(s), so something is reaching for a name
off this machine: ["dns.iroh.link", "dns.iroh.link", "dns.iroh.link", "dns.iroh.link"]
```

So the plan's wording produces an endpoint that carries no relay traffic but still
announces this device's addresses to, and resolves them from, n0's DNS server on every
start. For a "no centralized servers" product that is the whole property, lost to a
config that reads correct.

### The config that does hold

`src/lib.rs::lan_only` — three independent layers:

1. `Endpoint::builder(presets::Minimal)` — sets *only* the mandatory crypto provider. No
   address-lookup services at all. This is the layer the plan was missing.
2. `.relay_mode(RelayMode::Disabled).clear_relay_transports()` — the latter removes the
   transport rather than just emptying the relay map.
3. `.clear_ip_transports().bind_addr_with_opts(lan, prefix_len, is_default_route(false))` —
   egress is structurally confined. iroh routes outgoing datagrams by longest-prefix match
   over bound sockets (`socket/transports/ip.rs::is_valid_send_addr`, called on the send
   path at `transports.rs:1187/1201`), falling back to the default-route socket. Bind only
   a LAN subnet and mark it not-default, and an off-subnet destination matches no socket.

Layer 3 is the one that makes this enforcement rather than intent: it does not rely on
iroh choosing not to talk to a public address, but on there being no route by which it
could. **Caveat, from iroh's own docs:** this routing table governs *new* flows. Datagrams
in response to an inbound packet go back out the socket they arrived on and do not consult
it. On a LAN-only bind that is not reachable from the internet, but it is not a firewall
and should not be described as one.

### The guard

`tests/offline_guard.rs` turns Q1 into a repeatable assertion. A `RecordingResolver` is
injected via `Builder::dns_resolver`; every path to n0 (pkarr publish, pkarr resolve, DNS
lookup, relay URL resolution) begins with a name lookup, so nothing reaches n0 without
leaving a record. It refuses every query — a guard that let the lookup succeed would be
permitting the leak it observes.

**It is not yet build-enforced, and saying so would be false.** Nothing in CI compiles
this crate: `cargo-tests`, `cargo-clippy` and `cargo-fmt` all run inside `src-tauri`, and
Dependabot's cargo ecosystem is scoped to `src-tauri/Cargo.toml`. An iroh bump that
reintroduced a leak would land with this guard green because it never ran. Closing that is
part of the port, not of the spike — the guard has to move into the real crate to become a
gate. Until then it is a thing you run, not a thing that stops you.

**What the guard cannot see.** It observes DNS, which covers every route to n0 that iroh
currently uses, since relay selection and pkarr both start from a hostname. It would not
catch a future iroh dialling a hardcoded bootstrap IP, which needs no resolution. Layer 3
is the backstop for that case, and it is why `clear_ip_transports()` in `lan_only` is
load-bearing: leave the default wildcard transports installed and every off-subnet
destination regains a default route, while all four guards stay green.

**Every guard is paired with a control, because the first draft was not.** Four assertions
passed immediately and two could not have failed:

| first draft | why it was vacuous | replaced by |
| --- | --- | --- |
| `relay_urls()` is empty | empty under full `presets::N0` too — no relay can be established while DNS is refused | "no relay hostname was ever queried" |
| publishes no public address | this host, like every NAT'd dev machine and CI runner, has no public address to publish | unit tests of the classifier against `8.8.8.8` etc. |

Both guards were then forced red to prove they fire:

```text
lan_only_endpoint_resolves_no_hostnames  ... FAILED   (4 × dns.iroh.link)
lan_only_endpoint_never_looks_for_a_relay ... FAILED  (210 relay hostname lookups in 3s)
```

The 210 figure is worth noting on its own: a relay-enabled endpoint is not quiet.

## Q2 — does QUIC/UDP survive our targets?

**Not answered. Needs hardware this spike did not have.**

The concern is real and unchanged: QUIC is UDP, and some locked-down WiFi throttles or
blocks UDP where the current TCP/WebSocket transport passes. Android Doze behaviour with a
long-lived QUIC connection is likewise untested here.

This is the remaining gate. It cannot be closed from a Linux dev box, and nothing in this
spike should be read as evidence about it. Deliberately left open rather than papered over.

## Q3 — net LOC deleted

**8,461 lines of production code in `agaric-sync` (39% of the crate's 21,532).**

| module | LOC | replaced by |
| --- | --: | --- |
| `sync_files.rs` | 1,963 | iroh-blobs |
| `sync_daemon/snapshot_transfer.rs` | 1,417 | iroh-blobs |
| `sync_daemon/wire.rs` | 1,042 | QUIC stream framing |
| `sync_cert.rs` | 972 | `EndpointId` — the key *is* the identity |
| `sync_net/connection.rs` | 854 | QUIC connections |
| `pairing.rs` | 752 | iroh tickets |
| `sync_net/websocket.rs` | 589 | QUIC streams |
| `sync_net/tls.rs` | 323 | intrinsic to QUIC |
| `sync_daemon/discovery.rs` | 300 | `iroh-mdns-address-lookup` |
| `sync_daemon/android_multicast.rs` | 249 | `iroh-mdns-address-lookup` |

Retires `tokio-tungstenite`, `tokio-rustls`, `rcgen`, `x509-parser`, `mdns-sd`, `if-addrs`,
`qrcode`.

Excludes the ~13.7K LOC of `sync_daemon/` + `sync_net/` test shims stranded in the app
crate (#3120), which this migration would also largely retire — hence the sequencing note
on that issue.

## Q4 (not asked, but decisive) — does the hardened config still work?

**Yes.** `tests/lan_connectivity.rs`: two endpoints under the *same* hardened config
complete a QUIC handshake and echo a payload both ways in 0.07s, with zero DNS queries on
either side. Asserting connectivity and silence in one test is the point — either half
alone is satisfiable by a broken configuration. Falsified via ALPN mismatch.

Address exchange is explicit, mirroring how the port would work: `clear_address_lookup()`
removes iroh's discovery, so peer addresses arrive out-of-band, which is what the existing
pairing flow already does.

---

## Findings that change the plan

1. **`RelayMode::Disabled` is not sufficient** and the plan must be corrected to specify
   `presets::Minimal` plus no address-lookup services. This is the headline finding.
2. **iroh 1.0 moved mDNS out of core** into `iroh-mdns-address-lookup`, currently **0.4.0**.
   iroh core is 1.0 with semver'd wire stability; the discovery crate we would depend on is
   pre-1.0. Not a blocker — discovery is replaceable and we already own `mdns-sd` code —
   but it is a maintenance-risk asymmetry the plan did not account for.
3. **iroh vs quinn is settled by the LOC table**, not by optionality. quinn is QUIC
   transport only: it would retire `sync_net/` and `wire.rs` (~2,800 LOC) and leave
   `sync_cert.rs`, `pairing.rs`, both discovery modules and both file-transfer modules in
   place, because QUIC streams are not content-addressed blobs and quinn has no identity or
   discovery layer. ~3× the retirement, for seven dropped deps against two.

## What this spike is not

Throwaway evidence for a go/no-go, not a port and not shipped code. The piece intended to
survive is the **shape** of `tests/offline_guard.rs`: whatever crate the transport ends up
in needs that guard and those controls, because iroh's defaults are internet-facing and
LAN-only is a posture held actively, one minor-version bump at a time.
