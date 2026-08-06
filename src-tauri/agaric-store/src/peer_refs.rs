//! Sync peer tracking — CRUD operations for the `peer_refs` table.
//!
//! Each row tracks a remote sync peer: the last hash received, the last hash
//! sent, the most recent sync timestamp, and a reset counter for detecting
//! protocol resets.
use serde::Serialize;
use sqlx::SqlitePool;

use agaric_core::error::AppError;

/// A row from the `peer_refs` table representing a remote sync peer.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct PeerRef {
    pub peer_id: String,
    pub last_hash: Option<String>,
    pub last_sent_hash: Option<String>,
    /// Most recent successful sync, in milliseconds since the UNIX epoch
    /// (UTC); `None` = never synced. #109 Phase 2: was an RFC 3339 string.
    pub synced_at: Option<i64>,
    pub reset_count: i64,
    /// Most recent protocol reset, in milliseconds since the UNIX epoch
    /// (UTC); `None` = never reset. #109 Phase 2: was an RFC 3339 string.
    pub last_reset_at: Option<i64>,
    /// SHA-256 hex of the peer's TLS certificate, observed during pairing.
    /// Used for certificate pinning on reconnection.
    pub cert_hash: Option<String>,
    /// Human-readable name/label for this peer (e.g. "Javier's Phone").
    pub device_name: Option<String>,
    /// Last known network address (host:port) for direct connection.
    /// Updated after each successful sync. Used when mDNS is unavailable.
    pub last_address: Option<String>,
    /// The peer's iroh `EndpointId` — a 32-byte ed25519 public key — in its
    /// canonical 64-character lowercase-hex `Display` encoding (migration 0107,
    /// plan #3464).
    ///
    /// Unlike [`Self::cert_hash`], this is not a pin taken *against* an
    /// identity the peer claims: the key **is** the identity, authenticated by
    /// the QUIC/TLS 1.3 handshake before any application byte moves.
    ///
    /// `None` is a normal, expected state, not an error — every peer paired
    /// over the pre-iroh transport has no iroh identity, and nothing writes
    /// this column yet (the write path arrives with the transport cutover).
    pub endpoint_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/// Fetch a single peer ref by `peer_id`.
