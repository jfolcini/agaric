use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::net::TcpListener;

use super::connection::{InnerStream, SyncConnection};
use super::sync_err;
use super::tls::{build_server_tls_config, SyncCert};
use crate::error::AppError;

pub const MDNS_BROWSE_TIMEOUT: Duration = Duration::from_secs(5);

// =========================================================================
// 2. mDNS Service
// =========================================================================

/// mDNS service type for BlockNotes sync discovery.
pub const MDNS_SERVICE_TYPE: &str = "_agaric._tcp.local.";

/// mDNS service name prefix.
pub const MDNS_SERVICE_NAME: &str = "BlockNotes";

/// Handle to the running mDNS daemon.
pub struct MdnsService {
    daemon: mdns_sd::ServiceDaemon,
}

/// L-65: filter the host's interface addresses down to the set we are
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
/// Pure function over an iterator of `IpAddr` so the test in
/// `sync_net::tests` can exercise the policy without invoking the
/// host's `getifaddrs(3)`.
pub(crate) fn filter_announceable_addrs<I>(addrs: I) -> Vec<IpAddr>
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

impl MdnsService {
    /// Create a new mDNS service daemon.
    pub fn new() -> Result<Self, AppError> {
        let daemon =
            mdns_sd::ServiceDaemon::new().map_err(|e| sync_err(format!("mdns daemon: {e}")))?;
        Ok(Self { daemon })
    }

    /// Announce this device on the local network.
    ///
    /// Registers a `_agaric._tcp.local.` service with a TXT record
    /// containing `device_id=<id>`.  Returns the registered `ServiceInfo`.
    ///
    /// L-65: the announcement is restricted to RFC 1918 private IPv4
    /// interfaces (10/8, 172.16/12, 192.168/16). The previous
    /// `enable_addr_auto()` call let `mdns-sd` enumerate every routable
    /// interface, which leaked the device IP onto guest WiFi / VPN /
    /// cellular networks the user did not intend. See AGENTS.md
    /// §"Threat Model" — this is a privacy / correctness fix, not
    /// adversarial-peer hardening; the change only narrows the set of
    /// addresses advertised.
    ///
    /// Approach (b) per the L-65 task brief: the listener binds to
    /// `0.0.0.0:0` so we cannot pin the announcement to a single bound
    /// IP (approach (a)); instead we enumerate `if_addrs::get_if_addrs`
    /// and filter. If the filter yields no addresses (host has only a
    /// public IPv4, only IPv6, only a captive portal, or the syscall
    /// fails) we fall back to `enable_addr_auto()` so peer discovery
    /// still works on unusual network configurations — accept the
    /// wider announcement only when there is no narrower option.
    pub fn announce(&self, device_id: &str, port: u16) -> Result<mdns_sd::ServiceInfo, AppError> {
        let host_name = format!("{device_id}.local.");
        let instance_name = format!("{MDNS_SERVICE_NAME}_{device_id}");

        let mut properties = HashMap::new();
        properties.insert("device_id".to_string(), device_id.to_string());

        let interfaces = if_addrs::get_if_addrs().unwrap_or_else(|e| {
            tracing::warn!(
                error = %e,
                "L-65: if_addrs::get_if_addrs failed; falling back to enable_addr_auto"
            );
            Vec::new()
        });
        let announceable: Vec<IpAddr> =
            filter_announceable_addrs(interfaces.iter().map(if_addrs::Interface::ip));

        let service_info = if announceable.is_empty() {
            tracing::warn!(
                "L-65: no RFC 1918 private IPv4 interface found; \
                 falling back to enable_addr_auto for mDNS announce"
            );
            mdns_sd::ServiceInfo::new(
                MDNS_SERVICE_TYPE,
                &instance_name,
                &host_name,
                "", // empty → the daemon will discover local IPs
                port,
                Some(properties),
            )
            .map_err(|e| sync_err(format!("service info: {e}")))?
            .enable_addr_auto()
        } else {
            mdns_sd::ServiceInfo::new(
                MDNS_SERVICE_TYPE,
                &instance_name,
                &host_name,
                announceable.as_slice(),
                port,
                Some(properties),
            )
            .map_err(|e| sync_err(format!("service info: {e}")))?
        };

        self.daemon
            .register(service_info.clone())
            .map_err(|e| sync_err(format!("register: {e}")))?;

        Ok(service_info)
    }

    /// Browse for other BlockNotes devices on the network.
    ///
    /// Returns a channel receiver that yields `ServiceEvent` values.
    pub fn browse(&self) -> Result<mdns_sd::Receiver<mdns_sd::ServiceEvent>, AppError> {
        self.daemon
            .browse(MDNS_SERVICE_TYPE)
            .map_err(|e| sync_err(format!("browse: {e}")))
    }

