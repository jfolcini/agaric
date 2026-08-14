//! LAN peer discovery over mDNS — the half of the retired `sync_net` the iroh port
//! keeps.
//!
//! `sync_net::websocket` held two unrelated things in one file: a TLS/WebSocket accept
//! loop, and this — announcing the device on the local network and browsing for others.
//! The transport half was replaced by [`transport`](crate::transport) and deleted
//! (#3464); the discovery half was not replaced by anything, which is why it was lifted
//! out first (#3488) rather than going down with the module that held it.
//!
//! # Why this survives the port at all
//!
//! iroh can find peers for you, through what it calls *address lookup*: a
//! `PkarrPublisher`/`PkarrResolver` pair and a `DnsAddressLookup`, all pointed at n0's
//! infrastructure. [`transport::endpoint::lan_only`](crate::transport::endpoint::lan_only)
//! builds from `presets::Minimal`, which installs none of them, and then calls
//! `clear_address_lookup()` anyway. In iroh 1.0.3 address lookup is the *only*
//! mechanism that turns an `EndpointId` into a set of addresses (`Builder` holds one
//! `address_lookup: Vec<Box<dyn DynAddressLookupBuilder>>`; `clear_address_lookup`
//! empties it, and no other field discovers peers). iroh 1.0.3 also has no mDNS of its
//! own — `iroh-mdns-address-lookup` is a separate crate this workspace does not depend
//! on. So after the port, **this module is the only discovery Agaric has**.
//!
//! # The wire is not a source of trust
//!
//! A TXT record is unauthenticated: anyone on the LAN can advertise
//! `device_id=<victim>` next to their own `endpoint_id`. That is not new — the record
//! this replaces was equally forgeable — but under iroh the consequence changes. A
//! dial to a forged `endpoint_id` completes a QUIC handshake whose *authenticated*
//! identity is the attacker's key, which then fails the `peer_refs` pin. A spoofed
//! record costs a failed dial, not a session.
//!
//! This module therefore reports what was claimed and reconciles nothing:
//! [`parse_service_event`] will happily return two peers claiming the same `device_id`
//! under different `endpoint_id`s. Deciding which (if either) may be synced with is the
//! dial site's job, against the handshake-authenticated `EndpointId` — never against
//! the claim in the record.
//!
//! # Changing [`MDNS_SERVICE_TYPE`] is a wire-visible break
//!
//! The service type is the browse key. `_agaric._tcp.local.` and `_agaric._udp.local.`
//! are different keys, so a device running a release from either side of this change
//! **will not see** a device running the other. There is no negotiation and no error:
//! each simply observes an empty network.
//!
//! ## Does the ALPN's cross-release argument cover this?
//!
//! Plan #3464 argues that cross-release skew is already forbidden for the transport,
//! because `service::SYNC_ALPN` changes in the same port and an ALPN mismatch refuses
//! the connection. That argument makes this change **safe** but does not **cover** it,
//! and the difference is worth stating because the two are often conflated:
//!
//! * *Safe*: nothing is lost. A peer this browse key hides could not have completed a
//!   session anyway — the ALPN would have refused it. Discovery is being narrowed to a
//!   set that was already empty of usable peers.
//! * *Not covered*: the ALPN is negotiated inside the QUIC handshake, i.e. strictly
//!   **after** a dial, which is strictly after discovery. It cannot be the mechanism
//!   that produces this break, and it cannot describe the failure mode. An ALPN
//!   mismatch is loud and local — the initiator gets an error it can log against a
//!   known peer. A service-type mismatch is silent: no event fires, and "the peer is
//!   running an incompatible release" is indistinguishable from "the peer is off".
//!
//! The operational consequence: both changes must land inside the same release
//! boundary (they do — the ALPN is already `agaric/sync/0` on this branch), and this is
//! the one that needs saying out loud in release notes, because the ALPN change reports
//! itself and this one does not.
//!
//! Nothing else in the tree encodes the service type: there is no `NSBonjourServices`
//! entry (Agaric browses via `mdns-sd` in-process, not the platform resolver) and no
//! Android manifest entry beyond the multicast permissions, which are transport
//! agnostic. `docs/architecture/sync-and-network.md` § Discovery documents the value
//! and is updated with it.

use std::collections::HashMap;
use std::net::IpAddr;
use std::str::FromStr;
use std::time::Duration;

use agaric_core::error::AppError;
use iroh::EndpointId;

/// How long [`MdnsService::browse_with_timeout`] collects peers before giving up.
pub const MDNS_BROWSE_TIMEOUT: Duration = Duration::from_secs(5);

/// mDNS service type for Agaric sync discovery.
///
/// `_udp`, not `_tcp`: the service being advertised is a QUIC endpoint, and QUIC is a
/// UDP protocol. The old value named the protocol of the WebSocket listener this port
/// deletes. See the module docs for what changing it breaks.
pub const MDNS_SERVICE_TYPE: &str = "_agaric._udp.local.";

/// mDNS service name prefix.
pub const MDNS_SERVICE_NAME: &str = "Agaric";

/// TXT key carrying the peer's Agaric [`DeviceId`](crate::device) — its op-log
/// attribution key, and the key `peer_refs` rows are stored under.
const TXT_DEVICE_ID: &str = "device_id";

/// TXT key carrying the peer's iroh `EndpointId` — the only thing in the record you can
/// actually dial.
const TXT_ENDPOINT_ID: &str = "endpoint_id";

/// Map any mDNS error into an `AppError`.
///
/// Its own copy rather than a shared helper: the equivalent used to live in the
/// transport module this was lifted out of, and that module is gone. The tag is
/// `[mdns]` so a discovery failure is not read as a transport one.
fn mdns_err(msg: impl std::fmt::Display) -> AppError {
    AppError::InvalidOperation(format!("[mdns] {msg}"))
}

/// Handle to the running mDNS daemon.
pub struct MdnsService {
    daemon: mdns_sd::ServiceDaemon,
}

/// Filter the host's interface addresses down to the set we are
/// willing to advertise on mDNS. Currently this is **RFC 1918 private
/// IPv4 only** (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
///
/// `Ipv4Addr::is_private` already excludes loopback (`127.0.0.0/8`),
/// link-local (`169.254.0.0/16`), public IPv4, multicast, and the
/// unspecified address. IPv6 is dropped wholesale because the global
/// IPv6 unicast range (`2000::/3`) routes onto cellular / VPN / ISP-
/// tunnel interfaces the user does not necessarily intend to advertise
/// on, and IPv4 LAN discovery is sufficient for Agaric's deployment
/// model (single user, paired devices on a trusted home/office LAN —
/// see AGENTS.md §"Threat Model").
///
/// Pure function over an iterator of `IpAddr` so the tests below can exercise the
/// policy without invoking the host's `getifaddrs(3)`.
pub fn filter_announceable_addrs<I>(addrs: I) -> Vec<IpAddr>
where
    I: IntoIterator<Item = IpAddr>,
{
    addrs
        .into_iter()
        .filter(|addr| match addr {
            IpAddr::V4(v4) => v4.is_private(),
            IpAddr::V6(_) => false,
        })
        .collect()
}