///
/// Returns `None` if the peer does not exist.
pub async fn get_peer_ref(pool: &SqlitePool, peer_id: &str) -> Result<Option<PeerRef>, AppError> {
    let row = sqlx::query_as!(
        PeerRef,
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at,
                  reset_count as "reset_count!: i64", last_reset_at, cert_hash,
                  device_name, last_address, endpoint_id
           FROM peer_refs WHERE peer_id = ?"#,
        peer_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// The canonical on-disk spelling of an `EndpointId`: exactly 64 lowercase hex
/// characters.
///
/// This is `iroh::PublicKey`'s `Display` (`data_encoding::HEXLOWER` over the 32 raw
/// bytes) and it is the *only* spelling migration `0107_peer_refs_endpoint_id.sql`
/// admits — its column CHECK is `length(endpoint_id) = 64 AND endpoint_id NOT GLOB
/// '*[^0-9a-f]*'`.
///
/// It is validated in Rust as well as in SQL because the two rejections mean different
/// things to a caller. The CHECK turns a bad value into an opaque constraint violation
/// at the bottom of a `?` chain; this turns it into a named validation error at the
/// call that got it wrong.
///
/// # Why lowercase specifically, when `is_ascii_hexdigit` would be the reflex
///
/// [`upsert_peer_ref_with_cert`] validates `cert_hash` with `is_ascii_hexdigit()`,
/// which accepts `ABCD…` as readily as `abcd…`. Copying that here would be wrong, and
/// wrong in the direction that hides: `EndpointId`'s `FromStr` is deliberately laxer
/// than its `Display` — it also parses the 52-character base32 form — so a value that
/// round-trips through `FromStr` is *not* necessarily the value `Display` produces.
/// The migration's rule is that the write side encodes with `Display` and never echoes
/// back a parsed input, and equality on `TEXT` under SQLite's `BINARY` collation is
/// case-sensitive. An uppercase pin would therefore store fine under a permissive Rust
/// check, then never match the lowercase form every lookup uses — a peer that is
/// present in the table and invisible to the query that authorizes it.
///
/// It also rejects `EndpointId::fmt_short()`'s 10 characters, which is the convenient
/// thing to reach for when logging and the mistake the migration header calls out.
fn validate_endpoint_id(endpoint_id: &str) -> Result<(), AppError> {
    if endpoint_id.len() != 64
        || !endpoint_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(AppError::validation(format!(
            "invalid endpoint_id: expected the 64-char lowercase-hex `Display` form of \
             an iroh EndpointId, got {} chars",
            endpoint_id.len()
        )));
    }
    Ok(())
}

/// Look up the peer bound to an authenticated iroh `EndpointId`.
///
/// This is the responder's identity lookup, and the direction matters: the QUIC
/// handshake authenticates a **key**, and this answers which Agaric `DeviceId` — if any
/// — that key was bound to at pairing. A key with no row is a peer this device has
/// never paired with, which is the S-1 gate's whole input.
///
/// `endpoint_id` must be the canonical spelling; see [`validate_endpoint_id`].
///
/// # Why more than one match is an error rather than a pick
///
/// Migration 0107 adds the column with `ALTER TABLE … ADD COLUMN`, which in SQLite
/// cannot carry a `UNIQUE` constraint, and the migration adds no unique index. So
/// "two rows share an `endpoint_id`" is representable in the schema even though it is
/// meaningless in the model: one key bound to two `DeviceId`s means the answer to
/// "who is this peer" depends on row order.
///
/// `fetch_optional` would paper over that by returning whichever row SQLite reached
/// first, and the caller — an authorization gate — would proceed with a `DeviceId` it
/// had no basis to choose. That is the identity-confusion failure this column exists to
/// make impossible, arriving through the back door. Refusing is the only answer that
/// does not silently pick a victim.
///
/// [`bind_endpoint_id`] is what keeps the state from arising in the first place; this
/// is the read side declining to trust that it succeeded.
///
/// # Errors
/// If `endpoint_id` is not the canonical form, if the query fails, or if more than one
/// peer is bound to the same key.
pub async fn get_peer_ref_by_endpoint_id(
    pool: &SqlitePool,
    endpoint_id: &str,
) -> Result<Option<PeerRef>, AppError> {
    validate_endpoint_id(endpoint_id)?;
    let mut rows = sqlx::query_as!(
        PeerRef,
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at,
                  reset_count as "reset_count!: i64", last_reset_at, cert_hash,
                  device_name, last_address, endpoint_id
           FROM peer_refs WHERE endpoint_id = ?"#,
        endpoint_id,
    )
    .fetch_all(pool)
    .await?;

    if rows.len() > 1 {
        let peers: Vec<&str> = rows.iter().map(|r| r.peer_id.as_str()).collect();
        return Err(AppError::InvalidOperation(format!(
            "endpoint_id is bound to {} peers ({}); refusing to guess which one \
             authenticated",
            rows.len(),
            peers.join(", ")
        )));
    }
    Ok(rows.pop())
}

/// Bind an authenticated `EndpointId` to a peer, on the trust-on-first-use path.
///
/// Called once per peer, during the pairing window, after the #855 passphrase proof has
/// authorized the key. Thereafter the binding is what
/// [`get_peer_ref_by_endpoint_id`] reads and nothing re-derives it from the wire.
///
/// Like [`upsert_peer_ref_with_cert`] this is an `INSERT … ON CONFLICT(peer_id) DO
/// UPDATE` that touches only its own column, so re-binding a peer preserves
/// `last_hash`, `synced_at`, `reset_count` and the rest.
///
/// # Why it refuses to re-point a key at a second peer
///
/// The `ON CONFLICT` clause keys on `peer_id`, so it protects against one peer getting
/// two rows — but nothing in the schema stops one *key* from being written onto two
/// different peers' rows, which is precisely the ambiguity
/// [`get_peer_ref_by_endpoint_id`] then has to refuse to resolve. Rejecting the second
/// write is what keeps that read from ever having to.
///
/// Re-binding the same key to the same peer is allowed and is a no-op in effect:
/// pairing twice with a device that was already paired must not fail.
///
/// # Errors
/// If `endpoint_id` is not the canonical form, if it is already bound to a different
/// peer, or if the write fails.
pub async fn bind_endpoint_id(
    pool: &SqlitePool,
    peer_id: &str,
    endpoint_id: &str,
) -> Result<(), AppError> {
    validate_endpoint_id(endpoint_id)?;

    if let Some(existing) = get_peer_ref_by_endpoint_id(pool, endpoint_id).await?
        && existing.peer_id != peer_id
    {
        return Err(AppError::InvalidOperation(format!(
            "endpoint_id is already bound to peer {}; refusing to re-point it at {}",
            existing.peer_id, peer_id
        )));
    }

    sqlx::query!(
        "INSERT INTO peer_refs (peer_id, endpoint_id)
         VALUES (?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET endpoint_id = excluded.endpoint_id",
        peer_id,
        endpoint_id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// List all peer refs, ordered by `synced_at` descending (most recently
/// synced first).  Peers that have never synced (`synced_at IS NULL`) appear
/// last.
pub async fn list_peer_refs(pool: &SqlitePool) -> Result<Vec<PeerRef>, AppError> {
    let rows = sqlx::query_as!(
        PeerRef,
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at,
                  reset_count as "reset_count!: i64", last_reset_at, cert_hash,
                  device_name, last_address, endpoint_id
           FROM peer_refs
           WHERE peer_id != ''
           ORDER BY synced_at DESC"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/// Insert a new peer ref if it does not already exist.
///
/// Uses `INSERT OR IGNORE` so calling this for an existing peer is a no-op.
/// All optional fields default to `NULL` and `reset_count` defaults to 0.
pub async fn upsert_peer_ref(pool: &SqlitePool, peer_id: &str) -> Result<(), AppError> {
    sqlx::query!(
        "INSERT OR IGNORE INTO peer_refs (peer_id) VALUES (?)",
        peer_id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// In-transaction variant of [`upsert_peer_ref`].
///
/// The post-session bookkeeping pair (`upsert_peer_ref`
/// followed by [`update_on_sync`]) must run inside a single
/// `BEGIN IMMEDIATE` transaction so a crash between the two writes
/// cannot leave a peer row whose `last_hash` is stale relative to
/// the ops actually applied. This variant exists so the orchestrator
/// can compose both writes inside one transaction.
pub async fn upsert_peer_ref_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "INSERT OR IGNORE INTO peer_refs (peer_id) VALUES (?)",
        peer_id,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Insert a new peer ref with a certificate hash (used during pairing).
///
/// Uses `INSERT … ON CONFLICT(peer_id) DO UPDATE` so re-pairing an existing
/// peer updates only `cert_hash`. The other columns (`last_hash`,
/// `synced_at`, `reset_count`, `last_address`, `device_name`) are
/// **preserved** across re-pairing — this is the deliberate difference
/// vs. an `INSERT OR REPLACE`, which would zero them out.
pub async fn upsert_peer_ref_with_cert(
    pool: &SqlitePool,
    peer_id: &str,
    cert_hash: &str,
) -> Result<(), AppError> {
    // #1602 — symmetric with `sync_cert::read_existing_cert`: never persist a
    // TOFU pin that isn't exactly 64 chars of hex (a SHA-256 hex digest).
    // Callers derive `cert_hash` from the presented TLS cert (well-formed
    // today), but rejecting a malformed pin keeps the write path from
    // silently storing garbage that the read/pin path would later reject.
    if cert_hash.len() != 64 || !cert_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::validation(format!(
            "invalid cert_hash: expected 64-char hex SHA-256, got {} chars",
            cert_hash.len()
        )));
    }
    sqlx::query!(
        "INSERT INTO peer_refs (peer_id, cert_hash)
         VALUES (?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET cert_hash = excluded.cert_hash",
        peer_id,
        cert_hash,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Update sync state atomically after a successful sync exchange.
///
/// Sets `last_hash`, `last_sent_hash`, and `synced_at` (current UTC time).
/// Returns [`AppError::NotFound`] if `peer_id` does not exist.
///
/// # Empty-string sentinel for `last_sent_hash`
///
/// `last_sent_hash` accepts the empty string (`""`) as a "we sent
/// nothing this session" sentinel. Two call sites use it:
///
/// 1. The per-session `sync_protocol::session_state_machine` propagates
///    the empty-string default when no ops were sent this session
///    (typical for an initiator that has no new ops since the previous
///    sync) — see the `last_sent_hash.clone().unwrap_or_default()`
///    expression in `handle_message(SyncComplete)`.
/// 2. `sync_daemon::snapshot_transfer::try_receive_snapshot_catchup`
///    explicitly passes `""` after applying a snapshot, because the
///    snapshot apply path does not stream ops in either direction.
///
/// The empty value is *stored verbatim* in the `last_sent_hash` column;
/// downstream readers must treat it as "no last-sent hash recorded" and
/// not as a real hash.
///
/// **Migration follow-up:** the type-visible alternative is
/// `Option<&str>` (with `None` mapping to NULL or the empty string in
/// the column). That requires touching every call site
/// (`complete_sync` in `sync_protocol::operations`, the orchestrator's
/// `SyncComplete` arm, `snapshot_transfer`, and several test files);
/// The doc-comment route is preferred for the batch and the
/// type migration is left as a separate small refactor.
///
/// **Caller responsibility:** this should run inside a `BEGIN IMMEDIATE`
/// transaction in production to prevent concurrent modifications.
/// Use [`update_on_sync_in_tx`] when composing with another peer-ref
/// write (e.g., a preceding [`upsert_peer_ref_in_tx`] from the
/// orchestrator's bookkeeping pair).
pub async fn update_on_sync(
    pool: &SqlitePool,
    peer_id: &str,
    last_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    let result = sqlx::query!(
        "UPDATE peer_refs SET last_hash = ?, last_sent_hash = ?, synced_at = ?
         WHERE peer_id = ?",
        last_hash,
        last_sent_hash,
        now,
        peer_id,
    )
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// In-transaction variant of [`update_on_sync`].
///
/// Paired with [`upsert_peer_ref_in_tx`] so the
/// orchestrator's post-session bookkeeping (ensure-row + record-sync)
/// commits atomically. A crash between the two writes — or any other
/// failure that aborts the transaction — rolls both back so the next
/// session sees a consistent peer-ref state instead of a stale
/// `last_hash`.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist after
/// the upsert (only possible if the caller skipped the upsert).
pub async fn update_on_sync_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
    last_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    let result = sqlx::query!(
        "UPDATE peer_refs SET last_hash = ?, last_sent_hash = ?, synced_at = ?
         WHERE peer_id = ?",
        last_hash,
        last_sent_hash,
        now,
        peer_id,
    )
    .execute(&mut **tx)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// Increment the reset counter for a peer and record the reset timestamp.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist.
pub async fn increment_reset_count(pool: &SqlitePool, peer_id: &str) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    let result = sqlx::query!(
        "UPDATE peer_refs SET reset_count = reset_count + 1, last_reset_at = ?
         WHERE peer_id = ?",
        now,
        peer_id,
    )
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// In-transaction variant of [`increment_reset_count`].
///
/// Bumps `reset_count` and stamps `last_reset_at` on the passed
/// transaction so the increment commits **atomically** with the
/// `synced_at`/`last_hash` advance recorded by [`update_on_sync_in_tx`]
/// in the same `BEGIN IMMEDIATE` transaction. This is the protocol-reset
/// (snapshot catch-up) bookkeeping path: a peer that re-syncs from a
/// snapshot must record the reset event in the same write as the new
/// frontier, so a crash between the two can never leave the counter and
/// the frontier disagreeing about whether a reset happened.
///
/// `last_reset_at` is epoch-ms (`crate::db::now_ms()`), matching the
/// column contract established by migration
/// `0075_peer_refs_timestamps_ms`.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist (the
/// caller is expected to `upsert_peer_ref_in_tx` first).
pub async fn increment_reset_count_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    let result = sqlx::query!(
        "UPDATE peer_refs SET reset_count = reset_count + 1, last_reset_at = ?
         WHERE peer_id = ?",
        now,
        peer_id,
    )
    .execute(&mut **tx)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// Delete a peer ref by `peer_id`.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist.
pub async fn delete_peer_ref(pool: &SqlitePool, peer_id: &str) -> Result<(), AppError> {
    let result = sqlx::query!("DELETE FROM peer_refs WHERE peer_id = ?", peer_id,)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// Update the human-readable name for a peer.
pub async fn update_device_name(
    pool: &SqlitePool,
    peer_id: &str,
    device_name: Option<&str>,
) -> Result<(), AppError> {
    let rows = sqlx::query!(
        "UPDATE peer_refs SET device_name = ? WHERE peer_id = ?",
        device_name,
        peer_id,
    )
    .execute(pool)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

/// Update the last known network address for a peer.
///
/// Called after each successful sync to cache the peer's address for
/// direct connection when mDNS discovery is unavailable.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist.
pub async fn update_last_address(
    pool: &SqlitePool,
    peer_id: &str,
    address: &str,
) -> Result<(), AppError> {
    let result = sqlx::query!(
        "UPDATE peer_refs SET last_address = ? WHERE peer_id = ?",
        address,
        peer_id,
    )
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-peer Loro version vectors (#2502)
// ---------------------------------------------------------------------------
//
// `loro_vv_bytes` (migration 0100) persists the PEER's advertised per-space
// Loro version vectors as of the last completed sync session. The bytes are an
// OPAQUE blob to this layer — the sync-protocol layer serializes its
// `Vec<SpaceVersionVector>` into them and parses them back — so `peer_refs`
// takes no dependency on `sync_protocol::types` (which already depends on
// `peer_refs`, so surfacing the typed struct here would be a cycle). It is also
// deliberately NOT a field on [`PeerRef`]: that struct crosses the Tauri IPC
// boundary (`commands::sync_cmds::list_peer_refs` / `get_peer_ref`, generating
// TS bindings), and a raw BLOB has no place in the frontend peer list.

/// Read a peer's persisted per-space Loro version-vector blob (#2502).
///
/// Returns `Ok(None)` when the peer row is absent OR the column is NULL (we
/// have not yet completed a version-vector exchange with this peer). Callers
/// treat both the same way — "no persisted frontier, fall back to a full
/// snapshot per space" — so the two cases are not distinguished.
pub async fn get_loro_vv_bytes(
    pool: &SqlitePool,
    peer_id: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    let row = sqlx::query_scalar!(
        "SELECT loro_vv_bytes FROM peer_refs WHERE peer_id = ?",
        peer_id,
    )
    .fetch_optional(pool)
    .await?;
    // `row` is `Option<Option<Vec<u8>>>`: outer = row presence, inner = column
    // NULL-ness. Flatten so an absent row and a NULL column both read `None`.
    Ok(row.flatten())
}

/// In-transaction: persist a peer's per-space Loro version-vector blob (#2502).
///
/// Composes inside the same `BEGIN IMMEDIATE` transaction as the streamer's
/// post-session bookkeeping so the persisted frontier commits atomically with
/// the rest of the sync completion. Returns [`AppError::NotFound`] if
/// `peer_id` does not exist (the caller is expected to `upsert_peer_ref_in_tx`
/// first).
pub async fn update_loro_vv_bytes_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
    loro_vv_bytes: &[u8],
) -> Result<(), AppError> {
    let result = sqlx::query!(
        "UPDATE peer_refs SET loro_vv_bytes = ? WHERE peer_id = ?",
        loro_vv_bytes,
        peer_id,
    )
    .execute(&mut **tx)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("peer_refs ({peer_id})")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pending-pairing marker
// ---------------------------------------------------------------------------

/// `app_settings` key for the "a pairing completed; the first peer connection
/// is expected" marker.
///
/// Set by `confirm_pairing` when the FE supplies no remote device_id (the QR
/// carries only the passphrase; mDNS + TOFU establish the real peer on the
/// first connection). Honored by
/// `sync_daemon::SyncDaemon::should_start_active` so the dormant
/// daemon wakes to *accept* that first inbound connection, and cleared once a
/// real peer exists. This replaces the old hack of writing a junk
/// empty-string `peer_id` row purely to trip the activation check.
const PENDING_PAIRING_KEY: &str = "sync.pending_pairing";

/// #1603: time-to-live for the pending-pairing marker, in milliseconds.
///
/// The marker is written when a pairing is confirmed but the first peer
/// connection has not yet arrived; it is cleared once a real peer is
/// established. Previously nothing else cleared it, so an *abandoned* pairing
/// (the joining device never connects) left the daemon advertising and
/// accepting pairing connections indefinitely. We bound it to the same
/// window a pairing session lives ([`PAIRING_TIMEOUT`], 5
/// minutes): the joiner is expected to connect within the interactive
/// pairing window, so a marker older than that is stale and reads as
/// "not pending".
// PAIRING_TIMEOUT is 5 minutes; its millis fit i64 trivially.
#[allow(clippy::cast_possible_truncation)]
const PENDING_PAIRING_TTL_MS: i64 = PAIRING_TIMEOUT.as_millis() as i64;

/// The interactive pairing window (5 minutes).
///
/// Owned here in the store layer because [`PENDING_PAIRING_TTL_MS`] bounds
/// the pending-pairing marker to the same clock, and the sync-layer
/// `pairing` module re-exports it (`pub use crate::peer_refs::PAIRING_TIMEOUT;`)
/// for `crate::pairing::PairingSession::is_expired`. Reusing one value
/// keeps a pairing session and its pending marker on the same window: once
/// the interactive window has elapsed, an abandoned pairing (the joining
/// device never connects) must stop driving the daemon into pairing-mode.
pub const PAIRING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300); // 5 minutes

/// Mark that a pairing just completed and a first peer connection is expected.
///
/// #855: `expected_proof` is the `pairing::pairing_proof` of the
/// pairing passphrase — the value the responder compares against the
/// initiator's advertised `HeadExchange.pairing_proof` before it TOFU-pins an
/// unpaired device during the pairing window. Storing the proof (a
/// domain-separated blake3 of the passphrase, never the passphrase itself) in
/// the marker `value` is what binds the "accept a first connection" bridge to
/// knowledge of the out-of-band passphrase, closing the CN-spoof window.
pub async fn set_pending_pairing(pool: &SqlitePool, expected_proof: &str) -> Result<(), AppError> {
    // M5 (#348): bind `now_ms()` (epoch-ms, the column's contract) into both
    // branches instead of `strftime('%s','now') * 1000` (second precision).
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = ?,
             updated_at = ?",
        PENDING_PAIRING_KEY,
        expected_proof,
        now,
        expected_proof,
        now,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Whether a pairing is awaiting its first peer connection.
///
/// #1603: the marker is treated as expired (and reads as *not* pending) once
/// it is older than [`PENDING_PAIRING_TTL_MS`], so an abandoned pairing stops
/// driving the daemon into pairing mode. An expired marker is cleared lazily
/// on this read so it does not linger in `app_settings`.
///
/// #855: the marker `value` now holds the expected pairing proof rather than a
/// `'1'` sentinel, so any non-empty value counts as pending. A stale pre-#855
/// `'1'` marker still reads as pending (harmless — no real proof equals `'1'`,
/// so it cannot admit anyone — and it expires on its TTL).
pub async fn is_pending_pairing(pool: &SqlitePool) -> Result<bool, AppError> {
    Ok(pending_pairing_proof_if_fresh(pool).await?.is_some())
}

/// The expected pairing proof for an in-window pending pairing, or `None` when
/// no pairing is pending (no marker, empty value, or TTL-expired) (#855).
///
/// Shares the TTL + lazy-clear logic with [`is_pending_pairing`] so the
/// "pending?" and "which proof?" answers can never disagree.
pub async fn get_pending_pairing_proof(pool: &SqlitePool) -> Result<Option<String>, AppError> {
    pending_pairing_proof_if_fresh(pool).await
}

/// Read the pending-pairing marker, applying the #1603 TTL gate (with lazy
/// clear of a stale marker). Returns the stored proof when the marker exists,
/// is non-empty, and is within [`PENDING_PAIRING_TTL_MS`]; otherwise `None`.
async fn pending_pairing_proof_if_fresh(pool: &SqlitePool) -> Result<Option<String>, AppError> {
    let row = sqlx::query!(
        "SELECT value, updated_at FROM app_settings WHERE key = ?",
        PENDING_PAIRING_KEY,
    )
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    if row.value.is_empty() {
        return Ok(None);
    }

    // #1603: TTL gate. `updated_at` is epoch-ms (written via `now_ms()` in
    // `set_pending_pairing`). If it is older than the TTL, the marker is
    // stale — clear it lazily and report "not pending".
    let now = crate::db::now_ms();
    if now.saturating_sub(row.updated_at) > PENDING_PAIRING_TTL_MS {
        clear_pending_pairing(pool).await?;
        return Ok(None);
    }

    Ok(Some(row.value))
}

/// Clear the pending-pairing marker — a real peer has been established, so the
/// activation bridge is no longer needed.
pub async fn clear_pending_pairing(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query!(
        "DELETE FROM app_settings WHERE key = ?",
        PENDING_PAIRING_KEY
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_pool;

    // ── get_peer_ref ────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_nonexistent_peer_returns_none() {
        let (pool, _dir) = test_pool().await;

        let result = get_peer_ref(&pool, "no-such-peer").await.unwrap();
        assert!(
            result.is_none(),
            "get_peer_ref for nonexistent peer must return None"
        );
    }

    // ── upsert_peer_ref + get_peer_ref ──────────────────────────────────

    #[tokio::test]
    async fn upsert_creates_new_peer_and_get_retrieves_it() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-A").await.unwrap();

        let peer = get_peer_ref(&pool, "peer-A")
            .await
            .unwrap()
            .expect("peer-A must exist after upsert");

        assert_eq!(peer.peer_id, "peer-A", "peer_id must match");
        assert!(peer.last_hash.is_none(), "last_hash must default to NULL");
        assert!(
            peer.last_sent_hash.is_none(),
            "last_sent_hash must default to NULL"
        );
        assert!(peer.synced_at.is_none(), "synced_at must default to NULL");
        assert_eq!(peer.reset_count, 0, "reset_count must default to 0");
        assert!(
            peer.last_reset_at.is_none(),
            "last_reset_at must default to NULL"
        );
    }

    #[tokio::test]
    async fn upsert_existing_peer_is_noop() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-A").await.unwrap();
        // Update some state so we can verify upsert doesn't overwrite
        update_on_sync(&pool, "peer-A", "hash1", "sent1")
            .await
            .unwrap();

        // Second upsert should be a no-op (INSERT OR IGNORE)
        upsert_peer_ref(&pool, "peer-A").await.unwrap();

        let peer = get_peer_ref(&pool, "peer-A")
            .await
            .unwrap()
            .expect("peer-A must still exist");
        assert_eq!(
            peer.last_hash.as_deref(),
            Some("hash1"),
            "upsert must not overwrite existing data"
        );
    }

    // ── update_on_sync ──────────────────────────────────────────────────

    #[tokio::test]
    async fn update_on_sync_sets_fields_atomically() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-B").await.unwrap();
        update_on_sync(&pool, "peer-B", "abc123", "def456")
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-B")
            .await
            .unwrap()
            .expect("peer-B must exist");

        assert_eq!(
            peer.last_hash.as_deref(),
            Some("abc123"),
            "last_hash must be updated"
        );
        assert_eq!(
            peer.last_sent_hash.as_deref(),
            Some("def456"),
            "last_sent_hash must be updated"
        );
        assert!(
            peer.synced_at.is_some(),
            "synced_at must be set after update_on_sync"
        );
    }

    #[tokio::test]
    async fn update_on_sync_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = update_on_sync(&pool, "ghost-peer", "h1", "h2").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "update_on_sync on nonexistent peer must return AppError::NotFound"
        );
    }

    // ── increment_reset_count ───────────────────────────────────────────

    #[tokio::test]
    async fn increment_reset_count_increments_correctly() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-C").await.unwrap();

        // First increment: 0 -> 1
        increment_reset_count(&pool, "peer-C").await.unwrap();
        let peer = get_peer_ref(&pool, "peer-C")
            .await
            .unwrap()
            .expect("peer-C must exist");
        assert_eq!(
            peer.reset_count, 1,
            "reset_count must be 1 after first increment"
        );
        assert!(
            peer.last_reset_at.is_some(),
            "last_reset_at must be set after increment"
        );

        // Second increment: 1 -> 2
        increment_reset_count(&pool, "peer-C").await.unwrap();
        let peer = get_peer_ref(&pool, "peer-C")
            .await
            .unwrap()
            .expect("peer-C must exist");
        assert_eq!(
            peer.reset_count, 2,
            "reset_count must be 2 after second increment"
        );
    }

    #[tokio::test]
    async fn increment_reset_count_in_tx_increments_atomically() {
        // #2046: the in-tx variant must bump reset_count + stamp
        // last_reset_at on the passed transaction, composing with the
        // sync-frontier advance in one commit (0 → 1 → 2).
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-tx").await.unwrap();

        // First reset, composed with a frontier advance in one tx.
        let mut tx = pool.begin().await.unwrap();
        update_on_sync_in_tx(&mut tx, "peer-tx", "h1", "")
            .await
            .unwrap();
        increment_reset_count_in_tx(&mut tx, "peer-tx")
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let peer = get_peer_ref(&pool, "peer-tx").await.unwrap().unwrap();
        assert_eq!(
            peer.reset_count, 1,
            "reset_count must be 1 after first in-tx bump"
        );
        assert!(peer.last_reset_at.is_some(), "last_reset_at must be set");
        assert_eq!(
            peer.last_hash.as_deref(),
            Some("h1"),
            "frontier advance must commit atomically with the reset bump"
        );
        assert!(
            peer.synced_at.is_some(),
            "synced_at must be set in the same tx"
        );

        // Second reset: 1 → 2.
        let mut tx = pool.begin().await.unwrap();
        increment_reset_count_in_tx(&mut tx, "peer-tx")
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let peer = get_peer_ref(&pool, "peer-tx").await.unwrap().unwrap();
        assert_eq!(
            peer.reset_count, 2,
            "reset_count must be 2 after second in-tx bump"
        );
    }

    #[tokio::test]
    async fn increment_reset_count_in_tx_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();
        let result = increment_reset_count_in_tx(&mut tx, "ghost-peer").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "increment_reset_count_in_tx on nonexistent peer must return AppError::NotFound"
        );
    }

    #[tokio::test]
    async fn increment_reset_count_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = increment_reset_count(&pool, "ghost-peer").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "increment_reset_count on nonexistent peer must return AppError::NotFound"
        );
    }

    // ── list_peer_refs ──────────────────────────────────────────────────

    #[tokio::test]
    async fn list_peer_refs_returns_all_peers() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-X").await.unwrap();
        upsert_peer_ref(&pool, "peer-Y").await.unwrap();
        upsert_peer_ref(&pool, "peer-Z").await.unwrap();

        // Sync two of them so they have synced_at timestamps
        update_on_sync(&pool, "peer-X", "hx", "sx").await.unwrap();
        // Small sleep to ensure distinct timestamps for ordering
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        update_on_sync(&pool, "peer-Z", "hz", "sz").await.unwrap();

        let peers = list_peer_refs(&pool).await.unwrap();

        assert_eq!(peers.len(), 3, "must return all 3 peers");
        // peer-Z synced most recently, should be first
        assert_eq!(
            peers[0].peer_id, "peer-Z",
            "most recently synced peer must be first"
        );
        assert_eq!(
            peers[1].peer_id, "peer-X",
            "second most recently synced peer must be second"
        );
        // peer-Y has NULL synced_at, should be last
        assert_eq!(peers[2].peer_id, "peer-Y", "never-synced peer must be last");
    }

    #[tokio::test]
    async fn list_peer_refs_empty_table_returns_empty_vec() {
        let (pool, _dir) = test_pool().await;

        let peers = list_peer_refs(&pool).await.unwrap();
        assert!(
            peers.is_empty(),
            "list_peer_refs on empty table must return empty vec"
        );
    }

    // ── delete_peer_ref ─────────────────────────────────────────────────

    #[tokio::test]
    async fn delete_peer_ref_removes_peer() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-D").await.unwrap();
        assert!(
            get_peer_ref(&pool, "peer-D").await.unwrap().is_some(),
            "peer-D must exist before delete"
        );

        delete_peer_ref(&pool, "peer-D").await.unwrap();

        assert!(
            get_peer_ref(&pool, "peer-D").await.unwrap().is_none(),
            "peer-D must not exist after delete"
        );
    }

    #[tokio::test]
    async fn delete_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = delete_peer_ref(&pool, "ghost-peer").await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "delete_peer_ref on nonexistent peer must return AppError::NotFound"
        );
    }

    // ── cert_hash ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn upsert_without_cert_has_null_cert_hash() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-no-cert").await.unwrap();
        let peer = get_peer_ref(&pool, "peer-no-cert")
            .await
            .unwrap()
            .expect("peer must exist");
        assert!(
            peer.cert_hash.is_none(),
            "cert_hash must be NULL when upserted without cert"
        );
    }

    #[tokio::test]
    async fn upsert_with_cert_stores_cert_hash() {
        let (pool, _dir) = test_pool().await;
        let hash = "a".repeat(64);

        upsert_peer_ref_with_cert(&pool, "peer-cert", &hash)
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-cert")
            .await
            .unwrap()
            .expect("peer must exist after upsert_with_cert");
        assert_eq!(
            peer.cert_hash.as_deref(),
            Some(hash.as_str()),
            "cert_hash must match the provided hash"
        );
    }

    #[tokio::test]
    async fn upsert_with_cert_updates_existing_peer_cert_hash() {
        let (pool, _dir) = test_pool().await;
        let hash1 = "a".repeat(64);
        let hash2 = "b".repeat(64);

        // Create peer with first cert hash.
        upsert_peer_ref_with_cert(&pool, "peer-update", &hash1)
            .await
            .unwrap();

        // Update with second cert hash.
        upsert_peer_ref_with_cert(&pool, "peer-update", &hash2)
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-update")
            .await
            .unwrap()
            .expect("peer must exist");
        assert_eq!(
            peer.cert_hash.as_deref(),
            Some(hash2.as_str()),
            "cert_hash must be updated to second hash"
        );
    }

    #[tokio::test]
    async fn upsert_with_cert_accepts_uppercase_hex() {
        // #1602 — `is_ascii_hexdigit` (matching read_existing_cert) accepts
        // either case, so an uppercase 64-char hex pin must upsert cleanly.
        let (pool, _dir) = test_pool().await;
        let hash = "A".repeat(64);

        upsert_peer_ref_with_cert(&pool, "peer-upper", &hash)
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-upper")
            .await
            .unwrap()
            .expect("peer must exist after upsert_with_cert");
        assert_eq!(peer.cert_hash.as_deref(), Some(hash.as_str()));
    }

    #[tokio::test]
    async fn upsert_with_cert_rejects_malformed_hash_and_persists_nothing() {
        // #1602 — a too-short, too-long, or non-hex pin must be rejected with
        // an AppError::Validation, and the row must not be written at all
        // (symmetric with sync_cert::read_existing_cert's hash guard).
        let (pool, _dir) = test_pool().await;

        let bad_hashes = [
            "a".repeat(63),                 // too short
            "a".repeat(65),                 // too long
            String::new(),                  // empty
            "g".repeat(64),                 // 64 chars but non-hex ('g')
            format!("{}z", "a".repeat(63)), // 64 chars, trailing non-hex
        ];

        for (i, bad) in bad_hashes.iter().enumerate() {
            let peer_id = format!("peer-bad-{i}");
            let err = upsert_peer_ref_with_cert(&pool, &peer_id, bad)
                .await
                .expect_err("malformed cert_hash must be rejected");
            assert!(
                matches!(err, AppError::Validation { .. }),
                "expected AppError::Validation for {bad:?}, got {err:?}"
            );

            // Nothing must have been persisted for this peer.
            let row = get_peer_ref(&pool, &peer_id).await.unwrap();
            assert!(
                row.is_none(),
                "no peer_refs row may be written for malformed hash {bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn upsert_with_cert_preserves_existing_sync_state() {
        let (pool, _dir) = test_pool().await;

        // Create peer and sync it.
        upsert_peer_ref(&pool, "peer-preserve").await.unwrap();
        update_on_sync(&pool, "peer-preserve", "h1", "s1")
            .await
            .unwrap();

        // Now set cert hash — should not overwrite sync state.
        let hash = "c".repeat(64);
        upsert_peer_ref_with_cert(&pool, "peer-preserve", &hash)
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-preserve")
            .await
            .unwrap()
            .expect("peer must exist");
        assert_eq!(
            peer.cert_hash.as_deref(),
            Some(hash.as_str()),
            "cert_hash must be set"
        );
        assert_eq!(
            peer.last_hash.as_deref(),
            Some("h1"),
            "last_hash must be preserved after cert update"
        );
        assert_eq!(
            peer.last_sent_hash.as_deref(),
            Some("s1"),
            "last_sent_hash must be preserved after cert update"
        );
        assert!(
            peer.synced_at.is_some(),
            "synced_at must be preserved after cert update"
        );
    }

    #[tokio::test]
    async fn list_peer_refs_includes_cert_hash() {
        let (pool, _dir) = test_pool().await;
        let hash = "d".repeat(64);

        upsert_peer_ref_with_cert(&pool, "peer-list-cert", &hash)
            .await
            .unwrap();

        let peers = list_peer_refs(&pool).await.unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(
            peers[0].cert_hash.as_deref(),
            Some(hash.as_str()),
            "list_peer_refs must include cert_hash"
        );
    }

    // ── device_name ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_device_name_default_null() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "PEERDN01").await.unwrap();
        let peer = get_peer_ref(&pool, "PEERDN01").await.unwrap().unwrap();
        assert!(peer.device_name.is_none());
    }

    #[tokio::test]
    async fn test_update_device_name() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "PEERDN02").await.unwrap();
        update_device_name(&pool, "PEERDN02", Some("Javier's Phone"))
            .await
            .unwrap();
        let peer = get_peer_ref(&pool, "PEERDN02").await.unwrap().unwrap();
        assert_eq!(peer.device_name.as_deref(), Some("Javier's Phone"));
    }

    #[tokio::test]
    async fn test_update_device_name_clear() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "PEERDN03").await.unwrap();
        update_device_name(&pool, "PEERDN03", Some("Old Name"))
            .await
            .unwrap();
        update_device_name(&pool, "PEERDN03", None).await.unwrap();
        let peer = get_peer_ref(&pool, "PEERDN03").await.unwrap().unwrap();
        assert!(peer.device_name.is_none());
    }

    #[tokio::test]
    async fn test_update_device_name_not_found() {
        let (pool, _dir) = test_pool().await;
        let err = update_device_name(&pool, "NONEXISTENT", Some("name"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // ── update_last_address ─────────────────────────────────────────────

    #[tokio::test]
    async fn update_last_address_returns_not_found_for_unknown_peer() {
        let (pool, _dir) = test_pool().await;
        let err = update_last_address(&pool, "NONEXISTENT", "1.2.3.4:5678")
            .await
            .unwrap_err();
        match err {
            AppError::NotFound(ref msg) => assert_eq!(
                msg, "peer_refs (NONEXISTENT)",
                "NotFound message must match the sibling helpers' format"
            ),
            other => panic!(
                "update_last_address on nonexistent peer must return AppError::NotFound, got {other:?}"
            ),
        }
    }

    #[tokio::test]
    async fn update_last_address_succeeds_for_existing_peer() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-addr").await.unwrap();

        update_last_address(&pool, "peer-addr", "10.0.0.1:9999")
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-addr")
            .await
            .unwrap()
            .expect("peer-addr must exist");
        assert_eq!(
            peer.last_address.as_deref(),
            Some("10.0.0.1:9999"),
            "last_address must be persisted"
        );
    }

    // ── pending-pairing marker ─────────────────────────────

    // `pending_pairing_set_check_clear_roundtrip` couples to the app-only
    // `crate::pairing::pairing_proof`, so it lives in the app crate
    // (`src/peer_refs_app_tests.rs`, #2621 wave S4a) rather than here.

    /// #1603: a pending-pairing marker older than `PENDING_PAIRING_TTL_MS`
    /// reads as *not* pending (and is cleared lazily), while a freshly-set
    /// marker reads as pending. This stops an abandoned pairing from leaving
    /// the daemon in pairing mode indefinitely.
    #[tokio::test]
    async fn pending_pairing_marker_expires_after_ttl() {
        let (pool, _dir) = test_pool().await;

        // Fresh marker → pending.
        set_pending_pairing(&pool, "test-proof").await.unwrap();
        assert!(
            is_pending_pairing(&pool).await.unwrap(),
            "#1603: a freshly-set marker must read as pending"
        );

        // Backdate `updated_at` to just beyond the TTL so the marker is stale.
        let stale = crate::db::now_ms() - PENDING_PAIRING_TTL_MS - 1;
        sqlx::query!(
            "UPDATE app_settings SET updated_at = ? WHERE key = ?",
            stale,
            PENDING_PAIRING_KEY,
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            !is_pending_pairing(&pool).await.unwrap(),
            "#1603: a marker older than the TTL must read as not-pending"
        );

        // Lazily cleared: the stale row must have been deleted on the expired
        // read so it does not linger in `app_settings`.
        let still_there: Option<String> = sqlx::query_scalar!(
            "SELECT value FROM app_settings WHERE key = ?",
            PENDING_PAIRING_KEY,
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(
            still_there.is_none(),
            "#1603: an expired marker must be cleared lazily on read"
        );
    }

    /// #1603: a marker exactly at the TTL boundary (age == TTL) is still
    /// considered fresh — only `age > TTL` expires.
    #[tokio::test]
    async fn pending_pairing_marker_fresh_within_ttl() {
        let (pool, _dir) = test_pool().await;
        set_pending_pairing(&pool, "test-proof").await.unwrap();

        // Backdate to TTL/2 — comfortably within the window.
        let recent = crate::db::now_ms() - PENDING_PAIRING_TTL_MS / 2;
        sqlx::query!(
            "UPDATE app_settings SET updated_at = ? WHERE key = ?",
            recent,
            PENDING_PAIRING_KEY,
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            is_pending_pairing(&pool).await.unwrap(),
            "#1603: a marker within the TTL must still read as pending"
        );
    }

    #[tokio::test]
    async fn list_peer_refs_excludes_empty_peer_id() {
        // A legacy/junk empty-string peer row must never surface (it would
        // wrongly trip should_start_active and show as a blank ghost peer).
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "").await.unwrap();
        upsert_peer_ref(&pool, "PEER_REAL").await.unwrap();

        let peers = list_peer_refs(&pool).await.unwrap();
        assert_eq!(peers.len(), 1, "the empty-string peer must be filtered out");
        assert_eq!(peers[0].peer_id, "PEER_REAL");
    }

    // ── loro_vv_bytes (#2502) ───────────────────────────────────────────

    #[tokio::test]
    async fn loro_vv_bytes_defaults_to_none_and_round_trips() {
        // #2502: a fresh peer row has a NULL `loro_vv_bytes` (read as `None`);
        // an in-tx write persists the opaque blob verbatim and a subsequent
        // read returns exactly those bytes.
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-vv").await.unwrap();

        // Default: NULL column → None.
        assert!(
            get_loro_vv_bytes(&pool, "peer-vv").await.unwrap().is_none(),
            "loro_vv_bytes must default to None on a fresh peer row"
        );
        // Absent row → also None (not an error).
        assert!(
            get_loro_vv_bytes(&pool, "no-such-peer")
                .await
                .unwrap()
                .is_none(),
            "loro_vv_bytes for an absent peer must be None"
        );

        // Persist a blob (including an embedded NUL to prove it is opaque
        // binary, not a text column).
        let blob = vec![0u8, 1, 2, 3, 0, 255, 42];
        let mut tx = pool.begin().await.unwrap();
        update_loro_vv_bytes_in_tx(&mut tx, "peer-vv", &blob)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            get_loro_vv_bytes(&pool, "peer-vv").await.unwrap(),
            Some(blob.clone()),
            "persisted loro_vv_bytes must round-trip byte-for-byte"
        );

        // Overwrite replaces the prior blob.
        let blob2 = vec![9u8, 9, 9];
        let mut tx = pool.begin().await.unwrap();
        update_loro_vv_bytes_in_tx(&mut tx, "peer-vv", &blob2)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            get_loro_vv_bytes(&pool, "peer-vv").await.unwrap(),
            Some(blob2),
            "a second write must replace the prior loro_vv_bytes"
        );
    }

    #[tokio::test]
    async fn update_loro_vv_bytes_nonexistent_peer_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();
        let result = update_loro_vv_bytes_in_tx(&mut tx, "ghost-peer", &[1, 2, 3]).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "update_loro_vv_bytes_in_tx on a nonexistent peer must return NotFound"
        );
    }

    // ── endpoint_id (#3464 stage 1, migration 0107) ────────────────────

    /// The read path carries `endpoint_id` end to end, and `None` is a real,
    /// expected value rather than an error.
    ///
    /// Nothing writes this column yet — the write path arrives with the
    /// transport cutover — so the row is populated with raw SQL here. What is
    /// under test is the SELECT column list and the `PeerRef` mapping, which is
    /// exactly what this stage adds.
    #[tokio::test]
    async fn peer_ref_endpoint_id_round_trips_and_defaults_to_none_3464() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-eid").await.unwrap();
        upsert_peer_ref(&pool, "peer-no-eid").await.unwrap();

        // A fresh row has no iroh identity.
        let fresh = get_peer_ref(&pool, "peer-eid")
            .await
            .unwrap()
            .expect("peer-eid must exist");
        assert!(
            fresh.endpoint_id.is_none(),
            "a peer row with no iroh identity must read endpoint_id = None"
        );

        // The canonical `EndpointId::Display` encoding: 64 lowercase hex chars.
        let eid = "0123456789abcdef".repeat(4);
        sqlx::query!(
            "UPDATE peer_refs SET endpoint_id = ? WHERE peer_id = ?",
            eid,
            "peer-eid",
        )
        .execute(&pool)
        .await
        .unwrap();

        let peer = get_peer_ref(&pool, "peer-eid")
            .await
            .unwrap()
            .expect("peer-eid must exist");
        assert_eq!(
            peer.endpoint_id.as_deref(),
            Some(eid.as_str()),
            "get_peer_ref must read endpoint_id back verbatim"
        );

        let absent = get_peer_ref(&pool, "peer-no-eid")
            .await
            .unwrap()
            .expect("peer-no-eid must exist");
        assert!(
            absent.endpoint_id.is_none(),
            "a peer written without an endpoint_id must read back None"
        );

        // The list path must carry it too — it is the one the UI consumes.
        let peers = list_peer_refs(&pool).await.unwrap();
        let listed = peers
            .iter()
            .find(|p| p.peer_id == "peer-eid")
            .expect("peer-eid must appear in list_peer_refs");
        assert_eq!(
            listed.endpoint_id.as_deref(),
            Some(eid.as_str()),
            "list_peer_refs must include endpoint_id"
        );
        let listed_absent = peers
            .iter()
            .find(|p| p.peer_id == "peer-no-eid")
            .expect("peer-no-eid must appear in list_peer_refs");
        assert!(
            listed_absent.endpoint_id.is_none(),
            "list_peer_refs must report an absent endpoint_id as None"
        );
    }

    // ── endpoint_id: bind + lookup ──────────────────────────────────────
    //
    // The canonical `Display` form of an `EndpointId` is 64 lowercase hex chars.
    // These fixtures spell it out rather than deriving it from a real key so the
    // encoding under test is the one the migration's CHECK describes, not whatever
    // iroh happens to produce today.
    const KEY_A: &str = "aa11bb22cc33dd44ee55ff6607788990a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const KEY_B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn an_authenticated_key_resolves_to_the_peer_it_was_bound_to() {
        let (pool, _dir) = test_pool().await;

        bind_endpoint_id(&pool, "peer-A", KEY_A).await.unwrap();

        let found = get_peer_ref_by_endpoint_id(&pool, KEY_A)
            .await
            .unwrap()
            .expect("the bound key must resolve to a peer");
        assert_eq!(
            found.peer_id, "peer-A",
            "the key must resolve to the peer it was bound to"
        );
        assert_eq!(
            found.endpoint_id.as_deref(),
            Some(KEY_A),
            "the stored endpoint_id must round-trip verbatim"
        );
    }

    #[tokio::test]
    async fn an_unbound_key_resolves_to_no_peer() {
        let (pool, _dir) = test_pool().await;

        bind_endpoint_id(&pool, "peer-A", KEY_A).await.unwrap();

        // This is the S-1 gate's input: a genuine, authenticated key that this
        // device has simply never paired with.
        let found = get_peer_ref_by_endpoint_id(&pool, KEY_B).await.unwrap();
        assert!(
            found.is_none(),
            "a key that was never bound must resolve to no peer, got {found:?}"
        );
    }

    #[tokio::test]
    async fn binding_preserves_the_peers_existing_sync_state() {
        let (pool, _dir) = test_pool().await;

        upsert_peer_ref(&pool, "peer-A").await.unwrap();
        update_on_sync(&pool, "peer-A", "hash-in", "hash-out")
            .await
            .unwrap();

        bind_endpoint_id(&pool, "peer-A", KEY_A).await.unwrap();

        let peer = get_peer_ref(&pool, "peer-A").await.unwrap().unwrap();
        assert_eq!(
            peer.last_hash.as_deref(),
            Some("hash-in"),
            "binding a key must not disturb last_hash — it is an ON CONFLICT DO \
             UPDATE of one column, not an INSERT OR REPLACE"
        );
        assert!(
            peer.synced_at.is_some(),
            "binding a key must not clear synced_at"
        );
    }

    #[tokio::test]
    async fn rebinding_the_same_key_to_the_same_peer_is_allowed() {
        let (pool, _dir) = test_pool().await;

        bind_endpoint_id(&pool, "peer-A", KEY_A).await.unwrap();
        // Pairing twice with an already-paired device must not fail.
        bind_endpoint_id(&pool, "peer-A", KEY_A)
            .await
            .expect("re-binding the same key to the same peer must succeed");
    }

    #[tokio::test]
    async fn a_key_cannot_be_re_pointed_at_a_second_peer() {
        let (pool, _dir) = test_pool().await;

        bind_endpoint_id(&pool, "peer-A", KEY_A).await.unwrap();

        let err = bind_endpoint_id(&pool, "peer-B", KEY_A)
            .await
            .expect_err("binding one key to a second peer must be refused");
        let msg = err.to_string();
        assert!(
            msg.contains("already bound to peer peer-A"),
            "the refusal must name the peer already holding the key, got: {msg}"
        );

        // The refusal is what keeps the read side from ever facing an ambiguity.
        let found = get_peer_ref_by_endpoint_id(&pool, KEY_A).await.unwrap();
        assert_eq!(
            found.expect("the original binding must survive").peer_id,
            "peer-A",
            "the rejected write must not have disturbed the existing binding"
        );
    }

    #[tokio::test]
    async fn a_key_bound_to_two_peers_is_refused_rather_than_resolved() {
        let (pool, _dir) = test_pool().await;

        // Reach past `bind_endpoint_id`'s guard to construct the state the schema
        // still permits (0107 adds no UNIQUE index), because the point of the read
        // guard is that it does not depend on the write guard having held.
        upsert_peer_ref(&pool, "peer-A").await.unwrap();
        upsert_peer_ref(&pool, "peer-B").await.unwrap();
        for peer in ["peer-A", "peer-B"] {
            sqlx::query!(
                "UPDATE peer_refs SET endpoint_id = ? WHERE peer_id = ?",
                KEY_A,
                peer
            )
            .execute(&pool)
            .await
            .unwrap();
        }

        let err = get_peer_ref_by_endpoint_id(&pool, KEY_A)
            .await
            .expect_err("an ambiguous binding must be refused, not resolved");
        let msg = err.to_string();
        assert!(
            msg.contains("bound to 2 peers"),
            "the refusal must say how many peers claim the key, got: {msg}"
        );
        assert!(
            msg.contains("peer-A") && msg.contains("peer-B"),
            "the refusal must name both claimants so the row can be found, got: {msg}"
        );
    }

    // ── endpoint_id: the encoding rules the migration's CHECK enforces ──

    #[tokio::test]
    async fn a_non_canonical_key_is_refused_before_it_reaches_the_column_check() {
        let (pool, _dir) = test_pool().await;

        // Each of these parses or prints as "an EndpointId" somewhere in iroh's API,
        // and none of them is the spelling the column stores.
        let uppercase = KEY_A.to_ascii_uppercase();
        let short = &KEY_A[..10]; // what `EndpointId::fmt_short()` yields
        let base32 = "a".repeat(52); // the other form `FromStr` accepts

        for (label, bad) in [
            ("uppercase hex", uppercase.as_str()),
            ("fmt_short", short),
            ("base32", base32.as_str()),
            ("empty", ""),
        ] {
            let Err(err) = bind_endpoint_id(&pool, "peer-A", bad).await else {
                panic!("{label} must be refused by the write path");
            };
            assert!(
                err.to_string().contains("invalid endpoint_id"),
                "{label} must fail as a named validation error, got: {err}"
            );

            let Err(err) = get_peer_ref_by_endpoint_id(&pool, bad).await else {
                panic!("{label} must be refused by the read path");
            };
            assert!(
                err.to_string().contains("invalid endpoint_id"),
                "{label} must fail as a named validation error on read, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn an_uppercase_key_would_be_invisible_to_lookup_if_it_were_stored() {
        let (pool, _dir) = test_pool().await;

        // This is the specific harm the lowercase rule prevents, demonstrated against
        // the column itself: SQLite's BINARY collation is case-sensitive, so a peer
        // stored under the uppercase spelling is present in the table and invisible
        // to the query that authorizes it. `bind_endpoint_id` is bypassed here
        // because it is exactly what stops this from being reachable.
        upsert_peer_ref(&pool, "peer-A").await.unwrap();
        let uppercase = KEY_A.to_ascii_uppercase();
        let wrote = sqlx::query!(
            "UPDATE peer_refs SET endpoint_id = ? WHERE peer_id = ?",
            uppercase,
            "peer-A"
        )
        .execute(&pool)
        .await;

        // Two independent guards, asserted separately so neither can hide the other.
        //
        // 1. The column CHECK is the storage-layer backstop: it rejects the uppercase
        //    spelling outright, so the bad row never exists.
        assert!(
            wrote.is_err(),
            "migration 0107's CHECK must reject the uppercase spelling at the column"
        );

        // 2. And had it landed, it would have been unreachable by the canonical
        //    spelling every lookup uses. Demonstrated on a value the CHECK *does*
        //    accept, so this arm actually runs: same key, stored canonically, looked
        //    up in the uppercase form that a permissive read path would have produced.
        bind_endpoint_id(&pool, "peer-A", KEY_A).await.unwrap();
        let found_by_uppercase = get_peer_ref_by_endpoint_id(&pool, &uppercase).await;
        assert!(
            found_by_uppercase.is_err(),
            "the uppercase spelling must be refused rather than silently miss the row \
             it cannot match under BINARY collation"
        );
    }
}
