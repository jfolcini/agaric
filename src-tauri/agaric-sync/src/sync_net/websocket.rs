use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::connection::{InnerStream, SyncConnection};
use super::sync_err;
use super::tls::{SyncCert, build_server_tls_config};
use crate::sync_constants::{MAX_CONCURRENT_RESPONDER_SESSIONS, TLS_HANDSHAKE_TIMEOUT};
use agaric_core::error::AppError;

/// Maximum back-off duration for consecutive `accept()` failures.
/// Used by [`compute_accept_backoff_duration`] and the comment at the
/// call-site to keep both in sync.
const ACCEPT_BACKOFF_CAP: Duration = Duration::from_secs(30);

/// Compute the back-off duration for the *next* accept attempt after a
/// Run of consecutive `accept()` failures.
///
/// The schedule is `100ms × 2^(n-1)` capped at [`ACCEPT_BACKOFF_CAP`], where `n` is the
/// 1-based count of consecutive failures (so the first failure waits
/// 100 ms, the second 200 ms, the third 400 ms, …, until the 30 s cap
/// kicks in around the ninth failure). A `failure_count` of 0 means
/// "no recent failure" and yields a zero duration so the caller never
/// sleeps after a successful accept.
///
/// This is observability + CPU-protection for the app's own bugs (FD
/// exhaustion, sysctl limits, address-family weirdness) — never a DoS
/// guard against adversarial peers (see `AGENTS.md` threat model).
pub fn compute_accept_backoff_duration(failure_count: u32) -> Duration {
    if failure_count == 0 {
        return Duration::ZERO;
    }
    // Cap exponent at 32 to avoid overflow on a runaway counter; the
    // 30 s ceiling is the real limit anyway.
    let exponent = failure_count.saturating_sub(1).min(32);
    let factor: u64 = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
    let millis: u64 = 100u64.saturating_mul(factor);
    Duration::from_millis(millis).min(ACCEPT_BACKOFF_CAP)
}

/// A TLS-secured WebSocket server for sync connections.
pub struct SyncServer {
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    join_handle: Option<tokio::task::JoinHandle<()>>,
    #[cfg(any(test, feature = "test-util"))]
    session_limiter: Arc<Semaphore>,
}

impl SyncServer {
    /// Start listening on a random available port.
    ///
    /// For each incoming connection the server performs a TLS handshake
    /// using the certificate from `cert`, upgrades to WebSocket, and
    /// invokes `on_connection` with the resulting `SyncConnection` plus an
    /// [`OwnedSemaphorePermit`] that bounds in-flight responder sessions
    /// (#1581).
    ///
    /// ## Concurrency cap (#1581)
    ///
    /// Sessions are gated by an `Arc<Semaphore>` of
    /// [`MAX_CONCURRENT_RESPONDER_SESSIONS`] permits. A permit is acquired in
    /// the accept loop **before** the per-connection TLS handshake task is
    /// spawned; if the server is already at capacity the freshly accepted TCP
    /// stream is dropped (closed) without performing a handshake, so a peer
    /// retry-looping cannot pin an unbounded number of long-lived
    /// (`RECV_TIMEOUT` = 180 s) handshakes/tasks. The permit is then moved into
    /// the spawned task and handed to `on_connection`, which is expected to
    /// keep it alive for the whole responder session so the slot is released
    /// only on session completion.
    ///
    /// Returns the server handle together with the bound port.
    pub async fn start(
        cert: &SyncCert,
        on_connection: impl Fn(SyncConnection, OwnedSemaphorePermit) + Send + Sync + 'static,
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

        // #1581: bound the number of concurrent in-flight responder sessions.
        // A permit is acquired *before* the TLS handshake spawn below, so a
        // burst of connection attempts past the cap is rejected at the TCP
        // layer (the stream is dropped) without spending handshake CPU/FDs.
        let session_limiter = Arc::new(Semaphore::new(MAX_CONCURRENT_RESPONDER_SESSIONS));
        #[cfg(any(test, feature = "test-util"))]
        let test_session_limiter = Arc::clone(&session_limiter);

        // Track consecutive `accept()` failures so we back off
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

                                // #1581: gate at the TCP layer *before* the TLS
                                // handshake. `try_acquire_owned` never blocks
                                // the accept loop: at capacity we drop
                                // `tcp_stream` (closing the connection) and move
                                // on, so excess peers cannot force a handshake
                                // or a long-lived session task. The permit is
                                // moved into the per-connection task and then
                                // into `on_conn`, which holds it for the whole
                                // responder session — releasing the slot only on
                                // completion.
                                let Ok(permit) =
                                    Arc::clone(&session_limiter).try_acquire_owned()
                                else {
                                    tracing::warn!(
                                        cap = MAX_CONCURRENT_RESPONDER_SESSIONS,
                                        "sync_server.responder_at_capacity: rejecting \
                                         connection before TLS handshake"
                                    );
                                    // `tcp_stream` drops here → TCP close.
                                    continue;
                                };

                                let acceptor = acceptor.clone();
                                let on_conn = on_connection.clone();
                                tokio::spawn(async move {
                                    // #2027: bound the TLS handshake. Neither
                                    // `acceptor.accept` nor the WebSocket upgrade
                                    // below is covered by `RECV_TIMEOUT` (which
                                    // only applies once a `SyncConnection`
                                    // exists), so a peer that completes TCP but
                                    // stalls TLS would otherwise pin its session
                                    // permit for the OS TCP lifetime. On elapse
                                    // we return, dropping `permit` and freeing the
                                    // slot.
                                    let tls_stream = match tokio::time::timeout(
                                        TLS_HANDSHAKE_TIMEOUT,
                                        acceptor.accept(tcp_stream),
                                    )
                                    .await
                                    {
                                        Ok(Ok(s)) => s,
                                        Ok(Err(e)) => {
                                            tracing::debug!(error = %e, "TLS handshake failed");
                                            return;
                                        }
                                        Err(_elapsed) => {
                                            tracing::warn!(
                                                timeout_s = TLS_HANDSHAKE_TIMEOUT.as_secs(),
                                                "sync_server.tls_handshake_timeout: dropping \
                                                 stalled connection and releasing session permit"
                                            );
                                            // `tcp_stream` (moved into `accept`)
                                            // and `permit` drop here → slot freed.
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
                                                            // Reject an empty
                                                            // device id, e.g.
                                                            // CN `agaric-`
                                                            // (#1604).
                                                            .filter(|id| {
                                                                !id.is_empty()
                                                            })
                                                            .map(String::from)
                                                    })
                                            })
                                    };

