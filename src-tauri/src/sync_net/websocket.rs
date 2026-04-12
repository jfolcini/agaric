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
    pub fn announce(&self, device_id: &str, port: u16) -> Result<mdns_sd::ServiceInfo, AppError> {
        let host_name = format!("{device_id}.local.");
        let instance_name = format!("{MDNS_SERVICE_NAME}_{device_id}");

        let mut properties = HashMap::new();
        properties.insert("device_id".to_string(), device_id.to_string());

        let service_info = mdns_sd::ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            &instance_name,
            &host_name,
            "", // empty → the daemon will discover local IPs
            port,
            Some(properties),
        )
        .map_err(|e| sync_err(format!("service info: {e}")))?
        .enable_addr_auto();

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
                    if let Some(peer) = parse_service_event(event) {
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
#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub addresses: Vec<IpAddr>,
    pub port: u16,
}

/// Extract a [`DiscoveredPeer`] from a `ServiceEvent`, if applicable.
///
/// Only `ServiceEvent::ServiceResolved` events carry enough information;
/// all other variants return `None`.
pub fn parse_service_event(event: mdns_sd::ServiceEvent) -> Option<DiscoveredPeer> {
    match event {
        mdns_sd::ServiceEvent::ServiceResolved(info) => {
            let device_id = info.get_property_val_str("device_id")?.to_string();
            let addresses: Vec<IpAddr> = info
                .get_addresses()
                .iter()
                .map(|scoped| scoped.to_ip_addr())
                .collect();
            let port = info.get_port();
            Some(DiscoveredPeer {
                device_id,
                addresses,
                port,
            })
        }
        _ => None,
    }
}

// =========================================================================
// 3. WebSocket Server
// =========================================================================

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

        let join_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((tcp_stream, _addr)) => {
                                let acceptor = acceptor.clone();
                                let on_conn = on_connection.clone();
                                tokio::spawn(async move {
                                    let tls_stream = match acceptor.accept(tcp_stream).await {
                                        Ok(s) => s,
                                        Err(e) => {
                                            tracing::debug!("TLS handshake failed: {e}");
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
                                                tracing::debug!("WebSocket upgrade failed: {e}");
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
                            Err(_e) => {
                                // Transient accept error – keep listening.
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