    /// Browse for peers with a timeout, preventing indefinite blocking.
    ///
    /// Collects all `DiscoveredPeer` entries received within the timeout window.
    /// Returns an empty vec if no peers are found before the timeout expires.
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
                    // L-63: only `Resolved` events carry routable address
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
    pub fn shutdown(self) -> Result<(), AppError> {
        self.daemon
            .shutdown()
            .map_err(|e| sync_err(format!("mdns shutdown: {e}")))?;
        Ok(())
    }
}

/// A peer discovered via mDNS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub addresses: Vec<IpAddr>,
    pub port: u16,
}

/// L-63: parsed mDNS event surface.
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
/// `ServiceEvent::ServiceResolved` carries the device_id + addresses;
/// `ServiceEvent::ServiceRemoved` carries the fullname from which we
/// recover the device_id. All other variants return `None`.
pub fn parse_service_event(event: mdns_sd::ServiceEvent) -> Option<ServiceEventKind> {
    match event {
        mdns_sd::ServiceEvent::ServiceResolved(info) => {
            let device_id = info.get_property_val_str("device_id")?.to_string();
            let addresses: Vec<IpAddr> = info
                .get_addresses()
                .iter()
                .map(mdns_sd::ScopedIp::to_ip_addr)
                .collect();
            let port = info.get_port();
            Some(ServiceEventKind::Resolved(DiscoveredPeer {
                device_id,
                addresses,
                port,
            }))
        }
        mdns_sd::ServiceEvent::ServiceRemoved(_service_type, fullname) => {
            // Service fullname format is `<MDNS_SERVICE_NAME>_<device_id>.<MDNS_SERVICE_TYPE>`,
            // e.g. `BlockNotes_01ARZ3NDEKTSV4RRFFQ69G5FAV._agaric._tcp.local.` —
            // recover the device_id by stripping the announce prefix.
            let device_id = device_id_from_service_fullname(&fullname)?;
            Some(ServiceEventKind::Removed { device_id })
        }
        _ => None,
    }
}

/// L-63: recover a device_id from the mDNS service fullname produced by
/// [`MdnsService::announce`].
///
/// Returns `None` if the fullname does not match the expected
/// `<MDNS_SERVICE_NAME>_<device_id>.<...>` shape — defensive against
/// announcements from non-Agaric services that nonetheless match our
/// service type string.
pub(crate) fn device_id_from_service_fullname(fullname: &str) -> Option<String> {
    let prefix = format!("{MDNS_SERVICE_NAME}_");
    let rest = fullname.strip_prefix(&prefix)?;
    let dot = rest.find('.')?;
    let device_id = &rest[..dot];
    if device_id.is_empty() {
        return None;
    }
    Some(device_id.to_string())
}

// =========================================================================
// 3. WebSocket Server
// =========================================================================

/// Compute the back-off duration for the *next* accept attempt after a
/// run of consecutive `accept()` failures (M-53).
///
/// The schedule is `100ms × 2^(n-1)` capped at 30 s, where `n` is the
/// 1-based count of consecutive failures (so the first failure waits
/// 100 ms, the second 200 ms, the third 400 ms, …, until the 30 s cap
/// kicks in around the ninth failure). A `failure_count` of 0 means
/// "no recent failure" and yields a zero duration so the caller never
/// sleeps after a successful accept.
///
/// This is observability + CPU-protection for the app's own bugs (FD
/// exhaustion, sysctl limits, address-family weirdness) — never a DoS
/// guard against adversarial peers (see `AGENTS.md` threat model).
pub(crate) fn compute_accept_backoff_duration(failure_count: u32) -> Duration {
    if failure_count == 0 {
        return Duration::ZERO;
    }
    // Cap exponent at 32 to avoid overflow on a runaway counter; the
    // 30 s ceiling is the real limit anyway.
    let exponent = failure_count.saturating_sub(1).min(32);
    let factor: u64 = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
    let millis: u64 = 100u64.saturating_mul(factor);
    Duration::from_millis(millis).min(Duration::from_secs(30))
}

/// A TLS-secured WebSocket server for sync connections.
pub struct SyncServer {
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    join_handle: Option<tokio::task::JoinHandle<()>>,
}

