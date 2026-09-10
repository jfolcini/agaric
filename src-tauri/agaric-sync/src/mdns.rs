//! LAN peer discovery over mDNS, as an iroh address lookup.
//!
//! [`transport::endpoint::lan_only`](crate::transport::endpoint::lan_only) builds from
//! `presets::Minimal` and calls `clear_address_lookup()`, so a bound endpoint has no
//! discovery at all. This module supplies the one lookup Agaric wants —
//! [`MdnsAddressLookup`](iroh_mdns_address_lookup::MdnsAddressLookup) from
//! `iroh-mdns-address-lookup`, over `swarm-discovery` — and [`attach`](crate::mdns::attach)
//! adds it to the **bound** endpoint with `endpoint.address_lookup()?.add(..)` (#3464). It
//! is not installed in the builder, and `lan_only` does not change: the
//! builder's `clear_address_lookup()` keeps meaning "nothing a preset installed", and
//! the guard tests in `transport::endpoint` keep binding endpoints that never touch the
//! network. mDNS is raw UDP multicast on 5353 and issues no `DnsResolver` query, so it
//! is invisible to those guards either way.
//!
//! # What goes on the wire
//!
//! The instance name is the endpoint's own `EndpointId` (the crate spells it in base32
//! and parses it back), so a discovered peer is dialable by construction. The Agaric
//! `device_id` — the op-log attribution key and the key `peer_refs` rows are stored
//! under — travels as iroh `UserData`; a discovery that carries none is
//! dropped, because a peer with no name cannot be listed, paired with, or unpaired
//! from. The addresses are iroh's own direct addresses, filtered by
//! [`announce_addr_filter`](crate::mdns::announce_addr_filter). With `lan_only`'s single
//! bound socket that is exactly the bound `ip:port`, which is #3853's requirement: a
//! record naming an address nothing listens on is indistinguishable, from the peer's
//! side, from a device that is asleep.
//!
//! # The wire is not a source of trust
//!
//! `UserData` is unauthenticated: anyone on the LAN can claim a victim's `device_id`
//! next to their own key. A dial to that key completes a QUIC handshake whose
//! *authenticated* identity is the claimant's, which then fails the `peer_refs` pin. So
//! this module reports what was claimed and reconciles nothing;
//! [`discovery_event_to_kind`](crate::mdns::discovery_event_to_kind) will happily yield
//! two peers claiming one `device_id` under two keys. Deciding which (if either) may be
//! synced with is the dial site's job.
//!
//! # [`MDNS_SERVICE_NAME`](crate::mdns::MDNS_SERVICE_NAME) is a wire-visible break
//!
//! The service name is the browse key. `_agaric._udp.local.` (the `mdns-sd` era) and
//! `_agaricv1._udp.local.` are different keys, so a device on either side of this
//! change does not see one on the other. There is no negotiation and no error: each
//! observes an empty network, and "the peer runs an incompatible release" is
//! indistinguishable from "the peer is off". That is deliberate — two schemas fighting
//! over one key would be worse — and it belongs in release notes, because the ALPN
//! change that also forbids a cross-release *session* reports itself and this does not.
//! The crate's default `irohv1` is not used either: it is shared with every other iroh
//! application on the link.
//!
//! # What the swap gave up (#3852)
//!
//! `mdns-sd` had a monitor channel whose `Announce` event was the one positive signal
//! that a record had been handed to a socket. `swarm-discovery` has no send-side event,
//! so that `info!("announced")` line is gone; what remains is `swarm_discovery`'s own
//! `tracing` output (the app enables it at `debug` on Android) and the negative signal
//! that mattered more, Android's `onBlockedStatusChanged` in
//! `sync_daemon::android_network_block`.

use std::borrow::Cow;
use std::net::{IpAddr, SocketAddr};

use agaric_core::error::AppError;
use iroh::address_lookup::{AddrFilter, UserData};
use iroh::{Endpoint, EndpointId, TransportAddr};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};