/// The addresses to announce: the bound one if there is one, else the interface filter.
///
/// Pure so the "announced set == bound set" invariant is testable without a live mDNS
/// daemon or the host's `getifaddrs(3)`. `fallback` is lazy because enumerating
/// interfaces is a syscall the common path no longer needs.
///
/// See [`MdnsService::announce`] for why the bound address wins outright (#3853).
fn announce_set<F>(bound: Option<std::net::Ipv4Addr>, fallback: F) -> Vec<IpAddr>
where
    F: FnOnce() -> Vec<IpAddr>,
{
    match bound {
        // Loopback is the daemon's "there is no LAN" fallback. Announcing it would tell
        // every peer on the link to dial an address that is, for them, themselves.
        Some(ip) if !ip.is_loopback() && !ip.is_unspecified() => vec![IpAddr::V4(ip)],
        _ => fallback(),
    }
}

/// The host's own announceable addresses — the fallback when nothing bound.
///
/// The impure half of [`announce_set`]'s input, kept separate so the pure half stays
/// pure and so [`announce_info`] reads as one line.
fn host_announceable_addrs() -> Vec<IpAddr> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_else(|e| {
        tracing::warn!(
            error = %e,
            "if_addrs::get_if_addrs failed; falling back to enable_addr_auto"
        );
        Vec::new()
    });
    filter_announceable_addrs(interfaces.iter().map(if_addrs::Interface::ip))
}

/// The record [`MdnsService::announce`] registers, from the bound address in.
///
/// The whole address path — bound address → announce set → `ServiceInfo` — in one place
/// with no daemon behind it, so a test can assert what actually goes on the wire.
///
/// The seam is the point. With the address choice inlined in `announce`, dropping
/// `bound` on the floor (`announce_set(None, …)`) reverted the mDNS half of #3853 with
/// the entire suite still green, because nothing that a test could call took `bound` as
/// an argument. Now `the_announced_record_carries_exactly_the_bound_address` reddens.
///
/// # Errors
/// As [`build_service_info`].
fn announce_info(
    device_id: &str,
    endpoint_id: EndpointId,
    port: u16,
    bound: Option<std::net::Ipv4Addr>,
) -> Result<mdns_sd::ServiceInfo, AppError> {
    let announceable = announce_set(bound, host_announceable_addrs);
    build_service_info(device_id, endpoint_id, port, &announceable)
}

/// Build the `ServiceInfo` [`MdnsService::announce`] registers.
///
/// Split out from `announce` so the announced record — in particular the *spelling* of
/// the `endpoint_id` — is testable without a live mDNS daemon or a multicast-capable
/// CI runner.
///
/// `endpoint_id` is written with `Display`, which for `iroh::PublicKey` is
/// `HEXLOWER` over the 32 key bytes: one key, exactly one 64-character string.
/// `FromStr` is deliberately laxer (it also accepts the 52-character base32 form), so
/// the two sides only agree on one spelling if the write side always goes through
/// `Display` — the same asymmetry migration `0107_peer_refs_endpoint_id.sql` reasons
/// about for the stored column, and the reason `EndpointId::fmt_short()` (10 hex
/// characters, the convenient thing to reach for) must never end up here.
///
/// An empty `announceable` set means the host offered no RFC 1918 private IPv4
/// interface. Rather than announce nothing we fall back to `enable_addr_auto()`, which
/// lets `mdns-sd` enumerate every routable interface: the wider announcement is
/// accepted only when there is no narrower option.
fn build_service_info(
    device_id: &str,
    endpoint_id: EndpointId,
    port: u16,
    announceable: &[IpAddr],
) -> Result<mdns_sd::ServiceInfo, AppError> {
    let host_name = format!("{device_id}.local.");
    let instance_name = format!("{MDNS_SERVICE_NAME}_{device_id}");

    let mut properties = HashMap::new();
    properties.insert(TXT_DEVICE_ID.to_string(), device_id.to_string());
    properties.insert(TXT_ENDPOINT_ID.to_string(), endpoint_id.to_string());

    if announceable.is_empty() {
        tracing::warn!(
            "no RFC 1918 private IPv4 interface found; \
             falling back to enable_addr_auto for mDNS announce"
        );
        return Ok(mdns_sd::ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            &instance_name,
            &host_name,
            "", // empty → the daemon will discover local IPs
            port,
            Some(properties),
        )
        .map_err(|e| mdns_err(format!("service info: {e}")))?
        .enable_addr_auto());
    }

    mdns_sd::ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &instance_name,
        &host_name,
        announceable,
        port,
        Some(properties),
    )
    .map_err(|e| mdns_err(format!("service info: {e}")))
}

impl MdnsService {
    /// Create a new mDNS service daemon.
    ///
    /// # Errors
    /// [`AppError::InvalidOperation`] if the platform refuses the daemon's multicast
    /// sockets (iOS, or Android without the WiFi multicast lock).
    pub fn new() -> Result<Self, AppError> {
        let daemon =
            mdns_sd::ServiceDaemon::new().map_err(|e| mdns_err(format!("mdns daemon: {e}")))?;
        Ok(Self { daemon })
    }