impl SyncServer {
    /// Start listening on a random available port.
    ///
    /// For each incoming connection the server performs a TLS handshake
    /// using the certificate from `cert`, upgrades to WebSocket, and
    /// invokes `on_connection` with the resulting `SyncConnection`.
    ///
    /// Returns the server handle together with the bound port.
    pub async fn start(
        cert: &SyncCert,
        on_connection: impl Fn(SyncConnection) + Send + Sync + 'static,
    ) -> Result<(Self, u16), AppError> {
        let tls_config = build_server_tls_config(cert)?;
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls_config));

        let listener = TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| sync_err(format!("bind: {e}")))?;

        let port = listener
            .local_addr()
            .map_err(|e| sync_err(format!("local_addr: {e}")))?
            .port();

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let on_connection = Arc::new(on_connection);

        // M-53: track consecutive `accept()` failures so we back off
        // exponentially before retrying. Reset to 0 after every
        // successful accept so the loop never punishes a transient
        // hiccup once it's recovered.
        let mut accept_failure_count: u32 = 0;

        let join_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((tcp_stream, _addr)) => {
                                accept_failure_count = 0;
                                let acceptor = acceptor.clone();
                                let on_conn = on_connection.clone();
                                tokio::spawn(async move {
                                    let tls_stream = match acceptor.accept(tcp_stream).await {
                                        Ok(s) => s,
                                        Err(e) => {
                                            tracing::debug!(error = %e, "TLS handshake failed");
                                            return;
                                        }
                                    };

                                    // ── Extract peer certificate hash (B-33) ──
                                    let peer_cert_hash = {
                                        let (_, server_conn) = tls_stream.get_ref();
                                        server_conn
                                            .peer_certificates()
                                            .and_then(|certs| certs.first())
                                            .map(|cert| {
                                                let hash = Sha256::digest(cert.as_ref());
                                                hash.iter()
                                                    .map(|b| format!("{b:02x}"))
                                                    .collect::<String>()
                                            })
                                    };

                                    // ── Extract peer certificate CN (B-34) ──
                                    let peer_cert_cn = {
                                        let (_, server_conn) = tls_stream.get_ref();
                                        server_conn
                                            .peer_certificates()
                                            .and_then(|certs| certs.first())
                                            .and_then(|cert| {
                                                use x509_parser::prelude::*;
                                                X509Certificate::from_der(cert.as_ref())
                                                    .ok()
                                                    .and_then(|(_, parsed)| {
                                                        parsed
                                                            .subject()
                                                            .iter_common_name()
                                                            .next()
                                                            .and_then(|attr| attr.as_str().ok())
                                                            .and_then(|cn| {
                                                                cn.strip_prefix("agaric-")
                                                            })
                                                            .map(String::from)
                                                    })
                                            })
                                    };

                                    let ws_stream =
                                        match tokio_tungstenite::accept_async(tls_stream).await {
                                            Ok(s) => s,
                                            Err(e) => {
                                                tracing::debug!(error = %e, "WebSocket upgrade failed");
                                                return;
                                            }
                                        };
                                    let conn = SyncConnection {
                                        inner: InnerStream::Server(ws_stream),
                                        peer_cert_hash_val: peer_cert_hash,
                                        peer_cert_cn_val: peer_cert_cn,
                                    };
                                    on_conn(conn);
                                });
                            }
                            Err(e) => {
                                // M-53: log with backoff so a runaway
                                // accept failure (FD exhaustion, sysctl
                                // limit, address-family weirdness) does
                                // not spin a tight loop on the runtime.
                                accept_failure_count = accept_failure_count.saturating_add(1);
                                let backoff =
                                    compute_accept_backoff_duration(accept_failure_count);
                                // Backoff is capped at MAX_BACKOFF_MS (30s),
                                // so the conversion is always lossless;
                                // saturate to u64::MAX defensively.
                                let backoff_ms_u64 =
                                    u64::try_from(backoff.as_millis()).unwrap_or(u64::MAX);
                                tracing::warn!(
                                    error = %e,
                                    failure_count = accept_failure_count,
                                    backoff_ms = backoff_ms_u64,
                                    "sync_server.accept_error"
                                );
                                // Sleep is itself wrapped in select! so a
                                // shutdown signal during the back-off
                                // wakes the loop without waiting out the
                                // remainder of the back-off window.
                                tokio::select! {
                                    () = tokio::time::sleep(backoff) => {}
                                    _ = &mut shutdown_rx => break,
                                }
                            }
                        }
                    }
                    _ = &mut shutdown_rx => {
                        break;
                    }
                }
            }
        });

        Ok((
            SyncServer {
                shutdown_tx: Some(shutdown_tx),
                join_handle: Some(join_handle),
            },
            port,
        ))
    }

    /// Shut down the server gracefully.
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.await;
        }
    }
}