/// mDNS service name: `_agaricv1._udp.local.` on the wire. See the module docs for what
/// changing it breaks.
pub const MDNS_SERVICE_NAME: &str = "agaricv1";

/// Install LAN discovery on a bound endpoint: publish `device_id` as `UserData`, then
/// add the lookup. Returns the lookup so the caller can `subscribe()` to what it finds.
///
/// `UserData` is set first so the record the `add` publishes already carries the name.
///
/// # Errors
/// [`AppError::InvalidOperation`] if the platform refuses the multicast sockets (iOS, or
/// Android without the WiFi multicast lock), if `device_id` does not fit a TXT record,
/// or if the endpoint is already closed. The reason chain is flattened into the message,
/// because the crate's top-level error says only which service failed.
///
/// # Panics
/// Outside a tokio runtime: the crate spawns its actor on `Handle::current()`.
pub fn attach(endpoint: &Endpoint, device_id: &str) -> Result<MdnsAddressLookup, AppError> {
    let user_data = device_id.parse::<UserData>().map_err(|e| mdns_err(&e))?;
    endpoint.set_user_data_for_address_lookup(Some(user_data));
    let lookup = MdnsAddressLookup::builder()
        .service_name(MDNS_SERVICE_NAME)
        .addr_filter(announce_addr_filter())
        .build(endpoint.id())
        .map_err(|e| mdns_err(&e))?;
    endpoint
        .address_lookup()
        .map_err(|e| mdns_err(&e))?
        .add(lookup.clone());
    Ok(lookup)
}

fn mdns_err(error: &dyn std::error::Error) -> AppError {
    let chain: Vec<String> = std::iter::successors(Some(error), |e| e.source())
        .map(ToString::to_string)
        .collect();
    AppError::InvalidOperation(format!("[mdns] {}", chain.join(": ")))
}

/// Which of the endpoint's direct addresses go into the mDNS record.
///
/// IPv4, and neither loopback nor unspecified. Loopback is `lan_bind_target`'s "there
/// is no LAN" fallback, and announcing `127.0.0.1` to the link tells every peer to dial
/// itself — so a loopback bind announces nothing. IPv6 is dropped as it always was:
/// global unicast routes onto cellular / VPN / ISP-tunnel interfaces the user does not
/// mean to be discoverable on. Deliberately **not** an RFC 1918 filter: the bind
/// decision (`sync_daemon::lan_interface`) already chose the address and warned if it
/// is internet-facing, and the reporting LAN of #3853 is `192.160.160.0/24` — public
/// space that a private-only filter would drop, announcing nothing on exactly the
/// hardware that reported the bug.
#[must_use]
pub fn announce_addr_filter() -> AddrFilter {
    AddrFilter::new(|addrs| {
        Cow::Owned(
            addrs
                .iter()
                .filter(|addr| is_announceable(addr))
                .cloned()
                .collect(),
        )
    })
}

fn is_announceable(addr: &TransportAddr) -> bool {
    match addr {
        TransportAddr::Ip(sa) => match sa.ip() {
            IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_unspecified(),
            IpAddr::V6(_) => false,
        },
        _ => false,
    }
}

/// A peer discovered via mDNS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredPeer {
    /// The peer's Agaric device UUID, as *claimed* by its `UserData`.
    pub device_id: String,
    /// The peer's iroh identity — the ed25519 public key you dial.
    ///
    /// `Some` for every peer that came off the wire: the instance name *is* the key.
    /// `None` exists for the one other constructor,
    /// `sync_daemon::discovery::build_fallback_peer`, which synthesises a peer from
    /// `peer_refs.last_address` — a row that predates iroh and has no key to offer.
    /// Migration `0107_peer_refs_endpoint_id.sql` records why inventing one there would
    /// be worse than leaving it absent, and #3464 retires `last_address` at the
    /// cutover, which retires this `Option` with it.
    pub endpoint_id: Option<EndpointId>,
    pub addresses: Vec<IpAddr>,
    pub port: u16,
}

