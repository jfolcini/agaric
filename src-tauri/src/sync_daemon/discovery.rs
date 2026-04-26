use std::collections::HashMap;

use crate::peer_refs::PeerRef;
use crate::sync_net::{self, DiscoveredPeer, ServiceEventKind};

/// Determine whether a newly discovered mDNS peer should trigger an
/// immediate sync attempt.
///
/// Returns `true` only when all of the following hold:
/// 1. The peer is not the local device (no self-sync).
/// 2. The peer was not already present in the discovered-peers map.
/// 3. The peer appears in `peer_refs` (i.e. it is already paired).
///
/// Extracted from `daemon_loop` Branch A for independent testing.
pub fn should_attempt_sync_with_discovered_peer(
    peer_device_id: &str,
    local_device_id: &str,
    already_discovered: bool,
    peer_refs: &[PeerRef],
) -> bool {
    if peer_device_id == local_device_id {
        return false;
    }
    if already_discovered {
        return false;
    }
    peer_refs.iter().any(|p| p.peer_id == peer_device_id)
}

/// Try to construct a [`DiscoveredPeer`] from a stored `last_address`.
///
/// Used when a paired peer is not currently visible via mDNS but has a
/// cached network address from a previous successful sync or manual entry.
/// Returns `None` if the address cannot be parsed as a `SocketAddr`.
///
/// Handles IPv6 link-local scope IDs (e.g. `[fe80::1%eth0]:8080`) that
/// `SocketAddr::from_str` rejects in stable Rust. The scope ID is
/// discarded — `DiscoveredPeer.addresses: Vec<IpAddr>` has no slot to
/// carry it. This is sufficient for peer address resolution today; if a
/// future caller must reconnect over a link-local address, preserve the
/// scope ID in a follow-up change.
///
/// Extracted from `daemon_loop` Branches B/C for independent testing.
pub fn build_fallback_peer(peer_id: &str, last_address: &str) -> Option<DiscoveredPeer> {
    // Fast path: addresses without IPv6 scope IDs parse directly.
    if let Ok(socket_addr) = last_address.parse::<std::net::SocketAddr>() {
        return Some(DiscoveredPeer {
            device_id: peer_id.to_string(),
            addresses: vec![socket_addr.ip()],
            port: socket_addr.port(),
        });
    }

    // Slow path: strip any IPv6 scope ID and retry. Logged at debug because
    // the standard parser also rejects plainly malformed input; we want the
    // failure visible but not noisy.
    let scrubbed = strip_ipv6_scope_id(last_address)?;
    match scrubbed.parse::<std::net::SocketAddr>() {
        Ok(socket_addr) => Some(DiscoveredPeer {
            device_id: peer_id.to_string(),
            addresses: vec![socket_addr.ip()],
            port: socket_addr.port(),
        }),
        Err(e) => {
            tracing::debug!(
                peer_id,
                error = %e,
                "build_fallback_peer: scope-stripped address still unparseable"
            );
            None
        }
    }
}

/// Strip an IPv6 zone/scope identifier from a `host:port` or `[host]:port`
/// string. Returns `None` if there is no `%` in the address (in which case
/// the caller has already tried and failed to parse via the fast path, so
/// the input is not a scope-ID issue).
///
/// Handles two shapes:
///   1. Bracketed: `[fe80::1%eth0]:8080` → `[fe80::1]:8080`
///   2. Un-bracketed: `fe80::1%eth0:8080` → `[fe80::1]:8080` (brackets
///      added so `SocketAddr::from_str` accepts the result).
fn strip_ipv6_scope_id(addr: &str) -> Option<String> {
    if !addr.contains('%') {
        return None;
    }

    if let Some(rest) = addr.strip_prefix('[') {
        // Bracketed form: split on closing bracket.
        let close = rest.find(']')?;
        let inside = &rest[..close];
        let suffix = &rest[close..]; // starts with "]"
        let ip = match inside.split_once('%') {
            Some((ip, _scope)) => ip,
            None => inside,
        };
        return Some(format!("[{ip}{suffix}"));
    }

    // Un-bracketed form: split off the scope, then split scope-tail on the
    // port separator (`:`). Everything before `%` is the IPv6 literal;
    // everything from the final `:` in the scope-tail onward is `:port`.
    let (ip, scope_and_port) = addr.split_once('%')?;
    let port_colon = scope_and_port.rfind(':')?;
    let port = &scope_and_port[port_colon..];
    Some(format!("[{ip}]{port}"))
}

/// Resolve a peer's network address: prefer mDNS-discovered address,
/// fall back to cached `last_address` from peer_refs.
pub fn resolve_peer_address(
    peer_id: &str,
    last_address: Option<&str>,
    discovered: &std::collections::HashMap<String, (DiscoveredPeer, tokio::time::Instant)>,
) -> Option<DiscoveredPeer> {
    discovered
        .get(peer_id)
        .map(|(dp, _)| dp.clone())
        .or_else(|| last_address.and_then(|addr| build_fallback_peer(peer_id, addr)))
}

/// Format a peer's first address as "ip:port" for connection.
/// Returns None if the peer has no addresses.
///
/// Prefer [`format_peer_addresses`] when callers can iterate — L-62 added
/// a multi-address try-all callsite in `try_sync_with_peer`. This
/// single-address helper is retained for callers (and tests) that
/// genuinely want only the top-priority address.
pub fn format_peer_address(peer: &DiscoveredPeer) -> Option<String> {
    format_peer_addresses(peer).into_iter().next()
}