    /// Announce this device on the local network.
    ///
    /// Registers an [`MDNS_SERVICE_TYPE`] service whose TXT record carries
    /// `device_id=<id>` **and** `endpoint_id=<key>`. Returns the registered
    /// `ServiceInfo`.
    ///
    /// # Both keys, not one
    ///
    /// `endpoint_id` is what a peer dials: mDNS supplies the rest of an iroh
    /// `EndpointAddr` already (A records give the addresses, SRV gives the port), and a
    /// `DeviceId` UUID supplies none of it — it is a name, and no address can be
    /// derived from it. `device_id` stays because it remains the op-log attribution key
    /// (#3464 D3 leaves `DeviceId` untouched) and the key `peer_refs` rows are stored
    /// under, so a discovering peer can match a hit against an existing row *before*
    /// spending a dial. Neither field can be dropped without losing one of those two
    /// jobs. Neither is trusted: see the module docs.
    ///
    /// The announcement is restricted to RFC 1918 private IPv4 interfaces (10/8,
    /// 172.16/12, 192.168/16). An earlier `enable_addr_auto()` call let `mdns-sd`
    /// enumerate every routable interface, which leaked the device IP onto guest WiFi /
    /// VPN / cellular networks the user did not intend. See AGENTS.md §"Threat Model" —
    /// this is a privacy / correctness fix, not adversarial-peer hardening; the change
    /// only narrows the set of addresses advertised. The listener binds a wildcard
    /// address, so there is no single bound IP to pin the announcement to; we enumerate
    /// `if_addrs::get_if_addrs` and filter instead.
    ///
    /// # `bound` — announce what is actually listening (#3853)
    ///
    /// The paragraph above describes the *fallback*. When the caller knows which address
    /// the sync endpoint bound, that address — and only that address — is announced.
    ///
    /// Enumerating interfaces here independently of the bind was the second half of
    /// #3853: the endpoint binds exactly one interface, so any *other* address in the
    /// record is one nothing is listening on. On the reporting desktop the two sets did
    /// not even intersect — the bind landed on the (non-RFC 1918) LAN while this filter
    /// kept only the three RFC 1918 bridge addresses. A peer cannot tell an address with
    /// no listener from a device that is asleep; it just spends its dial budget and
    /// waits out the session TTL.
    ///
    /// This narrows the announced set — one address instead of every private one — but it
    /// does **not** narrow the announced *class*, and the RFC 1918 filter (session-log
    /// L-65, session 581) was about class: it existed to stop the device advertising
    /// itself on interfaces the user did not intend to be discoverable on (public, guest
    /// WiFi, cellular, VPN). A globally-routable bound address is now announced, which
    /// L-65's filter would have dropped. That is deliberate — it is the address the user's
    /// own LAN uses on the reporting hardware — but it is a narrower set of a broader
    /// class, not a strict tightening. The address only ever leaves over multicast on the
    /// link it belongs to, and the decision to bind it at all is logged at WARN by the
    /// sync daemon's bind selection (`sync_daemon::lan_interface`).
    ///
    /// `None`, or a loopback address, means the endpoint has no LAN address at all. That
    /// falls through to the interface filter and then to `enable_addr_auto()`, because
    /// announcing `127.0.0.1` to the local link is worse than announcing nothing.
    ///
    /// # Errors
    /// [`AppError::InvalidOperation`] if `mdns-sd` rejects the service info (malformed
    /// instance or host name) or the registration.
    pub fn announce(
        &self,
        device_id: &str,
        endpoint_id: EndpointId,
        port: u16,
        bound: Option<std::net::Ipv4Addr>,
    ) -> Result<mdns_sd::ServiceInfo, AppError> {
        let service_info = announce_info(device_id, endpoint_id, port, bound)?;

        self.daemon
            .register(service_info.clone())
            .map_err(|e| mdns_err(format!("register: {e}")))?;

        Ok(service_info)
    }

    /// Browse for other Agaric devices on the network.
    ///
    /// Returns a channel receiver that yields `ServiceEvent` values.
    ///
    /// # Errors
    /// [`AppError::InvalidOperation`] if the daemon refuses the browse.
    pub fn browse(&self) -> Result<mdns_sd::Receiver<mdns_sd::ServiceEvent>, AppError> {
        self.daemon
            .browse(MDNS_SERVICE_TYPE)
            .map_err(|e| mdns_err(format!("browse: {e}")))
    }

    /// Browse for peers with a timeout, preventing indefinite blocking.
    ///
    /// Collects all `DiscoveredPeer` entries received within the timeout window.
    /// Returns an empty vec if no peers are found before the timeout expires.
    ///
    /// # Errors
    /// [`AppError::InvalidOperation`] if the daemon refuses the browse.
    pub async fn browse_with_timeout(&self) -> Result<Vec<DiscoveredPeer>, AppError> {
        let receiver = self.browse()?;
        let mut peers = Vec::new();
        let deadline = tokio::time::Instant::now() + MDNS_BROWSE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, receiver.recv_async()).await {
                Ok(Ok(event)) => {
                    // Only `Resolved` events carry routable address
                    // info; `Removed` events fire after the timeout window
                    // is over for the live peer set anyway, so the
                    // transient browse helper just drops them.
                    if let Some(ServiceEventKind::Resolved(peer)) = parse_service_event(event) {
                        peers.push(peer);
                    }
                }
                Ok(Err(_)) => break, // Channel closed
                Err(_) => break,     // Timeout expired
            }
        }
        Ok(peers)
    }

    /// Shut down the mDNS daemon, stopping all announce/browse activity.
    ///
    /// # Errors
    /// [`AppError::InvalidOperation`] if the daemon refuses to shut down.
    pub fn shutdown(self) -> Result<(), AppError> {
        self.daemon
            .shutdown()
            .map_err(|e| mdns_err(format!("mdns shutdown: {e}")))?;
        Ok(())
    }
}

/// A peer discovered via mDNS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredPeer {
    /// The peer's Agaric device UUID, as *claimed* by its TXT record.
    pub device_id: String,
    /// The peer's iroh identity — the ed25519 public key you dial.
    ///
    /// `Some` for every peer that came off the wire: [`parse_service_event`] refuses an
    /// announcement it cannot dial. `None` exists for the one other constructor,
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
/// Discovery (`Resolved`) and removal (`Removed`) used to be conflated:
/// `parse_service_event` only ever returned `Some(DiscoveredPeer)` on
/// resolve and silently dropped removals. The `discovered` HashMap in
/// the daemon then held stale entries for up to 5 min after a peer
/// went offline. The enum lets `process_discovery_event` evict those
/// entries the moment mDNS announces them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceEventKind {
    /// A peer was resolved — initiate (or refresh) sync.
    Resolved(DiscoveredPeer),
    /// A peer announced removal — evict from the discovered map. The
    /// `device_id` is recovered from the service fullname so the
    /// daemon never has to look up the resolved record again.
    Removed { device_id: String },
}