/// Parsed mDNS event surface.
///
/// Discovery (`Resolved`) and removal (`Removed`) used to be conflated: removals were
/// silently dropped and the daemon's `discovered` map held stale entries for up to
/// 5 min after a peer went offline. The enum lets `process_discovery_event` evict them
/// the moment mDNS announces the expiry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceEventKind {
    /// A peer was resolved — initiate (or refresh) sync.
    Resolved(DiscoveredPeer),
    /// A peer's record expired — evict it from the discovered map. An expiry names the
    /// key, not the device: the map is keyed by `device_id`, so eviction scans for the
    /// row holding this `endpoint_id`.
    Removed { endpoint_id: EndpointId },
}

/// Narrow a [`DiscoveryEvent`] to what the sync daemon acts on, if anything.
///
/// A `Discovered` peer with no `UserData`, or an empty one, returns `None`: it names
/// nothing, and the row it would produce is filtered out of `list_peer_refs`
/// (`WHERE peer_id != ''`) — present enough to authorize an inbound session, absent
/// from the device list and from unpair.
#[must_use]
pub fn discovery_event_to_kind(event: &DiscoveryEvent) -> Option<ServiceEventKind> {
    match event {
        DiscoveryEvent::Discovered { endpoint_info, .. } => {
            let device_id = match endpoint_info.user_data() {
                Some(data) if !data.as_ref().is_empty() => data.to_string(),
                _ => {
                    tracing::debug!(
                        endpoint_id = %endpoint_info.endpoint_id,
                        "mdns: ignoring a discovery with no device_id — a peer with no \
                         name cannot be listed, paired with, or unpaired from"
                    );
                    return None;
                }
            };
            // One bound socket, so every published address carries the same port.
            let port = endpoint_info.ip_addrs().next().map_or(0, SocketAddr::port);
            Some(ServiceEventKind::Resolved(DiscoveredPeer {
                device_id,
                endpoint_id: Some(endpoint_info.endpoint_id),
                addresses: endpoint_info.ip_addrs().map(SocketAddr::ip).collect(),
                port,
            }))
        }
        DiscoveryEvent::Expired { endpoint_id } => Some(ServiceEventKind::Removed {
            endpoint_id: *endpoint_id,
        }),
        _ => None,
    }
}

/// Mint a deterministic [`EndpointId`] from a label, for tests that need an
/// announcement a peer could dial without caring *which* key it is.
///
/// Deterministic rather than `SecretKey::generate()` for two reasons: tests here assert
/// on the exact 64-character spelling of a key, which a per-run value cannot be
/// compared against; and the app crate's daemon tests need the same device to announce
/// the same identity across events. Distinct labels give distinct keys.
///
/// Exposed (behind `test-util`) rather than duplicated in each test module because the
/// app crate's `sync_daemon` tests need it too and do not depend on `iroh` directly.
#[cfg(any(test, feature = "test-util"))]
#[doc(hidden)]
#[must_use]
pub fn test_endpoint_id(label: &str) -> EndpointId {
    let mut seed = [0u8; 32];
    for (slot, byte) in seed.iter_mut().zip(label.bytes()) {
        *slot = byte;
    }
    // A label shorter than the seed would otherwise let "A" and "A\0…" collide, and an
    // empty label would yield the all-zero key.
    seed[31] = u8::try_from(label.len()).unwrap_or(u8::MAX);
    iroh::SecretKey::from_bytes(&seed).public()
}

