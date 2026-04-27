use std::sync::{Arc, OnceLock};

use sha2::{Digest, Sha256};

use super::{pem_to_der, sync_err};
use crate::error::AppError;

// =========================================================================
// 1. TLS Certificate Generation
// =========================================================================

/// A self-signed TLS certificate for sync transport.
#[derive(Debug, Clone)]
pub struct SyncCert {
    pub cert_pem: String,
    pub key_pem: String,
    /// SHA-256 of the DER-encoded certificate, hex-encoded.
    /// Used for certificate pinning in `peer_refs`.
    pub cert_hash: String,
}

/// Generate a self-signed ECDSA P-256 certificate for the given device.
///
/// * Subject: `CN=agaric-{device_id}`
/// * SAN: loopback addresses (`localhost`, `127.0.0.1`, `::1`) plus the
///   mDNS wildcard `*.local` so peers discovered via mDNS hostnames
///   parse consistently. Note: [`PinningCertVerifier`] ignores SAN entries
///   and pins only the SHA-256 hash, so these values are cosmetic — but
///   keeping them aligned with how peers are actually addressed prevents
///   drift if a stricter verifier is ever added.
/// * Validity: rcgen defaults (long-lived); override to 365 days when
///   `time` is added as a direct dependency.
pub fn generate_self_signed_cert(device_id: &str) -> Result<SyncCert, AppError> {
    use rcgen::{CertificateParams, DnType, KeyPair};

    // Generate ECDSA P-256 key pair (rcgen default).
    let key_pair =
        KeyPair::generate().map_err(|e| sync_err(format!("key generation failed: {e}")))?;

    // Build certificate parameters.
    // rcgen parses each SAN entry — IP literals become `iPAddress` SANs,
    // everything else becomes a `dNSName` SAN (including wildcards).
    let mut params = CertificateParams::new(vec![
        "localhost".to_string(),
        "*.local".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ])
    .map_err(|e| sync_err(format!("cert params: {e}")))?;

    // Override the default CN.
    params
        .distinguished_name
        .push(DnType::CommonName, format!("agaric-{device_id}"));

    // Self-sign.
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| sync_err(format!("self-sign failed: {e}")))?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    let cert_der = cert.der().to_vec();

    // SHA-256 of the DER bytes, hex-encoded.
    let hash = Sha256::digest(&cert_der);
    let cert_hash = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();

    Ok(SyncCert {
        cert_pem,
        key_pem,
        cert_hash,
    })
}

// ---------------------------------------------------------------------------
// AllowAnyCert — permissive client-certificate verifier for mTLS
// ---------------------------------------------------------------------------

/// A `ClientCertVerifier` that accepts **any** client certificate without
/// validation against a CA.  Client auth is *offered* but not *mandatory*,
/// so unauthenticated (pairing) connections still succeed.
///
/// The actual hash / CN checks are performed after the TLS handshake in the
/// responder path (`handle_incoming_sync`).
#[derive(Debug)]
pub(super) struct AllowAnyCert;