/// Extract a [`ServiceEventKind`] from a `ServiceEvent`, if applicable.
///
/// `ServiceEvent::ServiceResolved` carries the TXT record + addresses;
/// `ServiceEvent::ServiceRemoved` carries the fullname from which we
/// recover the device_id. All other variants return `None`.
///
/// # An announcement with no name is not a discovery either
///
/// A `Resolved` event whose TXT record carries an *empty* `device_id` also returns
/// `None`. The `Removed` arm has always refused that value; the `Resolved` arm used to
/// accept it, and the two disagreeing is what let an unnameable peer through. See the
/// comment at the check itself for what the resulting row does downstream.
///
/// # An announcement you cannot dial is not a discovery
///
/// A `Resolved` event whose TXT record has no `endpoint_id`, or one whose value does
/// not parse as an `EndpointId`, returns `None`. The alternative — surfacing the peer
/// with no key — would hand the daemon a name it can do nothing with: under iroh there
/// is no address to fall back on, because the addresses in the record are only usable
/// as *candidate paths* to an already-named endpoint. Rejecting here keeps "we
/// discovered a peer" and "we can attempt a session" the same statement.
///
/// The value is parsed with `FromStr`, which accepts both the 64-character hex spelling
/// this codebase writes and the 52-character base32 spelling iroh also understands.
/// That laxity is safe precisely because parsing normalises: whatever arrived, what
/// comes out is an `EndpointId`, and anything written back out (a `peer_refs` row, a
/// log line) goes through `Display` and is hex again.
pub fn parse_service_event(event: mdns_sd::ServiceEvent) -> Option<ServiceEventKind> {
    match event {
        mdns_sd::ServiceEvent::ServiceResolved(info) => {
            // `get_property_val_str` answers `Some("")` for a key that is *present and
            // empty*; only an absent key gives `None`. So `?` on its own admits
            // `device_id = ""`, which the `Removed` arm below already refuses
            // (`device_id_from_service_fullname` returns `None` for it). That asymmetry
            // is the entry point for a peer row nothing can see: `list_peer_refs`
            // filters `WHERE peer_id != ''`, so an empty id is absent from the device
            // list and from unpair, while still resolving at the responder's S-1 gate.
            // Reject it where it enters, the same way removal does.
            // `get_property_val_str` answers `Some("")` for a key that is *present and
            // empty*; only an absent key gives `None`. So `?` on its own admits
            // `device_id = ""`, which the `Removed` arm below already refuses
            // (`device_id_from_service_fullname` returns `None` for it). That asymmetry
            // is the entry point for a peer row nothing can see: `list_peer_refs`
            // filters `WHERE peer_id != ''`, so an empty id is absent from the device
            // list and from unpair, while still resolving at the responder's S-1 gate.
            // Reject it where it enters, the same way removal does.
            let device_id = info.get_property_val_str(TXT_DEVICE_ID)?;
            if device_id.is_empty() {
                tracing::debug!(
                    "mdns: ignoring announcement with an empty device_id — a peer with \
                     no name cannot be listed, paired with, or unpaired from"
                );
                return None;
            }
            let device_id = device_id.to_string();
            let Some(raw_endpoint_id) = info.get_property_val_str(TXT_ENDPOINT_ID) else {
                tracing::debug!(
                    device_id,
                    "mdns: ignoring announcement with no endpoint_id — nothing to dial"
                );
                return None;
            };
            let endpoint_id = match EndpointId::from_str(raw_endpoint_id) {
                Ok(id) => id,
                Err(e) => {
                    tracing::debug!(
                        device_id,
                        error = %e,
                        "mdns: ignoring announcement whose endpoint_id does not parse"
                    );
                    return None;
                }
            };
            let addresses: Vec<IpAddr> = info
                .get_addresses()
                .iter()
                .map(mdns_sd::ScopedIp::to_ip_addr)
                .collect();
            let port = info.get_port();
            Some(ServiceEventKind::Resolved(DiscoveredPeer {
                device_id,
                endpoint_id: Some(endpoint_id),
                addresses,
                port,
            }))
        }
        mdns_sd::ServiceEvent::ServiceRemoved(_service_type, fullname) => {
            // Service fullname format is `<MDNS_SERVICE_NAME>_<device_id>.<MDNS_SERVICE_TYPE>`,
            // e.g. `Agaric_01ARZ3NDEKTSV4RRFFQ69G5FAV._agaric._udp.local.` —
            // recover the device_id by stripping the announce prefix.
            let device_id = device_id_from_service_fullname(&fullname)?;
            Some(ServiceEventKind::Removed { device_id })
        }
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

/// Recover a device_id from the mDNS service fullname produced by
/// [`MdnsService::announce`].
///
/// Returns `None` if the fullname does not match the expected
/// `<MDNS_SERVICE_NAME>_<device_id>.<...>` shape — defensive against
/// announcements from non-Agaric services that nonetheless match our
/// service type string.
fn device_id_from_service_fullname(fullname: &str) -> Option<String> {
    let prefix = format!("{MDNS_SERVICE_NAME}_");
    let rest = fullname.strip_prefix(&prefix)?;
    let dot = rest.find('.')?;
    let device_id = &rest[..dot];
    if device_id.is_empty() {
        return None;
    }
    Some(device_id.to_string())
}

#[cfg(test)]
mod tests {
    //! Migrated from `src/sync_net/tests.rs` (app crate), which hosted them only
    //! because the module they cover could not be reached from `agaric-sync`. It can
    //! now, so they live beside the code.

    use std::collections::{BTreeSet, HashSet};

    use super::*;

    /// Wrap a `ServiceInfo` as the `ServiceResolved` event a browse would deliver.
    fn resolved(info: &mdns_sd::ServiceInfo) -> mdns_sd::ServiceEvent {
        mdns_sd::ServiceEvent::ServiceResolved(Box::new(info.clone().as_resolved_service()))
    }

    /// A `ServiceResolved` event carrying exactly the TXT keys given.
    fn resolved_with_txt(props: &[(&str, &str)]) -> mdns_sd::ServiceEvent {
        let properties: HashMap<String, String> = props
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        let info = mdns_sd::ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            "instance",
            "host.local.",
            "192.168.1.5",
            9443,
            Some(properties),
        )
        .expect("service info builds");
        resolved(&info)
    }

    // -- 1. The two constants ------------------------------------------------
    //
    // Both assert literals, never the constant itself: `assert_eq!(C, C)` restates a
    // definition and cannot fail. These are the values on the wire, so the literal is
    // the whole point.

    #[test]
    fn mdns_service_type_constant_value() {
        assert_eq!(
            MDNS_SERVICE_TYPE, "_agaric._udp.local.",
            "MDNS_SERVICE_TYPE must equal '_agaric._udp.local.' — QUIC is UDP, and the \
             service type is the browse key both ends must spell identically"
        );
    }

    /// The `_tcp` value is not merely "not current" — it is the specific wrong answer
    /// this change exists to remove, so it is named rather than left to the literal
    /// above to exclude by implication.
    #[test]
    fn mdns_service_type_is_not_the_retired_tcp_value() {
        assert_ne!(
            MDNS_SERVICE_TYPE, "_agaric._tcp.local.",
            "'_agaric._tcp.local.' advertised the WebSocket listener the iroh port \
             deletes; a QUIC endpoint must not be announced under it"
        );
    }

    #[test]
    fn mdns_service_name_constant_value() {
        assert_eq!(
            MDNS_SERVICE_NAME, "Agaric",
            "MDNS_SERVICE_NAME must equal 'Agaric'"
        );
    }

    /// Validate the mDNS service type follows RFC 6763: `_<service>._udp.local.` with
    /// a lowercase alphanumeric + hyphen service name of at most 15 characters.
    #[test]
    fn mdns_service_type_follows_rfc6763() {
        assert!(
            MDNS_SERVICE_TYPE.starts_with('_'),
            "service type must start with '_'"
        );
        assert!(
            MDNS_SERVICE_TYPE.ends_with("._udp.local."),
            "the advertised service is a QUIC endpoint, so the transport label must be \
             '_udp'; got {MDNS_SERVICE_TYPE}"
        );
        // Service name part (between the leading '_' and the transport label) must be
        // <= 15 chars and contain only [a-z0-9-].
        let service_name = MDNS_SERVICE_TYPE
            .strip_prefix('_')
            .expect("checked above")
            .strip_suffix("._udp.local.")
            .expect("checked above");
        assert!(
            service_name.len() <= 15,
            "service name '{service_name}' must be <= 15 characters (RFC 6763 §7.2)"
        );
        assert!(
            service_name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "service name must only contain [a-z0-9-], got '{service_name}'"
        );
    }

    #[test]
    fn mdns_browse_timeout_is_5_seconds() {
        assert_eq!(
            MDNS_BROWSE_TIMEOUT,
            Duration::from_secs(5),
            "mDNS browse timeout should be 5s per docs/architecture/sync-and-network.md \
             § Discovery"
        );
    }

    // -- 2. The announced record --------------------------------------------

    /// The announced TXT record must carry the `EndpointId` in `Display` form.
    ///
    /// `Display` is `HEXLOWER` (64 characters); `FromStr` also accepts a 52-character
    /// base32 form, and `fmt_short()` yields 10 characters. Only one of those three is
    /// the spelling both ends agree on and the `peer_refs.endpoint_id` CHECK accepts,
    /// so the assertion is against the exact string, its length, and its alphabet.
    #[test]
    fn announced_txt_carries_the_endpoint_id_in_display_form() {
        let endpoint_id = test_endpoint_id("key-seven");
        let info = build_service_info(
            "DEVICE-A",
            endpoint_id,
            9443,
            &["192.168.1.5".parse().expect("test address parses")],
        )
        .expect("service info builds");

        let announced = info
            .get_property_val_str(TXT_ENDPOINT_ID)
            .expect("the TXT record must carry an endpoint_id");

        assert_eq!(
            announced,
            endpoint_id.to_string(),
            "the announced endpoint_id must be exactly Display, so the reader's \
             FromStr and any stored copy agree on one spelling"
        );
        assert_eq!(
            announced.len(),
            64,
            "Display is HEXLOWER over 32 key bytes; 52 would be base32 and 10 would be \
             fmt_short, neither of which the peer_refs CHECK accepts — got {announced}"
        );
        assert!(
            announced
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
            "Display must be lowercase hex, got {announced}"
        );
    }

    /// `device_id` stays in the record alongside `endpoint_id`: it is the op-log
    /// attribution key and the `peer_refs` primary key, so a discovering peer can match
    /// a hit against a known row before spending a dial.
    #[test]
    fn announced_txt_still_carries_the_device_id() {
        let info = build_service_info(
            "DEVICE-A",
            test_endpoint_id("key-seven"),
            9443,
            &["192.168.1.5".parse().expect("test address parses")],
        )
        .expect("service info builds");

        assert_eq!(
            info.get_property_val_str(TXT_DEVICE_ID),
            Some("DEVICE-A"),
            "device_id must survive alongside endpoint_id — it is what peer_refs is \
             keyed by, and no device id can be derived from a key"
        );
    }

    /// The whole loop: what `announce` builds is what `parse_service_event` reads.
    ///
    /// Asserting the two halves separately would let them drift — an announcer writing
    /// `endpoint` and a parser reading `endpoint_id` would pass both.
    #[test]
    fn an_announced_record_parses_back_into_the_peer_that_made_it() {
        let endpoint_id = test_endpoint_id("key-three");
        let info = build_service_info(
            "DEVICE-B",
            endpoint_id,
            9443,
            &["192.168.1.5".parse().expect("test address parses")],
        )
        .expect("service info builds");

        let parsed = parse_service_event(resolved(&info)).expect("our own record must resolve");
        let ServiceEventKind::Resolved(peer) = parsed else {
            panic!("our own announcement must resolve, got {parsed:?}");
        };

        assert_eq!(peer.device_id, "DEVICE-B");
        assert_eq!(
            peer.endpoint_id,
            Some(endpoint_id),
            "the key that comes back must be the key that went out"
        );
        assert_eq!(peer.port, 9443);
    }

    // -- 3. An announcement you cannot dial is not a discovery ---------------

    /// The defect this change closes, stated as a test: a record carrying only a
    /// `device_id` names a peer without addressing it, and under iroh there is nothing
    /// to fall back on.
    #[test]
    fn an_announcement_without_an_endpoint_id_is_not_a_discovery() {
        let event = resolved_with_txt(&[("device_id", "DEVICE-C")]);
        assert!(
            parse_service_event(event).is_none(),
            "a TXT record with no endpoint_id yields a name, not an address; surfacing \
             it would hand the daemon a peer it cannot dial"
        );
    }

    /// An announcement with no *name* is not a discovery either, and the `Resolved`
    /// arm used to be the only one that thought otherwise.
    ///
    /// `get_property_val_str` returns `Some("")` for a key that is present and empty —
    /// only an absent key gives `None` — so `?` alone let `device_id = ""` through. The
    /// `Removed` arm has always refused that value (`device_id_from_service_fullname`),
    /// and the asymmetry is what made it reachable: the row it produces is filtered out
    /// of `list_peer_refs` by `WHERE peer_id != ''`, so it is absent from the device
    /// list and from unpair while still being a row.
    ///
    /// The endpoint id here is a real, parseable key, so this test cannot pass by
    /// accident through the `no endpoint_id` arm above — the *only* thing wrong with
    /// this record is the empty name. The second assertion pins that: the same record
    /// with a non-empty name must resolve.
    #[test]
    fn an_announcement_with_an_empty_device_id_is_not_a_discovery() {
        let key = test_endpoint_id("empty-name").to_string();

        let event = resolved_with_txt(&[("device_id", ""), ("endpoint_id", &key)]);
        assert!(
            parse_service_event(event).is_none(),
            "an empty device_id must be refused on Resolved exactly as it already is on \
             Removed; it names a peer no query a user can reach will ever return"
        );

        // Control: the record is otherwise well-formed, so the refusal above is about
        // the name and nothing else.
        let event = resolved_with_txt(&[("device_id", "DEVICE-NAMED"), ("endpoint_id", &key)]);
        assert!(
            parse_service_event(event).is_some(),
            "the same record with a name must still resolve, or the test above proves \
             nothing about the empty one"
        );
    }

    /// `fmt_short()` (10 hex characters) is the convenient thing to log and the most
    /// likely wrong value to end up in the record; base32 and outright garbage are the
    /// other two shapes `FromStr` must not be talked into.
    #[test]
    fn an_unparseable_endpoint_id_is_not_a_discovery() {
        for bad in [
            "",
            "not-a-key",
            // fmt_short() of test_endpoint_id("key-seven") — a real prefix of a real key.
            &test_endpoint_id("key-seven").fmt_short().to_string(),
            // 64 characters, but not hex.
            &"z".repeat(64),
        ] {
            let event = resolved_with_txt(&[("device_id", "DEVICE-C"), ("endpoint_id", bad)]);
            assert!(
                parse_service_event(event).is_none(),
                "endpoint_id {bad:?} does not parse as a key and must not surface a peer"
            );
        }
    }

    /// `FromStr` accepts iroh's 52-character base32 spelling as well as our hex one.
    /// That must keep working — parsing normalises, so a peer that spells its key the
    /// other way is still dialable and still stores back as hex.
    #[test]
    fn a_base32_endpoint_id_still_parses_to_the_same_key() {
        let endpoint_id = test_endpoint_id("key-eleven");
        let base32 = data_encoding::BASE32_NOPAD
            .encode(endpoint_id.as_bytes())
            .to_ascii_lowercase();
        assert_eq!(base32.len(), 52, "base32 of 32 bytes is 52 characters");

        let event = resolved_with_txt(&[("device_id", "DEVICE-D"), ("endpoint_id", &base32)]);
        let parsed = parse_service_event(event).expect("base32 is a spelling FromStr accepts");
        let ServiceEventKind::Resolved(peer) = parsed else {
            panic!("expected Resolved, got {parsed:?}");
        };
        assert_eq!(
            peer.endpoint_id,
            Some(endpoint_id),
            "both spellings must normalise to the same key"
        );
    }

    // -- 4. Discovery is not a source of trust -------------------------------

    /// Two records claiming the same `device_id` under different keys must both
    /// surface, unreconciled.
    ///
    /// This is the discovery-layer half of "a spoofed TXT record costs a failed dial,
    /// not a session": if `parse_service_event` silently preferred one, or dropped the
    /// second as a duplicate, it would be making a trust decision with the only
    /// unauthenticated data in the system. The pin belongs at the dial site, against
    /// the handshake-authenticated `EndpointId`.
    #[test]
    fn a_device_id_claimed_by_two_keys_yields_two_peers_not_a_verdict() {
        let honest = test_endpoint_id("honest");
        let impostor = test_endpoint_id("impostor");
        assert_ne!(honest, impostor, "the two keys must actually differ");

        let peers: Vec<DiscoveredPeer> = [honest, impostor]
            .into_iter()
            .map(|key| {
                let event = resolved_with_txt(&[
                    ("device_id", "PAIRED-PEER"),
                    ("endpoint_id", &key.to_string()),
                ]);
                match parse_service_event(event).expect("both records resolve") {
                    ServiceEventKind::Resolved(peer) => peer,
                    other => panic!("expected Resolved, got {other:?}"),
                }
            })
            .collect();

        assert_eq!(
            peers[0].device_id, peers[1].device_id,
            "both records claim the same device_id — that is the attack shape"
        );
        assert_eq!(peers[0].endpoint_id, Some(honest));
        assert_eq!(
            peers[1].endpoint_id,
            Some(impostor),
            "the impostor's claim must be reported as made, not filtered here; \
             discovery supplies candidates and the handshake supplies identity"
        );
    }

    // -- 5. Event parsing ----------------------------------------------------

    #[test]
    fn parse_service_event_returns_none_for_unhandled_kinds() {
        // ServiceFound carries (service_type, fullname) — not enough info.
        let event = mdns_sd::ServiceEvent::ServiceFound(
            "_agaric._udp.local.".into(),
            "test._agaric._udp.local.".into(),
        );
        assert!(
            parse_service_event(event).is_none(),
            "non-Resolved/non-Removed events should return None"
        );
    }

    /// `ServiceRemoved` events must surface as `ServiceEventKind::Removed { device_id }`
    /// so the daemon can evict the entry from the discovered HashMap immediately. The
    /// device_id is recovered from the service fullname produced by
    /// [`MdnsService::announce`].
    #[test]
    fn parse_service_event_returns_removed_for_service_removed() {
        let fullname = format!("{MDNS_SERVICE_NAME}_PEER42.{MDNS_SERVICE_TYPE}");
        let event = mdns_sd::ServiceEvent::ServiceRemoved(MDNS_SERVICE_TYPE.into(), fullname);
        let parsed =
            parse_service_event(event).expect("ServiceRemoved must surface a Removed kind");
        match parsed {
            ServiceEventKind::Removed { device_id } => {
                assert_eq!(
                    device_id, "PEER42",
                    "device_id must be recovered from the service fullname"
                );
            }
            other => panic!("expected ServiceEventKind::Removed, got {other:?}"),
        }
    }

    /// A `ServiceRemoved` whose fullname does not match the announce shape returns
    /// `None` so we never evict an unrelated entry.
    #[test]
    fn parse_service_event_returns_none_for_unknown_removed_fullname() {
        let event = mdns_sd::ServiceEvent::ServiceRemoved(
            MDNS_SERVICE_TYPE.into(),
            "OtherService_X.something.local.".into(),
        );
        assert!(
            parse_service_event(event).is_none(),
            "a removed event whose fullname does not match \
             <{MDNS_SERVICE_NAME}>_<id>.<...> must return None so we don't evict the \
             wrong peer"
        );
    }

    // -- 6. The interface filter --------------------------------------------
    //
    // `filter_announceable_addrs` is the pure-function core of the privacy fix: it
    // shrinks the set of addresses advertised from "every routable interface" (the old
    // `enable_addr_auto()` behaviour) down to "RFC 1918 private IPv4 only". The tests
    // seed it with a synthetic mix so the policy is exercised without invoking the
    // host's `getifaddrs(3)`.

    /// Loopback (`127.0.0.0/8`, `::1`) and link-local (`169.254.0.0/16`, `fe80::/10`)
    /// addresses must be dropped.
    #[test]
    fn filter_announceable_addrs_drops_loopback_and_link_local() {
        let inputs: Vec<IpAddr> = vec![
            "127.0.0.1".parse().unwrap(),     // IPv4 loopback
            "::1".parse().unwrap(),           // IPv6 loopback
            "169.254.10.42".parse().unwrap(), // IPv4 link-local
            "fe80::1".parse().unwrap(),       // IPv6 link-local
            "192.168.1.5".parse().unwrap(),   // RFC 1918 — should survive
        ];

        let kept = filter_announceable_addrs(inputs);
        assert_eq!(
            kept,
            vec!["192.168.1.5".parse::<IpAddr>().unwrap()],
            "only the RFC 1918 private IPv4 address should be kept; loopback and \
             link-local must not appear in the announce set"
        );
    }

    /// Public IPv4 addresses (anything outside RFC 1918) must be dropped — this is the
    /// "guest WiFi / coffee-shop network" leak the fix exists to prevent.
    #[test]
    fn filter_announceable_addrs_drops_public_ipv4() {
        let inputs: Vec<IpAddr> = vec![
            "8.8.8.8".parse().unwrap(),       // Google DNS — public
            "1.1.1.1".parse().unwrap(),       // Cloudflare — public
            "100.64.0.1".parse().unwrap(),    // CGNAT (RFC 6598, not RFC 1918)
            "10.0.0.1".parse().unwrap(),      // RFC 1918 — should survive
            "172.16.0.1".parse().unwrap(),    // RFC 1918 — should survive
            "192.168.50.50".parse().unwrap(), // RFC 1918 — should survive
        ];

        let kept: HashSet<IpAddr> = filter_announceable_addrs(inputs).into_iter().collect();
        let expected: HashSet<IpAddr> = [
            "10.0.0.1".parse::<IpAddr>().unwrap(),
            "172.16.0.1".parse::<IpAddr>().unwrap(),
            "192.168.50.50".parse::<IpAddr>().unwrap(),
        ]
        .into_iter()
        .collect();

        assert_eq!(
            kept, expected,
            "public IPv4 (incl. CGNAT) must be dropped; only RFC 1918 (10/8, \
             172.16/12, 192.168/16) addresses survive"
        );
    }

    /// IPv6 addresses are dropped wholesale — global IPv6 unicast (`2000::/3`) routes
    /// onto cellular / VPN / ISP-tunnel interfaces the user did not necessarily intend
    /// to advertise on, and IPv4 LAN discovery is sufficient for Agaric's deployment
    /// model.
    #[test]
    fn filter_announceable_addrs_drops_all_ipv6() {
        let inputs: Vec<IpAddr> = vec![
            "2001:db8::1".parse().unwrap(), // global IPv6 unicast (doc range)
            "fc00::1".parse().unwrap(),     // IPv6 unique local (ULA)
            "fe80::abcd".parse().unwrap(),  // IPv6 link-local
            "::1".parse().unwrap(),         // IPv6 loopback
        ];

        let kept = filter_announceable_addrs(inputs);
        assert!(
            kept.is_empty(),
            "IPv6 must be dropped wholesale, got: {kept:?}"
        );
    }

    /// The announce address set must be bounded — under no circumstances should the
    /// filter pass through "every interface". This is the core invariant.
    #[test]
    fn filter_announceable_addrs_set_is_bounded() {
        // A multi-homed host: docked laptop + phone hotspot + guest WiFi + VPN tunnel
        // + native IPv6. Only the LAN-style RFC 1918 addresses should survive.
        let inputs: Vec<IpAddr> = vec![
            "127.0.0.1".parse().unwrap(),    // loopback
            "::1".parse().unwrap(),          // loopback v6
            "169.254.0.7".parse().unwrap(),  // link-local v4
            "fe80::5".parse().unwrap(),      // link-local v6
            "203.0.113.42".parse().unwrap(), // public IPv4 (TEST-NET-3)
            "2001:db8::1".parse().unwrap(),  // public IPv6 (doc range)
            "192.168.1.10".parse().unwrap(), // home LAN
            "10.42.0.5".parse().unwrap(),    // tethered hotspot
            "172.20.10.3".parse().unwrap(),  // iOS Personal Hotspot range
        ];
        let total = inputs.len();

        let kept = filter_announceable_addrs(inputs);

        assert!(
            kept.len() < total,
            "filter must drop at least one address; the announce set must never be the \
             full interface list (got {} of {total} kept)",
            kept.len(),
        );
        assert!(
            !kept.is_empty(),
            "filter should still keep RFC 1918 private IPv4 addresses; got an empty result"
        );
        assert!(
            kept.iter().all(|addr| match addr {
                IpAddr::V4(v4) => v4.is_private(),
                IpAddr::V6(_) => false,
            }),
            "every surviving address must be RFC 1918 private IPv4, got: {kept:?}"
        );
    }

    // -- 6b. Announced set == bound address (#3853) ---------------------------
    //
    // The endpoint binds exactly one interface. Announcing any *other* address puts a
    // record on the link that nothing is listening on, and a peer cannot tell that from
    // a device that is asleep — it just spends its dial budget and waits out the TTL.
    // On the reporting desktop the two sets did not intersect at all.

    /// The bound address wins outright, and the interface filter is not even consulted.
    #[test]
    fn announce_set_is_exactly_the_bound_address() {
        let mut fallback_ran = false;
        let set = announce_set(Some("192.160.160.80".parse().unwrap()), || {
            fallback_ran = true;
            vec!["192.168.32.1".parse().unwrap(), "10.0.6.1".parse().unwrap()]
        });

        assert_eq!(
            set,
            vec!["192.160.160.80".parse::<IpAddr>().unwrap()],
            "the announced set must be exactly the address the endpoint bound — not the \
             RFC 1918 bridges the old filter would have kept"
        );
        assert!(
            !fallback_ran,
            "with a known bind address the interface enumeration must not run at all"
        );
    }

    /// A non-RFC1918 bind address is announced. Routing it through the old filter would
    /// have dropped it and reproduced #3853 exactly.
    #[test]
    fn announce_set_keeps_a_bound_address_the_rfc1918_filter_would_drop() {
        let bound: std::net::Ipv4Addr = "192.160.160.102".parse().unwrap();
        assert!(
            filter_announceable_addrs([IpAddr::V4(bound)]).is_empty(),
            "precondition: this address is exactly what the RFC 1918 filter drops"
        );
        assert_eq!(
            announce_set(Some(bound), Vec::new),
            vec![IpAddr::V4(bound)],
            "…and it must be announced anyway, because it is what we bound"
        );
    }

    /// Loopback is the daemon's "there is no LAN" fallback. Announcing `127.0.0.1` to
    /// the local link tells every peer to dial itself, so it must fall through instead.
    #[test]
    fn announce_set_never_advertises_the_loopback_fallback() {
        let set = announce_set(Some("127.0.0.1".parse().unwrap()), || {
            vec!["192.168.1.5".parse().unwrap()]
        });
        assert_eq!(
            set,
            vec!["192.168.1.5".parse::<IpAddr>().unwrap()],
            "a loopback bind must fall through to the interface filter, not be announced"
        );

        assert!(
            announce_set(Some("127.0.0.1".parse().unwrap()), Vec::new).is_empty(),
            "and with nothing to fall back to it yields the empty set, which \
             build_service_info turns into enable_addr_auto"
        );
    }

    /// No bind address at all keeps the pre-existing behaviour verbatim.
    #[test]
    fn announce_set_without_a_bind_address_uses_the_interface_filter() {
        let set = announce_set(None, || vec!["192.168.1.5".parse().unwrap()]);
        assert_eq!(set, vec!["192.168.1.5".parse::<IpAddr>().unwrap()]);
    }

    /// The record that actually goes on the wire carries the bound address and nothing
    /// else — the assertion the four `announce_set` tests above cannot make.
    ///
    /// They pin the *helper*; this pins that `announce_info` (and therefore `announce`)
    /// passes `bound` to it. Reverting that call to `announce_set(None, …)` — the exact
    /// mutation that left the whole 272-test suite green before this test existed —
    /// reddens here: the fallback yields this host's RFC 1918 interface addresses, or an
    /// empty set on a host that has none, and neither is `[192.160.160.80]`.
    ///
    /// Deliberately a non-RFC 1918 address, so the fallback path cannot accidentally
    /// produce it on any host: `filter_announceable_addrs` drops that whole class.
    ///
    /// Compared as a **set**. `ServiceInfo::get_addresses` returns a `HashSet`, whose
    /// iteration order is not stable across runs — two different orderings were observed
    /// from the same binary — so a `Vec` equality here was safe only because the expected
    /// set happens to have one element, and would have become a coin flip the moment a
    /// second address was announced.
    #[test]
    fn the_announced_record_carries_exactly_the_bound_address() {
        let bound: std::net::Ipv4Addr = "192.160.160.80".parse().expect("test address parses");
        let info = announce_info("DEVICE-F", test_endpoint_id("key-bound"), 9443, Some(bound))
            .expect("service info builds");

        let announced: BTreeSet<IpAddr> = info.get_addresses().iter().copied().collect();

        assert_eq!(
            announced,
            BTreeSet::from([IpAddr::V4(bound)]),
            "the record must name the address the endpoint bound and no other; anything \
             else is an address with no listener behind it, which a peer cannot tell \
             from a sleeping device"
        );
    }

    /// The other arm: with no bound address the record falls back to the interface
    /// filter, which is the pre-#3853 behaviour and must survive.
    ///
    /// Asserted as an equality against [`host_announceable_addrs`] — the fallback's own
    /// source — rather than by looping over the announced set. The loop this replaces had
    /// no non-emptiness precondition, so on a host holding no RFC 1918 address it ran
    /// zero times and asserted nothing; that host is not hypothetical, it is the device
    /// this whole issue was reported from (`192.160.160.0/24` is not RFC 1918). The
    /// equality is still true on such a host, but unlike the loop it *says* something:
    /// it reddens if the fallback is rewired to the raw interface list, which on the
    /// reporting hardware also carries `192.160.160.80`.
    ///
    /// Set equality, for the same `HashSet` ordering reason as the test above.
    #[test]
    fn the_announced_record_without_a_bind_falls_back_to_the_interface_filter() {
        let info = announce_info("DEVICE-G", test_endpoint_id("key-unbound"), 9443, None)
            .expect("service info builds");

        let announced: BTreeSet<IpAddr> = info.get_addresses().iter().copied().collect();
        let expected: BTreeSet<IpAddr> = host_announceable_addrs().into_iter().collect();
        assert_eq!(
            announced, expected,
            "with no bound address the record must carry exactly what the interface \
             filter yields — no more (an unfiltered interface list) and no less"
        );
        for &ip in &announced {
            assert_eq!(
                filter_announceable_addrs([ip]),
                vec![ip],
                "the fallback must announce only what the RFC 1918 filter accepts, got \
                 {ip}"
            );
        }
    }

    /// An empty interface list yields an empty announce set — [`build_service_info`]
    /// treats this as the trigger to fall back to `enable_addr_auto()` so peer
    /// discovery still works on hosts where `getifaddrs(3)` fails or returns nothing
    /// useful.
    #[test]
    fn filter_announceable_addrs_empty_input_yields_empty_output() {
        let kept = filter_announceable_addrs(Vec::<IpAddr>::new());
        assert!(
            kept.is_empty(),
            "empty input must yield empty output (caller falls back to enable_addr_auto)"
        );
    }

    /// The empty-address fallback must still announce a dialable identity. It is the
    /// degraded path, and a degraded path that silently drops the key would produce
    /// records every peer is now obliged to ignore.
    #[test]
    fn the_empty_address_fallback_still_announces_the_endpoint_id() {
        let endpoint_id = test_endpoint_id("key-nine");
        let info =
            build_service_info("DEVICE-E", endpoint_id, 9443, &[]).expect("fallback info builds");

        assert_eq!(
            info.get_property_val_str(TXT_ENDPOINT_ID),
            Some(endpoint_id.to_string().as_str()),
            "the enable_addr_auto fallback must carry the same TXT record as the \
             narrow path"
        );
    }

    // -- 7. DiscoveredPeer ---------------------------------------------------

    #[test]
    fn discovered_peer_fields() {
        let endpoint_id = test_endpoint_id("key-five");
        let peer = DiscoveredPeer {
            device_id: "abc-123".into(),
            endpoint_id: Some(endpoint_id),
            addresses: vec!["192.168.1.5".parse().unwrap()],
            port: 9876,
        };
        assert_eq!(
            peer.device_id, "abc-123",
            "device_id should match constructed value"
        );
        assert_eq!(
            peer.endpoint_id,
            Some(endpoint_id),
            "endpoint_id should match constructed value"
        );
        assert_eq!(peer.addresses.len(), 1, "should contain one address");
        assert_eq!(peer.port, 9876, "port should match constructed value");
    }
}
