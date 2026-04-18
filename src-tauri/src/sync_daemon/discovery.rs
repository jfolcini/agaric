use std::collections::HashMap;

use crate::peer_refs::PeerRef;
use crate::sync_net::{self, DiscoveredPeer};

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
pub fn format_peer_address(peer: &DiscoveredPeer) -> Option<String> {
    peer.addresses
        .first()
        .map(|ip| format!("{ip}:{}", peer.port))
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
/// - The event is not a ServiceResolved event
/// - The peer is the local device (self-discovery)
/// - The peer was already discovered (timestamp updated, no new sync)
/// - The peer is not in the paired peer_refs list
pub fn process_discovery_event(
    event: mdns_sd::ServiceEvent,
    device_id: &str,
    discovered: &mut HashMap<String, (DiscoveredPeer, tokio::time::Instant)>,
    peer_refs: &[PeerRef],
) -> Option<DiscoveredPeer> {
    let peer = sync_net::parse_service_event(event)?;
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