impl rustls::server::danger::ClientCertVerifier for AllowAnyCert {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        false // allow anonymous connections (pairing)
    }

    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[] // no CA hints — self-signed certs
    }

    fn verify_client_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::server::danger::ClientCertVerified, rustls::Error> {
        Ok(rustls::server::danger::ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Build a `rustls::ServerConfig` from a [`SyncCert`].
///
/// Uses a custom `AllowAnyCert` client-cert verifier so the server
/// *requests* the client's certificate (mTLS) but does not mandate it.
/// Hash / CN verification happens after the handshake in the responder path.
pub(super) fn build_server_tls_config(cert: &SyncCert) -> Result<rustls::ServerConfig, AppError> {
    let cert_der = pem_to_der(&cert.cert_pem)?;
    let key_der = pem_to_der(&cert.key_pem)?;

    let certs = vec![rustls::pki_types::CertificateDer::from(cert_der)];
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(
        key_der,
    ));

    rustls::ServerConfig::builder()
        .with_client_cert_verifier(Arc::new(AllowAnyCert))
        .with_single_cert(certs, key)
        .map_err(|e| sync_err(format!("server TLS config: {e}")))
}

// ---------------------------------------------------------------------------
// PinningCertVerifier — custom cert verifier for client connections
// ---------------------------------------------------------------------------

/// A `ServerCertVerifier` that either accepts any certificate (pairing) or
/// pins a specific SHA-256 hash (reconnection).
///
/// The observed hash is stored in `observed_hash` so the caller can retrieve
/// it after the TLS handshake.
///
/// `expected_remote_id` (M-56): when `Some(eid)`, the verifier additionally
/// requires the certificate CN to be exactly `agaric-{eid}` — i.e. the TLS
/// handshake is bound to the specific device the caller intended to reach.
/// On first-pair flows where the peer device id is not yet known, callers
/// pass `None` to preserve TOFU semantics (the existing `agaric-` prefix
/// check still applies in either case).
///
/// `observed_hash` (M-57): a single-write/single-read channel from the
/// verifier (called from inside the rustls handshake task) back to the
/// caller (which reads after the handshake completes). Implemented with
/// `OnceLock` rather than `Mutex<Option<...>>` so a panic inside the
/// verifier cannot poison the cell — `OnceLock::set` returns `Err(value)`
/// on second-call paths (verify_server_cert can be invoked once per
/// certificate in the chain; only the leaf is meaningful), which we
/// deliberately discard via `.ok()`.
#[derive(Debug)]
pub(super) struct PinningCertVerifier {
    pub(super) expected_hash: Option<String>,
    pub(super) expected_remote_id: Option<String>,
    pub(super) observed_hash: Arc<OnceLock<String>>,
}

impl rustls::client::danger::ServerCertVerifier for PinningCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        // Compute SHA-256 of the DER-encoded certificate.
        let hash = Sha256::digest(end_entity.as_ref());
        let hex_hash: String = hash.iter().map(|b| format!("{b:02x}")).collect();

        // M-57: record observed hash for the caller. `set` only succeeds
        // once; a second call on the same `OnceLock` (e.g. for an
        // intermediate cert in a chain) returns `Err(value)`, which we
        // discard — the leaf cert is the first one passed and that's the
        // one we want to pin.
        let _ = self.observed_hash.set(hex_hash.clone());

        // If we have an expected hash, enforce it.
        if let Some(ref expected) = self.expected_hash {
            if *expected != hex_hash {
                return Err(rustls::Error::General(format!(
                    "cert pin mismatch: expected {expected}, got {hex_hash}"
                )));
            }
        }

        // Verify CN matches expected device ID format (S-2: defense-in-depth).
        // M-56: when the caller knows which device they expect to reach
        // (`expected_remote_id = Some(eid)`), additionally bind the TLS
        // handshake to that identity by requiring CN == `agaric-{eid}`.
        // Without this, on first connect (no stored hash), any peer with
        // an `agaric-*` cert would pass TLS and the device-id mismatch
        // would only be caught later by the orchestrator's HeadExchange
        // path — too late if the connection already streamed bytes.
        use x509_parser::prelude::*;
        if let Ok((_, parsed)) = X509Certificate::from_der(end_entity.as_ref()) {
            let cn = parsed
                .subject()
                .iter_common_name()
                .next()
                .and_then(|attr| attr.as_str().ok());
            match cn {
                Some(name) if name.starts_with("agaric-") => {
                    if let Some(ref expected_id) = self.expected_remote_id {
                        let observed_id = &name["agaric-".len()..];
                        if observed_id != expected_id {
                            return Err(rustls::Error::General(format!(
                                "certificate CN device id mismatch: expected \
                                 agaric-{expected_id}, got agaric-{observed_id}"
                            )));
                        }
                    }
                }
                _ => {
                    return Err(rustls::Error::General(
                        "certificate CN does not match expected agaric-{device_id} format".into(),
                    ));
                }
            }
        } else {
            return Err(rustls::Error::General(
                "failed to parse certificate for CN verification".into(),
            ));
        }

        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
