use crate::peer_refs::PeerRef;
use crate::sync_net::DiscoveredPeer;

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
/// Extracted from `daemon_loop` Branches B/C for independent testing.
pub fn build_fallback_peer(peer_id: &str, last_address: &str) -> Option<DiscoveredPeer> {
    let socket_addr: std::net::SocketAddr = last_address.parse().ok()?;
    Some(DiscoveredPeer {
        device_id: peer_id.to_string(),
        addresses: vec![socket_addr.ip()],
        port: socket_addr.port(),
    })
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
