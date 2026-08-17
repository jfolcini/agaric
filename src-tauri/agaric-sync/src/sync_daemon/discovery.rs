use std::collections::HashMap;

use iroh::EndpointId;

use crate::mdns::{self, DiscoveredPeer, ServiceEventKind};
use agaric_store::peer_refs::PeerRef;

/// The daemon's live view of peers seen on the network: `device_id` → the last
/// announcement and when it arrived.
///
/// Named because `daemon_loop` now *takes* this map rather than declaring it
/// (#3533) — a bare local could only ever be filled by a real mDNS resolve,
/// which left Branch B's pairing-window round unreachable from a test. The
/// `Instant` is the last-seen stamp Branch C's 5-minute eviction reads.
///
/// #4031: this is the ONLY place the tuple shape is spelled. Every function in
/// this module that takes the map takes `&DiscoveredPeers` / `&mut
/// DiscoveredPeers`; four of them still wrote the `HashMap<String, (…)>` out
/// longhand, which is four places to keep in step the day the stamp changes.
pub type DiscoveredPeers = HashMap<String, (DiscoveredPeer, tokio::time::Instant)>;

/// Determine whether a discovered mDNS peer should trigger an immediate
/// sync attempt.
///
/// The arms are ordered, and the order is the whole content of #3502:
///
/// 1. **Self** — never sync with the local device, pairing or not. Absolute.
/// 2. **`pairing_pending`** — a pairing window is *exactly* the situation in
///    which a re-discovery must re-initiate, so it overrides clause 3.
/// 3. **`already_discovered`** — steady state: don't re-fire a session on
///    every mDNS refresh of a peer we already know about.
/// 4. Otherwise: sync iff the peer appears in `peer_refs` (already paired).
///
/// The `pairing_pending` clause is the initiator-side counterpart to the
/// responder's admit-while-pending path (`sync_daemon/server.rs`, #1519):
/// during the pairing window neither device has a `peer_ref` for the other
/// yet, so without this clause no one would ever *initiate* the first sync
/// and pairing deadlocks (#2008). On a successful unpaired session the
/// initiator TOFU-binds the peer's key (`bind_endpoint_id` in
/// `try_sync_with_peer`), after which clause 4 carries it and the pending
/// marker is cleared.
///
/// # #3502 — why clause 2 sits above clause 3
///
/// The `already_discovered` guard was added later, for clause 3's legitimate
/// job, and silently took clause 2 back: below it, an unpaired peer that had
/// been resolved even once could never be re-initiated against, and a
/// first-ever pair is *always* in that configuration by the time the user
/// finishes typing the code (both dialogs arm on open, both devices dial and
/// reject each other, both land in each other's `discovered` map — and only
/// then does the passphrase arrive). The window closed with nobody dialling.
///
/// Re-firing on every refresh *during* the window is bounded by two
/// mechanisms that already exist: `try_lock_peer` prevents overlapping
/// sessions with one peer, and `may_retry`'s per-peer backoff prevents
/// hammering. The window itself is TTL-bounded
/// (`peer_refs::PENDING_PAIRING_TTL_MS`).
///
/// Extracted from `daemon_loop` Branch A for independent testing. Since
/// #3502 it is the *only* place the decision is made — [`process_discovery_event`]
/// deliberately has no short-circuit of its own, because a second copy of
/// this rule is a second place for it to be wrong (and was).
pub fn should_attempt_sync_with_discovered_peer(
    peer_device_id: &str,
    local_device_id: &str,
    already_discovered: bool,
    peer_refs: &[PeerRef],
    pairing_pending: bool,
) -> bool {
    if peer_device_id == local_device_id {
        return false;
    }
    if pairing_pending {
        return true;
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
/// This is the one constructor that yields `endpoint_id: None`, and the reason that
/// field is an `Option` at all: `last_address` is a row written by the pre-iroh
/// transport, so there is no key to carry (see migration
/// `0107_peer_refs_endpoint_id.sql` on why a synthesised one would be worse than an
/// absent one). #3464 retires `last_address`, which retires this path and the `Option`
/// together.
///
/// Extracted from `daemon_loop` Branches B/C for independent testing.
pub fn build_fallback_peer(
    peer_id: &str,
    last_address: &str,
    endpoint_id: Option<EndpointId>,
) -> Option<DiscoveredPeer> {
    // Fast path: addresses without IPv6 scope IDs parse directly.
    if let Ok(socket_addr) = last_address.parse::<std::net::SocketAddr>() {
        return Some(DiscoveredPeer {
            device_id: peer_id.to_string(),
            endpoint_id,
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
            endpoint_id,
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
    endpoint_id: Option<&str>,
    discovered: &DiscoveredPeers,
) -> Option<DiscoveredPeer> {
    discovered
        .get(peer_id)
        .map(|(dp, _)| dp.clone())
        .or_else(|| {
            // The mDNS-independent path. It needs BOTH halves under iroh, which is why
            // `endpoint_id` is threaded here rather than left to the caller: a dial names
            // a *key*, and the addresses are only candidate paths to it. A row with an
            // address and no bound key resolves a peer nothing can dial — which is worse
            // than resolving nothing, because `try_sync_with_peer` then bails before it
            // records a failure or emits an event, so the peer silently never syncs.
            //
            // This is why `peer_refs.last_address` is still written. Plan #3464 expected
            // iroh's own per-endpoint path state to replace it; that holds within one
            // process, and this fallback is for the case where it does not exist —
            // a fresh start with a peer that has not announced yet. The LAN-only endpoint
            // calls `clear_address_lookup()`, so mDNS is the only discovery there is, and
            // without a cached address a restart cannot reach a paired peer until one
            // arrives.
            let key = endpoint_id?.parse::<EndpointId>().ok()?;
            build_fallback_peer(peer_id, last_address?, Some(key))
        })
}

/// The peers Branch B (`wait_for_debounced_change`) should attempt this round.
///
/// Ordinarily this is just the paired peers whose address resolves: the
/// enumeration is `peer_refs`, because a local change is only worth pushing to
/// devices we are paired with.
///
/// While `pairing_pending` is set it additionally yields every peer in
/// `discovered` that has no `peer_ref` yet — the first-ever-pair case, where
/// `peer_refs` is **empty** and the paired-only enumeration therefore produces
/// nothing at all.
///
/// # #3502 Part 2 — why a wake is the trigger, and why not a false→true edge
///
/// Part 1 makes a *re*-discovery re-initiate during the window, but
/// [`process_discovery_event`] only runs on mDNS traffic. On a quiet network
/// (both devices announced before the user reached for the code, neither
/// re-announces after) the whole window can elapse with no event, so nothing
/// dials and the fix only works when the network happens to help. This is the
/// half that makes it deterministic.
///
/// Both pairing commands — `start_pairing_armed_inner` and
/// `confirm_pairing_inner` — end with `scheduler.notify_change()`, which is
/// precisely what Branch B is parked on, so the wake already arrives at the
/// moment the local marker is written. No new plumbing, and no second waiter
/// competing with Branch B for the same `Notify` permit.
///
/// The trigger is deliberately "the window is open at this wake", **not** the
/// `pairing_pending` false→true transition, because in the failing scenario
/// that transition never happens: the dialog arms the marker on open, so
/// `pairing_pending` is *already* true, and the user typing the code makes
/// `confirm_pairing` **overwrite** the marker's proof with a different value.
/// The bool never changes; only the content does, and the content is what the
/// wire-side gate compares. An edge-triggered design would sit out the exact
/// deadlock #3502 describes.
///
/// Re-attempting on unrelated wakes during the window is bounded by the same
/// two mechanisms as Part 1 (`try_lock_peer`, `may_retry`) plus the marker's
/// own TTL.
///
/// `discovered` never contains the local device — [`process_discovery_event`]
/// returns on self-discovery before the insert — so there is no self-dial to
/// filter here. The pairing tail is sorted by device id so a round's
/// composition does not depend on `HashMap` iteration order.
pub fn peers_for_change_round(
    peer_refs: &[PeerRef],
    discovered: &DiscoveredPeers,
    pairing_pending: bool,
) -> Vec<DiscoveredPeer> {
    let mut round: Vec<DiscoveredPeer> = peer_refs
        .iter()
        .filter_map(|peer_ref| {
            resolve_peer_address(
                &peer_ref.peer_id,
                peer_ref.last_address.as_deref(),
                peer_ref.endpoint_id.as_deref(),
                discovered,
            )
        })
        .collect();

    if pairing_pending {
        let mut unpaired: Vec<DiscoveredPeer> = discovered
            .iter()
            .filter(|(peer_id, _)| !peer_refs.iter().any(|r| r.peer_id == **peer_id))
            .map(|(_, (peer, _))| peer.clone())
            .collect();
        unpaired.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        round.extend(unpaired);
    }

    round
}

/// Format a peer's first address as "ip:port" for connection.
/// Returns None if the peer has no addresses.
///
/// Prefer [`format_peer_addresses`] when callers can iterate — added
/// a multi-address try-all callsite in `try_sync_with_peer`. This
/// single-address helper is retained for callers (and tests) that
/// genuinely want only the top-priority address.
#[allow(dead_code)] // test seam — no production callers; tests use it directly
pub fn format_peer_address(peer: &DiscoveredPeer) -> Option<String> {
    format_peer_addresses(peer).into_iter().next()
}

/// Format every address advertised by the peer, ordered so that
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
/// - [`should_attempt_sync_with_discovered_peer`] declines: a peer already in
///   the map outside a pairing window (timestamp updated, no new sync), or a
///   peer that is neither paired nor inside a pairing window
///
/// # #3502 — the map update and the decision are separate steps
///
/// The timestamp refresh happens unconditionally and *before* the decision,
/// because keeping a visible peer out of Branch C's staleness sweep is not the
/// same question as whether to dial it. This function used to fold the two
/// together with an `if already_discovered { return None }` between them,
/// which returned before the pairing bypass in
/// [`should_attempt_sync_with_discovered_peer`] was ever consulted — making
/// that bypass unreachable, and a first-ever pair undiallable, no matter what
/// the bypass said. The decision now lives in exactly one function.
pub fn process_discovery_event(
    event: mdns_sd::ServiceEvent,
    device_id: &str,
    discovered: &mut DiscoveredPeers,
    peer_refs: &[PeerRef],
    pairing_pending: bool,
) -> Option<DiscoveredPeer> {
    match mdns::parse_service_event(event)? {
        ServiceEventKind::Resolved(peer) => {
            if peer.device_id == device_id {
                return None; // Self-discovery
            }
            let already_discovered = discovered.contains_key(&peer.device_id);
            discovered.insert(
                peer.device_id.clone(),
                (peer.clone(), tokio::time::Instant::now()),
            );
            if !should_attempt_sync_with_discovered_peer(
                &peer.device_id,
                device_id,
                already_discovered,
                peer_refs,
                pairing_pending,
            ) {
                // Already known outside a pairing window, or not paired and no
                // pairing in progress. #3502: do NOT re-add a short-circuit
                // above this call — it is what made the pairing bypass dead.
                return None;
            }
            Some(peer)
        }
        ServiceEventKind::Removed { device_id: removed } => {
            // Drop the entry from the discovered map immediately
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

/// Explicit eviction helper.
///
/// Drops `removed_device_id` from the `discovered` HashMap. Returns
/// `true` if the entry was present (useful in unit tests asserting the
/// HashMap shrinks the moment mDNS announces the removal). The
/// daemon's main loop already calls into [`process_discovery_event`],
/// which forwards `Removed` events here; this helper is exported so
/// tests can drive the eviction path without constructing real
/// `mdns_sd::ServiceEvent` values.
#[allow(dead_code)] // test seam — production removal goes through process_discovery_event
pub fn process_service_removed(
    removed_device_id: &str,
    local_device_id: &str,
    discovered: &mut DiscoveredPeers,
) -> bool {
    if removed_device_id == local_device_id {
        // Removing our own announcement is a no-op for the discovered
        // map (the local device was never inserted).
        return false;
    }
    discovered.remove(removed_device_id).is_some()
}