/// The `Discovered` event the lookup would emit for a peer at `addr` claiming
/// `device_id` — `None` for a peer that published no `UserData`.
#[cfg(test)]
pub(crate) fn test_discovered_event(
    endpoint_id: EndpointId,
    device_id: Option<&str>,
    addr: SocketAddr,
) -> DiscoveryEvent {
    use iroh::address_lookup::{EndpointData, EndpointInfo, UserData};

    let mut data = EndpointData::from_iter([TransportAddr::Ip(addr)]);
    data.set_user_data(device_id.map(|id| id.parse::<UserData>().expect("fits in a TXT record")));
    DiscoveryEvent::Discovered {
        endpoint_info: EndpointInfo::from_parts(endpoint_id, data),
        last_updated: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::service::SyncService;
    use iroh_dns::dns::DnsResolver;
    use n0_future::StreamExt;

    fn addr(s: &str) -> SocketAddr {
        s.parse().expect("test address parses")
    }

    fn resolved(event: &DiscoveryEvent) -> DiscoveredPeer {
        match discovery_event_to_kind(event) {
            Some(ServiceEventKind::Resolved(peer)) => peer,
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    // -- 1. The browse key ---------------------------------------------------

    /// Asserts literals, never the constant against itself: this is the value on the
    /// wire. `irohv1` is the crate default and is the browse key of every other iroh
    /// app on the link; `agaric` is the retired `mdns-sd` key, and sharing it would put
    /// two record schemas under one name. RFC 6763 §7.2 bounds the label.
    #[test]
    fn mdns_service_name_is_agaric_v1_and_a_valid_rfc6763_label() {
        assert_eq!(MDNS_SERVICE_NAME, "agaricv1");
        assert_ne!(MDNS_SERVICE_NAME, "irohv1");
        assert_ne!(MDNS_SERVICE_NAME, "agaric");
        assert!(MDNS_SERVICE_NAME.len() <= 15);
        assert!(
            MDNS_SERVICE_NAME
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "service name must only contain [a-z0-9-], got '{MDNS_SERVICE_NAME}'"
        );
    }

    // -- 2. Event narrowing --------------------------------------------------

    #[test]
    fn a_discovery_carrying_user_data_resolves_to_the_peer_that_made_it() {
        let key = test_endpoint_id("key-three");
        let peer = resolved(&test_discovered_event(
            key,
            Some("DEVICE-B"),
            addr("192.168.1.5:9443"),
        ));

        assert_eq!(peer.device_id, "DEVICE-B");
        assert_eq!(
            peer.endpoint_id,
            Some(key),
            "the key that comes back must be the key that went out"
        );
        assert_eq!(peer.addresses, vec![IpAddr::from([192, 168, 1, 5])]);
        assert_eq!(peer.port, 9443);
    }

    /// The defect the old `parse_service_event` guarded against, restated for the new
    /// carrier: a peer with no name is not a discovery. Both the absent and the empty
    /// `UserData` are refused, because the crate accepts `""` as valid user data.
    #[test]
    fn discovery_event_with_no_user_data_is_not_a_discovery() {
        let key = test_endpoint_id("empty-name");
        let sa = addr("192.168.1.5:9443");

        assert_eq!(
            discovery_event_to_kind(&test_discovered_event(key, None, sa)),
            None,
            "no UserData names no device; surfacing it would mint a peer_refs.peer_id \
             no other device agrees on"
        );
        assert_eq!(
            discovery_event_to_kind(&test_discovered_event(key, Some(""), sa)),
            None,
            "an empty device_id must be refused exactly like an absent one; it names a \
             peer no query a user can reach will ever return"
        );
        // Control: the same record with a name resolves, so the refusals above are
        // about the name and nothing else.
        assert_eq!(
            resolved(&test_discovered_event(key, Some("DEVICE-NAMED"), sa)).device_id,
            "DEVICE-NAMED"
        );
    }

    /// An expiry carries the key and nothing else, and must surface as `Removed` so the
    /// daemon evicts the row holding that key instead of waiting out the 5-minute sweep.
    #[test]
    fn an_expired_event_surfaces_as_removed_with_the_endpoint_id() {
        let key = test_endpoint_id("gone");
        assert_eq!(
            discovery_event_to_kind(&DiscoveryEvent::Expired { endpoint_id: key }),
            Some(ServiceEventKind::Removed { endpoint_id: key })
        );
    }

    // -- 3. Discovery is not a source of trust -------------------------------

    /// Two records claiming the same `device_id` under different keys must both
    /// surface, unreconciled: if this function silently preferred one it would be
    /// making a trust decision with the only unauthenticated data in the system. The
    /// pin belongs at the dial site, against the handshake-authenticated `EndpointId`.
    #[test]
    fn a_device_id_claimed_by_two_keys_yields_two_peers_not_a_verdict() {
        let honest = test_endpoint_id("honest");
        let impostor = test_endpoint_id("impostor");
        assert_ne!(honest, impostor, "the two keys must actually differ");

        let peers: Vec<DiscoveredPeer> = [honest, impostor]
            .into_iter()
            .map(|key| {
                resolved(&test_discovered_event(
                    key,
                    Some("PAIRED-PEER"),
                    addr("192.168.1.5:9443"),
                ))
            })
            .collect();

        assert_eq!(peers[0].device_id, peers[1].device_id);
        assert_eq!(peers[0].endpoint_id, Some(honest));
        assert_eq!(
            peers[1].endpoint_id,
            Some(impostor),
            "the impostor's claim must be reported as made, not filtered here; \
             discovery supplies candidates and the handshake supplies identity"
        );
    }

    // -- 4. The announce filter ----------------------------------------------

    fn apply(filter: &AddrFilter, addrs: &[&str]) -> Vec<TransportAddr> {
        let input: Vec<TransportAddr> = addrs.iter().map(|a| TransportAddr::Ip(addr(a))).collect();
        filter.apply(&input).into_owned()
    }

    /// Loopback would tell every peer to dial itself; IPv6 routes onto interfaces the
    /// user did not mean to be discoverable on; a relay is the thing `lan_only` exists
    /// to have none of.
    #[test]
    fn announce_addr_filter_drops_loopback_unspecified_ipv6_and_relay() {
        let filter = announce_addr_filter();

        assert_eq!(
            apply(
                &filter,
                &[
                    "127.0.0.1:9443",
                    "0.0.0.0:9443",
                    "[::1]:9443",
                    "[2001:db8::1]:9443"
                ]
            ),
            Vec::<TransportAddr>::new(),
            "none of these may reach the record"
        );

        let relay: TransportAddr = TransportAddr::Relay(
            "https://relay.example.com"
                .parse()
                .expect("relay url parses"),
        );
        assert_eq!(
            filter.apply(&vec![relay]).into_owned(),
            Vec::<TransportAddr>::new()
        );
    }

    /// The bound address is announced whatever class it is in. `192.160.160.80` is the
    /// reporting LAN of #3853 — public space that an RFC 1918 filter drops — and a
    /// record that omits it announces nothing on exactly the hardware that reported the
    /// bug. Two addresses in, so the test cannot pass by an all-or-nothing filter.
    #[test]
    fn announce_addr_filter_keeps_the_bound_address_the_rfc1918_filter_would_drop() {
        let kept = apply(
            &announce_addr_filter(),
            &["192.160.160.80:9443", "127.0.0.1:9443", "192.168.1.5:9443"],
        );
        assert_eq!(
            kept,
            vec![
                TransportAddr::Ip(addr("192.160.160.80:9443")),
                TransportAddr::Ip(addr("192.168.1.5:9443")),
            ]
        );
    }

    // -- 5. DiscoveredPeer ---------------------------------------------------

    #[test]
    fn discovered_peer_fields() {
        let endpoint_id = test_endpoint_id("key-five");
        let peer = DiscoveredPeer {
            device_id: "abc-123".into(),
            endpoint_id: Some(endpoint_id),
            addresses: vec![addr("192.168.1.5:0").ip()],
            port: 9876,
        };
        assert_eq!(peer.device_id, "abc-123");
        assert_eq!(peer.endpoint_id, Some(endpoint_id));
        assert_eq!(peer.addresses.len(), 1);
        assert_eq!(peer.port, 9876);
    }

    // -- 6. The wiring, on a real network ------------------------------------

    /// Two bound `lan_only` endpoints on this host, each with [`attach`]ed discovery:
    /// each must see the other through `discovery_event_to_kind` with the key, the name
    /// and the bound port.
    ///
    /// `lan_only` clears the address-lookup defaults in the builder; `attach` relies on the
    /// container surviving that clear so it can add the one lookup we want. If an iroh
    /// release dropped the container instead, `attach` would fail, `MdnsDisabled` would
    /// latch for the session, and every device would lose discovery behind a single
    /// `warn!` with CI green — this is the check that needs no multicast interface.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_bound_lan_only_endpoint_still_accepts_an_address_lookup() {
        let service = SyncService::bind(
            std::net::SocketAddr::V4(std::net::SocketAddrV4::new(
                std::net::Ipv4Addr::LOCALHOST,
                0,
            )),
            8,
            &[],
            DnsResolver::default(),
            iroh::SecretKey::generate(),
        )
        .await
        .expect("a loopback /8 sync service binds");
        assert!(
            service.endpoint().address_lookup().is_ok(),
            "clear_address_lookup() must leave an empty container, not none"
        );
        service.endpoint().close().await;
    }

    /// Ignored in the per-PR lane because it needs a multicast-capable interface with a
    /// non-loopback address: Linux `lo` carries no `MULTICAST` flag, and a loopback bind
    /// announces nothing by design (see `announce_addr_filter`). Run it by hand with
    /// `--run-ignored=all` on a machine that is on a LAN.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "needs a multicast-capable interface with a LAN address; not run in the per-PR lane"]
    async fn two_endpoints_on_this_host_discover_each_other() {
        async fn bind(device_id: &str) -> (SyncService, MdnsAddressLookup) {
            let decision = crate::sync_daemon::lan_interface::select_bind_target();
            assert!(
                decision.lan_ip.is_some(),
                "this host has no LAN address to bind; a loopback bind announces nothing"
            );
            let service = SyncService::bind(
                decision.bind,
                decision.prefix_len,
                &decision.host_addrs(),
                DnsResolver::default(),
                iroh::SecretKey::generate(),
            )
            .await
            .expect("endpoint binds");
            let lookup = attach(service.endpoint(), device_id).expect("multicast sockets open");
            (service, lookup)
        }

        let (service_a, lookup_a) = bind("DEVICE-A").await;
        let mut events_a = lookup_a.subscribe().await;
        // A is listening before B exists, so A cannot miss B's first record; B's
        // subscription is registered before A's periodic re-query can reach it.
        let (service_b, lookup_b) = bind("DEVICE-B").await;
        let mut events_b = lookup_b.subscribe().await;

        async fn wait_for(
            events: &mut (impl n0_future::Stream<Item = DiscoveryEvent> + Unpin),
            want: EndpointId,
        ) -> DiscoveredPeer {
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    let event = events.next().await.expect("stream stays open");
                    if let Some(ServiceEventKind::Resolved(peer)) = discovery_event_to_kind(&event)
                        && peer.endpoint_id == Some(want)
                    {
                        return peer;
                    }
                }
            })
            .await
            .expect("the other endpoint is discovered within the budget")
        }

        let b_seen_by_a = wait_for(&mut events_a, service_b.endpoint_id()).await;
        let a_seen_by_b = wait_for(&mut events_b, service_a.endpoint_id()).await;

        let port_of =
            |service: &SyncService| service.addr().ip_addrs().next().map_or(0, SocketAddr::port);
        assert_eq!(b_seen_by_a.device_id, "DEVICE-B");
        assert_eq!(b_seen_by_a.port, port_of(&service_b));
        assert_eq!(a_seen_by_b.device_id, "DEVICE-A");
        assert_eq!(a_seen_by_b.port, port_of(&service_a));

        service_a.close().await;
        service_b.close().await;
    }
}
