use std::sync::Arc;

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
/// * SAN: `localhost`, `127.0.0.1`
/// * Validity: rcgen defaults (long-lived); override to 365 days when
///   `time` is added as a direct dependency.
pub fn generate_self_signed_cert(device_id: &str) -> Result<SyncCert, AppError> {
    use rcgen::{CertificateParams, DnType, KeyPair};

    // Generate ECDSA P-256 key pair (rcgen default).
    let key_pair =
        KeyPair::generate().map_err(|e| sync_err(format!("key generation failed: {e}")))?;

    // Build certificate parameters.
    let mut params = CertificateParams::new(vec!["localhost".to_string(), "127.0.0.1".to_string()])
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
#[derive(Debug)]
pub(super) struct PinningCertVerifier {
    pub(super) expected_hash: Option<String>,
    pub(super) observed_hash: Arc<std::sync::Mutex<Option<String>>>,
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

        // Store observed hash for the caller.
        if let Ok(mut guard) = self.observed_hash.lock() {
            *guard = Some(hex_hash.clone());
        }

        // If we have an expected hash, enforce it.
        if let Some(ref expected) = self.expected_hash {
            if *expected != hex_hash {
                return Err(rustls::Error::General(format!(
                    "cert pin mismatch: expected {expected}, got {hex_hash}"
                )));
            }
        }

        // Verify CN matches expected device ID format (S-2: defense-in-depth)
        use x509_parser::prelude::*;
        if let Ok((_, parsed)) = X509Certificate::from_der(end_entity.as_ref()) {
            let cn = parsed
                .subject()
                .iter_common_name()
                .next()
                .and_then(|attr| attr.as_str().ok());
            match cn {
                Some(name) if name.starts_with("agaric-") => {
                    // Valid device certificate
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