/// L-62: format every address advertised by the peer, ordered so that
/// `try_sync_with_peer` can fail-fast from the most-likely-routable
/// candidate to the least, without ever silently giving up after the
/// first attempt.
///
/// Order policy (deterministic):
/// 1. IPv4 (most LANs route v4 reliably).
/// 2. IPv6 unicast non-link-local.
/// 3. IPv6 link-local last (no zone-id support in `IpAddr` so these
///    only work on single-interface hosts).
///
/// Within each tier the original mDNS announcement order is preserved.
/// IPv6 literals are bracketed (`[fe80::1]:8080`) so the produced
/// strings parse via `SocketAddr::from_str` and are accepted by
/// `connect_to_peer` without further wrangling.
pub fn format_peer_addresses(peer: &DiscoveredPeer) -> Vec<String> {
    let mut indexed: Vec<(usize, u8, &std::net::IpAddr)> = peer
        .addresses
        .iter()
        .enumerate()
        .map(|(i, ip)| (i, address_family_priority(ip), ip))
        .collect();
    // Stable sort on (priority, original_index) keeps within-tier order
    // identical to the announcement order — critical so a fixed-host
    // network produces the same connection sequence on every cycle.
    indexed.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    indexed
        .into_iter()
        .map(|(_, _, ip)| format_ip_with_port(ip, peer.port))
        .collect()
}

/// Format an `(ip, port)` pair into a `host:port` string suitable for
/// [`std::net::SocketAddr::from_str`]. IPv4 → `1.2.3.4:8080`; IPv6 →
/// `[2001:db8::1]:8080`.
fn format_ip_with_port(ip: &std::net::IpAddr, port: u16) -> String {
    match ip {
        std::net::IpAddr::V4(v4) => format!("{v4}:{port}"),
        std::net::IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    }
}

/// Compute the connection-order priority bucket for `ip` (lower = tried
/// earlier). See [`format_peer_addresses`] for the documented policy.
fn address_family_priority(ip: &std::net::IpAddr) -> u8 {
    match ip {
        std::net::IpAddr::V4(_) => 0,
        // IPv6 link-local addresses begin with `fe80::/10`; the first
        // 16-bit segment falls in `0xfe80..=0xfebf`. We hand-roll the
        // check so we don't depend on the unstable
        // `Ipv6Addr::is_unicast_link_local` API.
        std::net::IpAddr::V6(v6) => {
            let high = v6.segments()[0];
            if (0xfe80..=0xfebf).contains(&high) {
                2
            } else {
                1
            }
        }
    }
}

/// Look up the stored TLS certificate hash for a peer.
pub fn get_peer_cert_hash(peer_id: &str, peer_refs: &[PeerRef]) -> Option<String> {
    peer_refs
        .iter()
        .find(|p| p.peer_id == peer_id)
        .and_then(|p| p.cert_hash.clone())
}

/// Determine whether TOFU (Trust On First Use) should store a newly
/// observed certificate hash.
pub fn should_store_cert_hash(stored_hash: Option<&str>, observed_hash: Option<&str>) -> bool {
    stored_hash.is_none() && observed_hash.is_some()
}

/// Process an mDNS discovery event. Updates the `discovered` map and
/// returns the peer to sync with (if it's a new, paired peer).
///
/// Returns `None` when:
/// - The event is not a [`ServiceEventKind::Resolved`] event
///   ([`ServiceEventKind::Removed`] flows through
///   [`process_service_removed`] instead)
/// - The peer is the local device (self-discovery)
/// - The peer was already discovered (timestamp updated, no new sync)
/// - The peer is not in the paired peer_refs list
pub fn process_discovery_event(
    event: mdns_sd::ServiceEvent,
    device_id: &str,
    discovered: &mut HashMap<String, (DiscoveredPeer, tokio::time::Instant)>,
    peer_refs: &[PeerRef],
) -> Option<DiscoveredPeer> {
    match sync_net::parse_service_event(event)? {
        ServiceEventKind::Resolved(peer) => {
            if peer.device_id == device_id {
                return None; // Self-discovery
            }
            let already_discovered = discovered.contains_key(&peer.device_id);
            discovered.insert(
                peer.device_id.clone(),
                (peer.clone(), tokio::time::Instant::now()),
            );
            if already_discovered {
                return None; // Already known, just updated timestamp
            }
            if !should_attempt_sync_with_discovered_peer(
                &peer.device_id,
                device_id,
                already_discovered,
                peer_refs,
            ) {
                return None; // Not paired
            }
            Some(peer)
        }
        ServiceEventKind::Removed { device_id: removed } => {
            // L-63: drop the entry from the discovered map immediately
            // so try_sync_with_peer doesn't keep firing against a stale
            // address. Returns None because there is no peer to sync
            // with — eviction is the side effect.
            if removed != device_id {
                discovered.remove(&removed);
                tracing::debug!(peer_id = %removed, "evicted peer after mDNS ServiceRemoved");
            }
            None
        }
    }
}

/// L-63: explicit eviction helper.
///
/// Drops `removed_device_id` from the `discovered` HashMap. Returns
/// `true` if the entry was present (useful in unit tests asserting the
/// HashMap shrinks the moment mDNS announces the removal). The
/// daemon's main loop already calls into [`process_discovery_event`],
/// which forwards `Removed` events here; this helper is exported so
/// tests can drive the eviction path without constructing real
/// `mdns_sd::ServiceEvent` values.
pub fn process_service_removed(
    removed_device_id: &str,
    local_device_id: &str,
    discovered: &mut HashMap<String, (DiscoveredPeer, tokio::time::Instant)>,
) -> bool {
    if removed_device_id == local_device_id {
        // Removing our own announcement is a no-op for the discovered
        // map (the local device was never inserted).
        return false;
    }
    discovered.remove(removed_device_id).is_some()
}