                                    // #611: accept with the shared `ws_config()` so
                                    // the transport-level message / frame caps match
                                    // `SyncConnection::MAX_MSG_SIZE` instead of
                                    // tungstenite's 64 MiB default.
                                    // #2027: bound the WebSocket upgrade under the
                                    // same handshake budget. A peer that finishes
                                    // TLS but never sends the WS upgrade request
                                    // would otherwise hold the permit
                                    // indefinitely. On elapse we return, dropping
                                    // `permit` and freeing the slot.
                                    let ws_stream =
                                        match tokio::time::timeout(
                                            TLS_HANDSHAKE_TIMEOUT,
                                            tokio_tungstenite::accept_async_with_config(
                                                tls_stream,
                                                Some(super::connection::ws_config()),
                                            ),
                                        )
                                        .await
                                        {
                                            Ok(Ok(s)) => s,
                                            Ok(Err(e)) => {
                                                tracing::debug!(error = %e, "WebSocket upgrade failed");
                                                return;
                                            }
                                            Err(_elapsed) => {
                                                tracing::warn!(
                                                    timeout_s = TLS_HANDSHAKE_TIMEOUT.as_secs(),
                                                    "sync_server.ws_upgrade_timeout: dropping \
                                                     stalled connection and releasing session permit"
                                                );
                                                return;
                                            }
                                        };
                                    let conn = SyncConnection {
                                        inner: InnerStream::Server(ws_stream),
                                        peer_cert_hash_val: peer_cert_hash,
                                        peer_cert_cn_val: peer_cert_cn,
                                        peer_wire_compression: false,
                                    };
                                    // Hand the permit to the callback so the
                                    // session slot is held for the responder's
                                    // whole lifetime, not just the handshake
                                    // (#1581). If any `?`-early-return above
                                    // fired, `permit` drops here, freeing the
                                    // slot.
                                    on_conn(conn, permit);
                                });
                            }
                            Err(e) => {
                                // Log with backoff so a runaway
                                // accept failure (FD exhaustion, sysctl
                                // limit, address-family weirdness) does
                                // not spin a tight loop on the runtime.
                                accept_failure_count = accept_failure_count.saturating_add(1);
                                let backoff =
                                    compute_accept_backoff_duration(accept_failure_count);
                                // Backoff is capped at ACCEPT_BACKOFF_CAP (30 s),
                                // so the as_millis() conversion is always
                                // lossless; saturate to u64::MAX defensively.
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
                #[cfg(any(test, feature = "test-util"))]
                session_limiter: test_session_limiter,
            },
            port,
        ))
    }

    /// Return the production limiter so tests can synchronously await the
    /// recovery of all permits after exercising a real handshake path.
    #[cfg(any(test, feature = "test-util"))]
    #[doc(hidden)]
    pub fn responder_session_limiter_for_test(&self) -> Arc<Semaphore> {
        Arc::clone(&self.session_limiter)
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
