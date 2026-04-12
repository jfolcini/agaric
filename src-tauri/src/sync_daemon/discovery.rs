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
