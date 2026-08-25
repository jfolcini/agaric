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
    ///
    /// This is the **puller's** clock: it advances only when WE pulled this
    /// peer's state into our store (#610 — a streamer that advanced it would
    /// make itself permanently not-overdue and starve the reverse direction).
    /// A device that only ever succeeds as responder therefore leaves it
    /// `None` forever; [`Self::streamed_at`] is the other half of the picture.
    pub synced_at: Option<i64>,
    /// Most recent session in which we STREAMED our state to this peer, in
    /// milliseconds since the UNIX epoch (UTC); `None` = never streamed
    /// (migration 0111, #4084).
    ///
    /// The counterpart to [`Self::synced_at`], recording the direction that
    /// column deliberately cannot. Together they answer "when did anything
    /// last move between us" — the device list renders
    /// `MAX(synced_at, streamed_at)` so a responder-only peer stops reading as
    /// "never synced".
    ///
    /// The scheduler (`peers_due_for_resync`) still reads `synced_at` **only**:
    /// treating a recent stream as "not due" would reintroduce exactly the
    /// #610 starvation this column exists to avoid.
    // Not a doc comment on purpose: specta exports `///` into
    // `src/lib/bindings.ts`, and the `_ms`-suffix rationale below is a DB
    // convention note with nothing to say to a TypeScript consumer of
    // `PeerRef`. The full reasoning lives in `migrations/AGENTS.md` under
    // "Known exceptions"; the short version is that this column is always
    // read paired with `synced_at`, so suffixing one half would imply the
    // encodings differ.
    pub streamed_at: Option<i64>,
    pub reset_count: i64,
    /// Most recent protocol reset, in milliseconds since the UNIX epoch
    /// (UTC); `None` = never reset. #109 Phase 2: was an RFC 3339 string.
    pub last_reset_at: Option<i64>,
    /// SHA-256 hex of the peer's TLS certificate, observed during pairing.
    /// Used for certificate pinning on reconnection.
    pub cert_hash: Option<String>,
    /// The USER'S name for this peer (e.g. "Javier's Phone") — a local display
    /// override, typed into the rename dialog on THIS device and authoritative
    /// nowhere else.
    ///
    /// Written only by the `update_peer_name` command
    /// ([`update_device_name`]). Nothing on the wire may touch it: a peer that
    /// could overwrite it would silently undo a rename the user performed,
    /// which is the one outcome a rename feature must never produce. The name
    /// the peer supplies lands in [`Self::remote_device_name`] instead.
    ///
    /// `None` means the user has not renamed this peer — NOT that the peer has
    /// no name. Read it through the display precedence
    /// (`device_name` → `remote_device_name` → truncated `peer_id`), never on
    /// its own.
    pub device_name: Option<String>,
    /// The name the peer told us it is called, over the wire (migration 0114,
    /// #4298) — a CLAIM by an untrusted remote, not a fact about it.
    ///
    /// Carried in `HeadExchange` and refreshed on every session in which this
    /// device is the responder AND authenticated the peer as this row's id — a
    /// bound peer resolved through the key its handshake proved, or a joiner the
    /// TOFU bind just accepted. So a peer renamed on its own machine propagates
    /// that name here on its next dial, and a session keyed on a device id it
    /// merely *claimed* writes nothing here (see the responder's name block and
    /// #4230). It is stripped of control and bidi-format characters and clamped
    /// to 64 characters on send AND again on receive, and empty/whitespace-only
    /// is normalised to `None`; a peer can put anything in this field, so the
    /// receiving side re-applies every bound rather than trusting the sender to
    /// have applied it.
    ///
    /// Strictly lower precedence than [`Self::device_name`]: it is what the UI
    /// falls back to when the user has set no override, which is what makes
    /// clearing an override fall back to the peer's own name rather than to a
    /// truncated UUID.
    ///
    /// `None` is normal *as a starting state* — a peer on a build predating
    /// #4298 sends no name, and a device whose hostname could not be read sends
    /// none either. It is not a state a row goes back to: the responder
    /// short-circuits on a missing name rather than recording its absence (`if
    /// let Some(name) = offered_device_name`), so once a name has been recorded
    /// the row keeps it until the peer supplies a different one. That is the
    /// wanted behaviour — a peer that downgrades, or boots once without a
    /// readable hostname, must not blank a device list back to hex — and it
    /// means [`update_remote_device_name`]'s `None` arm has no production
    /// caller.
    pub remote_device_name: Option<String>,
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
    /// When this peer first told us, on the wire, that it holds no pairing
    /// with this device — milliseconds since the UNIX epoch (UTC), or `None`
    /// when it has not (migration 0113, #4297).
    ///
    /// Set only for a peer we still hold a row for: the other device unpaired
    /// us and there is no wire message that says so, so the only evidence is
    /// its `Rejection::Unpaired` refusal of every dial we make. Non-`None`
    /// therefore means "this pairing is dead and only a re-pair will revive
    /// it", and the device list must stop rendering the row as healthy —
    /// in particular it must stop showing a `MAX(synced_at, streamed_at)`
    /// relative time that keeps counting from the last session that worked.
    ///
    /// It is the FIRST refusal of the streak, not the latest, and any session
    /// that actually moves data in either direction clears it (see
    /// [`mark_unpaired_by_peer`] and [`update_on_sync_in_tx`]).
    pub unpaired_by_peer_at_ms: Option<i64>,
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
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at, streamed_at,
                  reset_count as "reset_count!: i64", last_reset_at, cert_hash,
                  device_name, remote_device_name, last_address, endpoint_id,
                  unpaired_by_peer_at_ms
           FROM peer_refs WHERE peer_id = ?"#,
        peer_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// The canonical on-disk spelling of an `EndpointId`: exactly 64 lowercase hex
/// characters **that decode to a real ed25519 public key**.
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
///
/// # Why the spelling check is not enough on its own (#3561)
///
/// An `EndpointId` is not an arbitrary 32-byte value. It is a *compressed Edwards
/// point*: `FromStr` decodes the hex and hands the bytes to `VerifyingKey::from_bytes`,
/// which decompresses them. Roughly half of all 32-byte values have no `x` on the
/// curve and fail — `"deadbeef".repeat(8)` is 64 lowercase hex characters and is one of
/// them.
///
/// So the shape rules above, and the column CHECK that restates them, together admit
/// values that *no* `EndpointId::from_str` will ever accept, and every consumer of this
/// column parses it back into a key (`peer_lock_key_from_stored`, dial targeting). A
/// row like that is not merely odd, it is a peer that can be stored and then never
/// dialled or locked. Parsing here is what makes the column's declared meaning — "an
/// endpoint id" — and its actual contents the same statement.
///
/// SQLite cannot express this: a CHECK constraint has no curve arithmetic, so the
/// migration can only ever restate the hex shape. The predicate has to live in Rust,
/// and it has to be iroh's own parser rather than a re-derivation of it, so the store's
/// notion of a valid key cannot drift from the transport's.
///
/// # What this does *not* claim
///
/// This is a check at the door, not a type. A direct `UPDATE peer_refs SET
/// endpoint_id = …` still reaches the column, and rows written before this landed were
/// never subject to it. That is deliberate and is why the read side stays tolerant:
/// [`get_peer_ref`] and [`list_peer_refs`] hand the column back verbatim and never
/// validate a row on the way out, so tightening the door cannot make already-stored
/// data unreadable. The consumer that needs a key still parses and still reports its
/// own failure (#3550).
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
    // The shape check has already fixed the encoding, so this adds exactly one thing:
    // that the 32 bytes are a decompressible point. The two are not redundant and the
    // order matters — `FromStr` alone would accept the 52-char base32 spelling and the
    // uppercase hex one, both of which store fine and then never match a lookup.
    if let Err(e) = endpoint_id.parse::<iroh_base::EndpointId>() {
        return Err(AppError::validation(format!(
            "invalid endpoint_id: {endpoint_id:?} is 64 lowercase hex characters but is \
             not a valid ed25519 public key, so no EndpointId will ever parse it: {e}"
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
/// # Why it agrees with `list_peer_refs` about the empty peer id
///
/// [`list_peer_refs`] — which is the device list, unpair, and the initiator's pinned-key
/// check — has always carried `WHERE peer_id != ''`. Without the same predicate here the
/// two queries disagree about what a row *means*: a row whose `peer_id` is `''` would be
/// invisible to everything a user can act on while still resolving at the responder's
/// S-1 gate, and resolving there is what makes the #855 passphrase proof unnecessary.
/// A row nobody can see must not be a row that authorizes a session. The predicate is
/// repeated rather than assumed because the two queries have to agree by construction,
/// not by every write path being careful.
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
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at, streamed_at,
                  reset_count as "reset_count!: i64", last_reset_at, cert_hash,
                  device_name, remote_device_name, last_address, endpoint_id,
                  unpaired_by_peer_at_ms
           FROM peer_refs WHERE endpoint_id = ? AND peer_id != ''"#,
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
/// # Why the empty `peer_id` is refused as well as the malformed key
///
/// This validated only the key, on the reasonable-looking assumption that the caller
/// knows who it is binding. It does not: the device id reaching here comes from the
/// peer's mDNS TXT record or from its advertised heads, both of which are claims, and
/// `""` is a value either can carry. The row that would result is the one
/// [`get_peer_ref_by_endpoint_id`] and [`list_peer_refs`] now agree to hide — so
/// refusing to write it and refusing to read it are the same rule stated on both sides
/// of the table, and neither is load-bearing alone.
///
/// # Errors
/// If `peer_id` is empty, if `endpoint_id` is not the canonical form, if it is already
/// bound to a different peer, or if the write fails.
pub async fn bind_endpoint_id(
    pool: &SqlitePool,
    peer_id: &str,
    endpoint_id: &str,
) -> Result<(), AppError> {
    validate_endpoint_id(endpoint_id)?;
    if peer_id.is_empty() {
        return Err(AppError::validation(
            "invalid peer_id: refusing to bind an endpoint id to the empty device id, \
             which every peer-facing query hides"
                .to_owned(),
        ));
    }

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
        r#"SELECT peer_id, last_hash, last_sent_hash, synced_at, streamed_at,
                  reset_count as "reset_count!: i64", last_reset_at, cert_hash,
                  device_name, remote_device_name, last_address, endpoint_id,
                  unpaired_by_peer_at_ms
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
    // #1602 — never persist a TOFU pin that isn't exactly 64 chars of hex (a
    // SHA-256 hex digest). The same shape check ran on the read side, so a
    // value this column accepts is a value the pin comparison can use.
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
/// 1. `sync_protocol::session_state_machine`'s `record_pull_in_tx`
///    passes the `""` literal on every pull, because no per-peer
///    sent-hash delta is tracked under the loro-vv send path (#490 M1).
///    It used to forward a `SyncOrchestrator.last_sent_hash` field that
///    production never assigned; #4084 deleted the field and inlined the
///    sentinel it always produced.
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
        // #4297: a session that pulled from this peer is proof it still holds
        // a pairing with us, so it disproves any recorded `Unpaired` refusal.
        // Cleared in the SAME statement rather than a second one so the
        // "we synced" and "we are still paired" facts cannot disagree after a
        // crash between two writes.
        "UPDATE peer_refs SET last_hash = ?, last_sent_hash = ?, synced_at = ?,
                unpaired_by_peer_at_ms = NULL
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
        // #4297: a session that pulled from this peer is proof it still holds
        // a pairing with us, so it disproves any recorded `Unpaired` refusal.
        // Cleared in the SAME statement rather than a second one so the
        // "we synced" and "we are still paired" facts cannot disagree after a
        // crash between two writes.
        "UPDATE peer_refs SET last_hash = ?, last_sent_hash = ?, synced_at = ?,
                unpaired_by_peer_at_ms = NULL
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

/// Record that we STREAMED our state to a peer this session (#4084).
///
/// The mirror of [`update_on_sync_in_tx`] for the direction that column
/// deliberately cannot record. Stamps `streamed_at` and **nothing else** —
/// in particular not `synced_at`, whose "we pulled from them" meaning the
/// scheduler depends on (#610: a streamer that refreshed `synced_at` would
/// never find the peer overdue and would starve the reverse direction).
///
/// Composes inside the streamer's existing `BEGIN IMMEDIATE` transaction so the
/// ensure-row + stamp pair commits atomically, exactly like the puller's
/// bookkeeping. Only in-transaction because that is the only call shape the
/// orchestrator needs; there is no pool variant to keep un-exercised.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist after the upsert
/// (only possible if the caller skipped [`upsert_peer_ref_in_tx`]).
pub async fn update_on_stream_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    let result = sqlx::query!(
        // #4297: cleared here for the same reason as in `update_on_sync_in_tx`
        // — a peer that just pulled from us demonstrably still holds a pairing
        // with this device, in the one direction `synced_at` cannot record.
        "UPDATE peer_refs SET streamed_at = ?, unpaired_by_peer_at_ms = NULL
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

/// Record that this peer refused our dial because **it** holds no pairing with
/// this device (#4297) — the durable half of an unpair the other side
/// performed and never told us about.
///
/// Returns `true` when the row moved from "not flagged" to "flagged", i.e. this
/// is the first refusal of a streak, and `false` when the row was already
/// flagged **or does not exist**.
///
/// # Why `WHERE … IS NULL` and not a plain stamp
///
/// The refusal repeats on every resync tick, forever, and the useful fact is
/// *since when*, not *most recently* — those are the same fact once the streak
/// starts, and re-stamping would be one write per peer per tick that told the
/// user nothing new. Making the write conditional also makes the return value
/// meaningful: the caller can log the transition once instead of every cycle.
///
/// # Why a missing row is `false` and not [`AppError::NotFound`]
///
/// This is the sibling of the sync-progress writers, but its precondition is
/// the opposite of theirs. They run after a session that has already proved the
/// row exists, so a missing row there is a bug worth an error. This runs on a
/// *refusal*, and the refusal a stranger sends is indistinguishable on the wire
/// from the one an ex-partner sends — the whole difference is whether we hold a
/// row. `WHERE peer_id = ?` is therefore the discriminator, not a lookup that
/// can fail: a joiner mid-pairing dials every discovered device (#3502/#3505)
/// and is refused by each, and none of that is an error, an event, or anything
/// a user should see. The caller checks the loaded peer list as well, so this
/// is the second of two agreeing guards rather than the only one.
pub async fn mark_unpaired_by_peer(pool: &SqlitePool, peer_id: &str) -> Result<bool, AppError> {
    let now = crate::db::now_ms();
    let result = sqlx::query!(
        "UPDATE peer_refs SET unpaired_by_peer_at_ms = ?
         WHERE peer_id = ? AND unpaired_by_peer_at_ms IS NULL",
        now,
        peer_id,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Clear the #4297 "this peer says we are not paired" flag from **every** row.
///
/// The pairing-act counterpart to the per-session clears folded into
/// [`update_on_sync_in_tx`] and [`update_on_stream_in_tx`], and it clears every
/// peer for the same reason `SyncScheduler::clear_backoff` does (#3547): the
/// user performing a pairing act is new information about the whole device
/// list, and the frontend has no peer id to scope it by anyway — the pairing
/// flow carries a passphrase, and which peer it resolves to is only known once
/// the first authenticated connection lands.
///
/// The failure direction is safe. Clearing a flag that was still true costs one
/// resync tick: the peer refuses the next dial and
/// [`mark_unpaired_by_peer`] records it again, with a fresh — and now honest —
/// timestamp. Leaving a stale flag standing after a successful re-pair would
/// instead tell the user to fix something they just fixed.
///
/// Returns the number of rows actually cleared, so the caller can log the act
/// only when it changed something.
pub async fn clear_unpaired_by_peer_all(pool: &SqlitePool) -> Result<u64, AppError> {
    let result = sqlx::query!(
        "UPDATE peer_refs SET unpaired_by_peer_at_ms = NULL
         WHERE unpaired_by_peer_at_ms IS NOT NULL",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
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

/// Update the USER'S display override for a peer ([`PeerRef::device_name`]).
///
/// The local half of the #4298 name pair, and the only writer of that column.
/// Passing `None` clears the override, which — since 0114 — falls back to the
/// name the peer supplied over the wire ([`update_remote_device_name`]) rather
/// than to a truncated peer id.
///
/// Returns [`AppError::NotFound`] if `peer_id` does not exist: the caller is a
/// user acting on a row they can see, so a missing row is a real error here (in
/// deliberate contrast to [`update_remote_device_name`], which is driven by an
/// unauthenticated wire claim).
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

/// Record the name a peer told us it is called ([`PeerRef::remote_device_name`],
/// migration 0114, #4298).
///
/// Returns `true` when the stored value actually changed, `false` when it was
/// already exactly this — or when no row exists for `peer_id`.
///
/// # `None` is expressible here and unreachable from production
///
/// The parameter is `Option<&str>` because that is the column's type and a
/// setter that could not express the column's full range would be the odd one
/// out among its neighbours. But the sole production caller — the responder's
/// post-bind name block — reaches this only inside `if let Some(name) =
/// offered_device_name`, so it never passes `None`. A peer that stops sending a
/// name (an older build, or a boot where the hostname could not be read) leaves
/// whatever it last said standing.
///
/// That is deliberate, not an oversight to be closed: the alternative is that
/// one downgraded session blanks a device list back to truncated UUIDs, and a
/// name that is a session stale is worth more to a user than no name at all.
/// The `None` arm stays exercised by the store tests below, which is where the
/// clearing behaviour is pinned in case a caller ever wants it.
///
/// # Why unchanged is a no-op rather than an idempotent write
///
/// A peer re-advertises its name on every session, forever. The overwhelmingly
/// common case is that it has not changed, so the honest shape is a read
/// followed by a write only on a transition: otherwise this is one `UPDATE` per
/// peer per session that records nothing new. Making it conditional also makes
/// the return value meaningful — the caller logs a rename once, instead of on
/// every tick.
///
/// # Why a missing row is `false` and not [`AppError::NotFound`]
///
/// Same reasoning as [`mark_unpaired_by_peer`], for the same reason: the input
/// is an unauthenticated claim from the wire, and "we hold no row for this
/// device" is the normal answer for a stranger — a joiner mid-pairing dials
/// every discovered device (#3502/#3505). `WHERE peer_id = ?` matching nothing
/// is the discriminator, not a lookup that failed.
///
/// # What this does NOT touch
///
/// [`PeerRef::device_name`]. The user's override outranks the peer's claim and
/// is never written from here; that separation is the whole point of the two
/// columns (see the field docs).
pub async fn update_remote_device_name(
    pool: &SqlitePool,
    peer_id: &str,
    remote_device_name: Option<&str>,
) -> Result<bool, AppError> {
    let current: Option<Option<String>> = sqlx::query_scalar!(
        "SELECT remote_device_name FROM peer_refs WHERE peer_id = ?",
        peer_id,
    )
    .fetch_optional(pool)
    .await?;

    // No row: a stranger, or a peer we never bound. Nothing to record.
    let Some(current) = current else {
        return Ok(false);
    };
    if current.as_deref() == remote_device_name {
        return Ok(false);
    }

    let result = sqlx::query!(
        "UPDATE peer_refs SET remote_device_name = ? WHERE peer_id = ?",
        remote_device_name,
        peer_id,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
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

// ---------------------------------------------------------------------------
// This device's own name (#4298)
// ---------------------------------------------------------------------------

/// `app_settings` key holding THIS device's own name — the value advertised to
/// peers in `HeadExchange` and stored by each of them as
/// [`PeerRef::remote_device_name`] (#4298).
///
/// # Why `app_settings` and not a constant the sync layer reads directly
///
/// The name is the OS hostname, and the only cross-platform way to obtain it in
/// this app is `tauri_plugin_os::hostname()`, which lives in the Tauri app
/// crate. `agaric-sync` must not gain a `tauri` dependency for one string, so
/// the app writes the value here at boot and the sync layer reads it back off
/// the pool it already holds. That is the same shape the pending-pairing marker
/// uses to get a value from a command handler to the daemon
/// ([`PENDING_PAIRING_KEY`]) — a key/value row is the established seam between
/// the two.
///
/// It is deliberately NOT part of `peer_refs`: that table is one row per
/// *remote* device, and this is a fact about the local one.
const LOCAL_DEVICE_NAME_KEY: &str = "sync.local_device_name";

/// Record this device's own name, to be advertised to peers (#4298).
///
/// Written at every app boot from the OS hostname rather than once on first
/// run: a hostname is user-editable and does change (a laptop renamed in system
/// settings, a phone renamed in Android's about screen), and a name pinned at
/// first launch would be wrong on every device that has ever been renamed, with
/// no path back — nothing else would ever rewrite it. Re-reading it each boot
/// costs one `UPSERT` per launch and makes a rename propagate on the next sync.
///
/// The value is stored verbatim; the wire clamp
/// (`sync_protocol::types::clamp_device_name`) is applied on send, where the
/// bound belongs, so this row keeps saying what the OS actually reports.
pub async fn set_local_device_name(pool: &SqlitePool, device_name: &str) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        LOCAL_DEVICE_NAME_KEY,
        device_name,
        now,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Read this device's own name for advertisement in `HeadExchange` (#4298).
///
/// `None` when the marker is absent (a boot in which the hostname could not be
/// read, or a headless test harness that never wrote one) or empty. Both mean
/// the same thing to the caller — advertise no name — so they are not
/// distinguished, and a peer receiving no name simply keeps whatever it already
/// had.
pub async fn get_local_device_name(pool: &SqlitePool) -> Result<Option<String>, AppError> {
    let value: Option<String> = sqlx::query_scalar!(
        "SELECT value FROM app_settings WHERE key = ?",
        LOCAL_DEVICE_NAME_KEY,
    )
    .fetch_optional(pool)
    .await?;
    Ok(value.filter(|v| !v.trim().is_empty()))
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
        assert!(
            peer.streamed_at.is_none(),
            "streamed_at must default to NULL"
        );
        assert_eq!(peer.reset_count, 0, "reset_count must default to 0");
        assert!(
            peer.last_reset_at.is_none(),
            "last_reset_at must default to NULL"
        );
    }

    // ── update_on_stream_in_tx (#4084) ──────────────────────────────────

    /// Happy path: the streamer's stamp advances `streamed_at` and touches
    /// **nothing else** — in particular not `synced_at`, whose "we pulled from
    /// them" meaning `peers_due_for_resync` depends on (#610).
    #[tokio::test]
    async fn update_on_stream_stamps_streamed_at_without_touching_synced_at_4084() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-stream").await.unwrap();

        let before = crate::db::now_ms();
        let mut tx = pool.begin().await.unwrap();
        update_on_stream_in_tx(&mut tx, "peer-stream")
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let after = crate::db::now_ms();

        let peer = get_peer_ref(&pool, "peer-stream")
            .await
            .unwrap()
            .expect("peer-stream must exist");
        let streamed = peer
            .streamed_at
            .expect("streamed_at must be stamped by update_on_stream_in_tx");
        assert!(
            (before..=after).contains(&streamed),
            "streamed_at must be epoch-ms taken during the call: {streamed} not in \
             {before}..={after}"
        );
        assert!(
            peer.synced_at.is_none(),
            "#610: recording a STREAM must never advance synced_at — the scheduler \
             measures staleness from it, and refreshing it on every inbound session \
             starves the reverse direction"
        );
        assert!(
            peer.last_hash.is_none() && peer.last_sent_hash.is_none(),
            "the stream stamp writes one column; the pull path owns the hashes"
        );
    }

    /// A pull that already advanced `synced_at` and a later stream keep their
    /// own columns: the two directions are recorded independently, which is
    /// the whole point of the column existing separately.
    #[tokio::test]
    async fn stream_and_sync_stamps_are_independent_4084() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-both").await.unwrap();
        update_on_sync(&pool, "peer-both", "h-recv", "")
            .await
            .unwrap();

        let mut tx = pool.begin().await.unwrap();
        update_on_stream_in_tx(&mut tx, "peer-both").await.unwrap();
        tx.commit().await.unwrap();

        let peer = get_peer_ref(&pool, "peer-both").await.unwrap().unwrap();
        assert!(
            peer.synced_at.is_some(),
            "the earlier pull's synced_at must survive a later stream stamp"
        );
        assert!(peer.streamed_at.is_some(), "and the stream stamp lands too");
        assert_eq!(
            peer.last_hash.as_deref(),
            Some("h-recv"),
            "the stream stamp must not clobber the pull's frontier"
        );
    }

    /// Error path: stamping a peer that has no row is a caller bug (the
    /// orchestrator upserts first inside the same transaction). Report it
    /// rather than silently writing nothing, mirroring `update_on_sync_in_tx`.
    #[tokio::test]
    async fn update_on_stream_missing_peer_is_not_found_4084() {
        let (pool, _dir) = test_pool().await;

        let mut tx = pool.begin().await.unwrap();
        let err = update_on_stream_in_tx(&mut tx, "no-such-peer")
            .await
            .expect_err("stamping a nonexistent peer must not silently succeed");
        assert!(
            matches!(err, AppError::NotFound(ref m) if m.contains("no-such-peer")),
            "expected NotFound naming the peer, got {err:?}"
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
        // #1602 — the guard uses `is_ascii_hexdigit`, which accepts either
        // case, so an uppercase 64-char hex pin must upsert cleanly.
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
        // an AppError::Validation, and the row must not be written at all.
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
    //
    // Since #3561 they must also decode to real curve points, which both of these
    // happen to do — a coin flip per constant, checked, not assumed:
    // `KEY_A_IS_A_REAL_KEY` below fails loudly if either ever stops being one, so a
    // future edit to these literals cannot quietly turn the bind tests into tests of
    // the rejection path.
    const KEY_A: &str = "aa11bb22cc33dd44ee55ff6607788990a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const KEY_B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// The fixtures above are only usable as "a key that binds" if they really parse.
    #[test]
    fn the_fixture_keys_are_real_endpoint_ids() {
        for (label, key) in [("KEY_A", KEY_A), ("KEY_B", KEY_B)] {
            assert!(
                validate_endpoint_id(key).is_ok(),
                "{label} must be a bindable EndpointId, or every test that binds it is \
                 secretly testing the rejection path"
            );
        }
    }

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

    // ── endpoint_id: the peer id has to be a peer ───────────────────────

    /// The write side of "a row nobody can see must not be a row that authorizes a
    /// session".
    ///
    /// `""` is not a hypothetical: the device id reaching `bind_endpoint_id` comes from
    /// an mDNS TXT record or from the peer's advertised heads, and both are claims.
    #[tokio::test]
    async fn binding_a_key_to_the_empty_device_id_is_refused() {
        let (pool, _dir) = test_pool().await;

        let err = bind_endpoint_id(&pool, "", KEY_A)
            .await
            .expect_err("the empty device id must be refused by the write path");
        assert!(
            err.to_string().contains("invalid peer_id"),
            "the refusal must be a named validation error, got: {err}"
        );

        // And it refused before writing, not after.
        assert!(
            get_peer_ref(&pool, "").await.unwrap().is_none(),
            "the refused bind must not have inserted a row"
        );
    }

    /// The read side of the same rule, demonstrated on the row `bind_endpoint_id` now
    /// refuses to create — because the point of the read guard is that it does not
    /// depend on the write guard having held. (Same reasoning as
    /// `a_key_bound_to_two_peers_is_refused_rather_than_resolved`: the schema still
    /// permits the state.)
    ///
    /// Before this, `list_peer_refs` (`WHERE peer_id != ''`) and
    /// `get_peer_ref_by_endpoint_id` (no such filter) disagreed about what this row
    /// means: invisible to the device list and to unpair, and yet the thing the
    /// responder's S-1 gate resolves the authenticated key to — which is what makes the
    /// #855 passphrase proof unnecessary for the rest of that session.
    #[tokio::test]
    async fn a_row_with_no_device_id_is_invisible_to_the_lookup_that_authorizes_it() {
        let (pool, _dir) = test_pool().await;

        // Reach past `bind_endpoint_id`'s new guard to construct the row a
        // version-skewed peer used to produce.
        upsert_peer_ref(&pool, "").await.unwrap();
        sqlx::query!(
            "UPDATE peer_refs SET endpoint_id = ? WHERE peer_id = ?",
            KEY_A,
            ""
        )
        .execute(&pool)
        .await
        .unwrap();

        // The row is really there — otherwise the assertions below are true for the
        // wrong reason.
        let raw: (i64,) = sqlx::query_as("SELECT count(*) FROM peer_refs WHERE peer_id = ''")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(raw.0, 1, "the fixture must actually have written the row");

        // 1. What the user sees: nothing. This was already true.
        let listed = list_peer_refs(&pool).await.unwrap();
        assert!(
            listed.iter().all(|p| !p.peer_id.is_empty()),
            "list_peer_refs must not surface the nameless row"
        );

        // 2. What the responder's S-1 gate sees must be the same nothing. This is the
        //    half that was missing: the key resolved to a peer the UI cannot show,
        //    cannot unpair, and cannot check `already_bound_elsewhere` against.
        let found = get_peer_ref_by_endpoint_id(&pool, KEY_A).await.unwrap();
        assert!(
            found.is_none(),
            "a row hidden from every peer-facing query must not resolve an \
             authenticated key either, got {found:?}"
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

    // ── endpoint_id: the rule SQL cannot state (#3561) ──────────────────

    /// The gap this closes, stated as the value that used to fall through it.
    ///
    /// `deadbeef…deadbeef` is 64 lowercase hex characters, so the shape rule admits it
    /// and migration 0107's column CHECK admits it. It is nonetheless not a compressed
    /// Edwards point: `EndpointId::from_str` decompresses, finds no `x` for that `y`,
    /// and refuses. Before this, the write path stored it happily and every consumer
    /// that parsed it back — the S-5 lock probe, dial targeting — hit a value the
    /// column had promised was a key.
    ///
    /// The two halves are asserted together on purpose. "the writer rejects it" is
    /// only interesting alongside "the parser also rejects it": if a later iroh made
    /// this value parseable, the second assertion would fail and tell us the first is
    /// now over-strict, rather than leaving a mystery rejection behind.
    #[tokio::test]
    async fn hex_that_is_not_a_curve_point_is_refused_by_the_write_path() {
        let (pool, _dir) = test_pool().await;
        let not_a_point = "deadbeef".repeat(8);

        assert_eq!(
            not_a_point.len(),
            64,
            "the fixture must pass the shape rule"
        );
        assert!(
            not_a_point.parse::<iroh_base::EndpointId>().is_err(),
            "the fixture is only the fixture if iroh still refuses to parse it"
        );

        let Err(err) = bind_endpoint_id(&pool, "peer-A", &not_a_point).await else {
            panic!(
                "64 hex characters that are not an ed25519 public key must not be \
                 bindable — no consumer of this column can ever use the row"
            );
        };
        assert!(
            err.to_string().contains("invalid endpoint_id"),
            "it must fail as the same named validation error as every other bad \
             spelling, got: {err}"
        );

        // And nothing landed: the refusal is before the INSERT, not after it.
        let peer = get_peer_ref(&pool, "peer-A").await.unwrap();
        assert!(
            peer.is_none(),
            "the refused bind must not have inserted a row, got {peer:?}"
        );

        // The read path states the same rule, so a lookup by such a value is a named
        // error rather than an indistinguishable "no such peer".
        let looked_up = get_peer_ref_by_endpoint_id(&pool, &not_a_point).await;
        assert!(
            looked_up.is_err(),
            "the read path must refuse the value the write path refuses"
        );
    }

    /// Tightening the door must not lock anyone out of the room.
    ///
    /// Migration 0107 adds `endpoint_id` as a nullable column with no backfill, so no
    /// row predating this validation can hold a non-key — but a row can still be
    /// written around the API, and the point of a tolerant read path is that it does
    /// not depend on the write guard having held. Whatever is in the column comes back
    /// verbatim; validation happens where a *key* is needed, and the consumer reports
    /// its own failure (#3550).
    #[tokio::test]
    async fn a_row_holding_unparseable_hex_still_reads_back_verbatim() {
        let (pool, _dir) = test_pool().await;
        let not_a_point = "deadbeef".repeat(8);

        // Planted the only way it can now arise: past the API, as a pre-existing row
        // would have been. The column CHECK accepts it, which is the whole point —
        // SQL cannot tell this apart from a key.
        upsert_peer_ref(&pool, "legacy-peer").await.unwrap();
        sqlx::query!(
            "UPDATE peer_refs SET endpoint_id = ? WHERE peer_id = ?",
            not_a_point,
            "legacy-peer",
        )
        .execute(&pool)
        .await
        .expect("migration 0107's CHECK cannot express curve membership, so this lands");

        let peer = get_peer_ref(&pool, "legacy-peer")
            .await
            .expect("reading a peer must not start failing because of its endpoint_id")
            .expect("legacy-peer must exist");
        assert_eq!(
            peer.endpoint_id.as_deref(),
            Some(not_a_point.as_str()),
            "get_peer_ref must hand the stored value back unchanged"
        );

        let listed = list_peer_refs(&pool)
            .await
            .expect("listing peers must not fail on one unparseable endpoint_id");
        assert_eq!(
            listed
                .iter()
                .find(|p| p.peer_id == "legacy-peer")
                .and_then(|p| p.endpoint_id.as_deref()),
            Some(not_a_point.as_str()),
            "the device list must still show a peer whose stored key is corrupt — \
             hiding it would be how a user loses the ability to unpair it"
        );
    }

    // ── unpaired_by_peer_at_ms (#4297) ──────────────────────────────────

    /// A fresh row starts unflagged, and the first refusal flags it with an
    /// epoch-ms instant taken during the call.
    #[tokio::test]
    async fn mark_unpaired_by_peer_flags_a_bound_peer_4297() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-gone").await.unwrap();

        assert!(
            get_peer_ref(&pool, "peer-gone")
                .await
                .unwrap()
                .expect("peer-gone must exist")
                .unpaired_by_peer_at_ms
                .is_none(),
            "a peer that has never refused us must start unflagged"
        );

        let before = crate::db::now_ms();
        let marked = mark_unpaired_by_peer(&pool, "peer-gone").await.unwrap();
        let after = crate::db::now_ms();
        assert!(
            marked,
            "the first refusal of a streak must report the transition"
        );

        let at = get_peer_ref(&pool, "peer-gone")
            .await
            .unwrap()
            .expect("peer-gone must exist")
            .unpaired_by_peer_at_ms
            .expect("the refusal must be recorded on the row");
        assert!(
            (before..=after).contains(&at),
            "unpaired_by_peer_at_ms must be epoch-ms taken during the call: \
             {at} not in {before}..={after}"
        );
    }

    /// The refusal repeats every resync tick forever. The flag must record the
    /// FIRST one — "since when" — and must not report the transition again, so
    /// the caller can log once instead of once a minute.
    #[tokio::test]
    async fn marking_an_already_flagged_peer_is_a_no_op_and_keeps_the_first_instant_4297() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-gone").await.unwrap();

        assert!(mark_unpaired_by_peer(&pool, "peer-gone").await.unwrap());
        let first = get_peer_ref(&pool, "peer-gone")
            .await
            .unwrap()
            .unwrap()
            .unpaired_by_peer_at_ms
            .expect("first refusal must be recorded");

        // Push the clock forward past ms resolution so a re-stamp would be visible.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        assert!(
            !mark_unpaired_by_peer(&pool, "peer-gone").await.unwrap(),
            "a repeat refusal must not report a transition"
        );
        assert_eq!(
            get_peer_ref(&pool, "peer-gone")
                .await
                .unwrap()
                .unwrap()
                .unpaired_by_peer_at_ms,
            Some(first),
            "the recorded instant is the FIRST refusal, not the latest — re-stamping \
             would be a write per tick that tells the user nothing new"
        );
    }

    /// The guard that keeps this off strangers: an `Unpaired` refusal from a
    /// device we hold no row for writes nothing and creates nothing. A joiner
    /// mid-pairing dials every discovered device and is refused by each
    /// (#3502/#3505); none of that is a dead pairing.
    #[tokio::test]
    async fn marking_a_peer_we_hold_no_row_for_writes_nothing_4297() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-bound").await.unwrap();

        assert!(
            !mark_unpaired_by_peer(&pool, "some-stranger").await.unwrap(),
            "a stranger's refusal must report no transition"
        );
        assert!(
            get_peer_ref(&pool, "some-stranger")
                .await
                .unwrap()
                .is_none(),
            "marking must never CREATE a row — that would put a device the user \
             never paired with into their device list"
        );
        assert!(
            get_peer_ref(&pool, "peer-bound")
                .await
                .unwrap()
                .unwrap()
                .unpaired_by_peer_at_ms
                .is_none(),
            "a stranger's refusal must not splash onto a real peer's row"
        );
    }

    /// A pull disproves the claim: the peer that answered us demonstrably still
    /// holds a pairing, so the flag is cleared in the same statement that
    /// stamps `synced_at`.
    #[tokio::test]
    async fn a_successful_pull_clears_the_unpaired_flag_4297() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-back").await.unwrap();
        assert!(mark_unpaired_by_peer(&pool, "peer-back").await.unwrap());

        update_on_sync(&pool, "peer-back", "hash-in", "")
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "peer-back").await.unwrap().unwrap();
        assert!(
            peer.unpaired_by_peer_at_ms.is_none(),
            "a session that pulled from the peer proves the pairing is alive"
        );
        assert!(
            peer.synced_at.is_some(),
            "the clear must ride on the real progress write, not replace it"
        );

        // …and the in-transaction variant the orchestrator actually uses.
        assert!(mark_unpaired_by_peer(&pool, "peer-back").await.unwrap());
        let mut tx = pool.begin().await.unwrap();
        update_on_sync_in_tx(&mut tx, "peer-back", "hash-in-2", "")
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!(
            get_peer_ref(&pool, "peer-back")
                .await
                .unwrap()
                .unwrap()
                .unpaired_by_peer_at_ms
                .is_none(),
            "update_on_sync_in_tx must clear the flag exactly as the pool variant does"
        );
    }

    /// The other direction (#4084): a peer that pulled from US also proves the
    /// pairing is alive, and `synced_at` deliberately cannot record that.
    #[tokio::test]
    async fn a_successful_stream_clears_the_unpaired_flag_4297() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-streamer").await.unwrap();
        assert!(mark_unpaired_by_peer(&pool, "peer-streamer").await.unwrap());

        let mut tx = pool.begin().await.unwrap();
        update_on_stream_in_tx(&mut tx, "peer-streamer")
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let peer = get_peer_ref(&pool, "peer-streamer").await.unwrap().unwrap();
        assert!(
            peer.unpaired_by_peer_at_ms.is_none(),
            "an inbound session the peer initiated proves it still holds our pairing"
        );
        assert!(
            peer.streamed_at.is_some(),
            "the clear must ride on the stream stamp, not replace it"
        );
        assert!(
            peer.synced_at.is_none(),
            "#610 still holds: the streamer must not advance synced_at"
        );
    }

    /// The pairing-act clear is list-wide (mirroring `clear_backoff`, #3547)
    /// and reports how many rows it actually changed.
    #[tokio::test]
    async fn a_pairing_act_clears_the_flag_on_every_peer_4297() {
        let (pool, _dir) = test_pool().await;
        for id in ["peer-a", "peer-b", "peer-c"] {
            upsert_peer_ref(&pool, id).await.unwrap();
        }
        assert!(mark_unpaired_by_peer(&pool, "peer-a").await.unwrap());
        assert!(mark_unpaired_by_peer(&pool, "peer-b").await.unwrap());

        assert_eq!(
            clear_unpaired_by_peer_all(&pool).await.unwrap(),
            2,
            "only the flagged rows count as cleared"
        );
        for id in ["peer-a", "peer-b", "peer-c"] {
            assert!(
                get_peer_ref(&pool, id)
                    .await
                    .unwrap()
                    .unwrap()
                    .unpaired_by_peer_at_ms
                    .is_none(),
                "{id} must be unflagged after a pairing act"
            );
        }
        assert_eq!(
            clear_unpaired_by_peer_all(&pool).await.unwrap(),
            0,
            "a second pairing act with nothing to clear must report no change"
        );
    }

    /// The column survives a restart, which is the whole reason it is a column
    /// and not an event: `list_peer_refs` is what the device list reads.
    #[tokio::test]
    async fn the_unpaired_flag_is_visible_through_list_peer_refs_4297() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "peer-gone").await.unwrap();
        mark_unpaired_by_peer(&pool, "peer-gone").await.unwrap();

        let listed = list_peer_refs(&pool).await.unwrap();
        assert!(
            listed
                .iter()
                .find(|p| p.peer_id == "peer-gone")
                .expect("peer-gone must be listed")
                .unpaired_by_peer_at_ms
                .is_some(),
            "the device list's own query must carry the flag, or the UI cannot render it"
        );
    }

    // ── remote_device_name / local device name (#4298) ──────────────────

    /// The peer-supplied name is persisted and readable through the query the
    /// device list actually uses.
    #[tokio::test]
    async fn remote_device_name_round_trips_through_list_peer_refs_4298() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "PEER4298").await.unwrap();

        assert!(
            update_remote_device_name(&pool, "PEER4298", Some("javier-thinkpad"))
                .await
                .unwrap(),
            "the first name a peer supplies is a change and must report as one"
        );

        let listed = list_peer_refs(&pool).await.unwrap();
        let peer = listed
            .iter()
            .find(|p| p.peer_id == "PEER4298")
            .expect("PEER4298 must be listed");
        assert_eq!(
            peer.remote_device_name.as_deref(),
            Some("javier-thinkpad"),
            "the device list's own query must carry the peer-supplied name, or the UI \
             cannot fall back to it"
        );
        assert_eq!(
            peer.device_name, None,
            "a peer-supplied name must never populate the user's override column"
        );
    }

    /// A peer re-advertises its name on every session, forever. Re-recording an
    /// unchanged name must not write — otherwise this is one UPDATE per peer per
    /// session that records nothing — and the return value is what lets the
    /// caller log a rename once instead of every tick.
    #[tokio::test]
    async fn recording_an_unchanged_remote_device_name_is_a_no_op_4298() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "PEER4298B").await.unwrap();

        assert!(
            update_remote_device_name(&pool, "PEER4298B", Some("pixel-8"))
                .await
                .unwrap()
        );
        assert!(
            !update_remote_device_name(&pool, "PEER4298B", Some("pixel-8"))
                .await
                .unwrap(),
            "re-recording the same name must report no change"
        );
        assert!(
            update_remote_device_name(&pool, "PEER4298B", Some("pixel-8-pro"))
                .await
                .unwrap(),
            "a peer renamed on its own machine must propagate on its next session"
        );
        // `None` clears the column — a property of this setter, NOT a transition
        // production performs. The responder short-circuits on a missing name
        // (`if let Some(name) = offered_device_name`) precisely so a peer that
        // downgrades, or boots once without a readable hostname, cannot blank a
        // device list back to truncated UUIDs. Pinned here so the arm has a
        // defined meaning if a caller ever does want it.
        assert!(
            update_remote_device_name(&pool, "PEER4298B", None)
                .await
                .unwrap(),
            "passing None must clear the column back to NULL"
        );
        assert!(
            !update_remote_device_name(&pool, "PEER4298B", None)
                .await
                .unwrap(),
            "clearing an already-clear column must report no change"
        );
    }

    /// The input is an unauthenticated claim from the wire and "we hold no row
    /// for this device" is the normal answer for a stranger — a joiner
    /// mid-pairing dials every discovered device (#3502/#3505). That must be
    /// `false`, not an error, exactly as `mark_unpaired_by_peer` decided.
    #[tokio::test]
    async fn a_stranger_supplying_a_name_records_nothing_4298() {
        let (pool, _dir) = test_pool().await;
        assert!(
            !update_remote_device_name(&pool, "NEVER-PAIRED", Some("attacker"))
                .await
                .unwrap(),
            "a peer we hold no row for must record nothing and must not error"
        );
    }

    /// The core of the two-column design: a name arriving from the wire must
    /// never touch the name the user typed. If it could, a peer's next sync
    /// would silently undo a rename — the one outcome a rename feature must not
    /// produce.
    #[tokio::test]
    async fn a_peer_supplied_name_never_overwrites_the_user_override_4298() {
        let (pool, _dir) = test_pool().await;
        upsert_peer_ref(&pool, "PEER4298C").await.unwrap();
        update_device_name(&pool, "PEER4298C", Some("Javier's Phone"))
            .await
            .unwrap();

        update_remote_device_name(&pool, "PEER4298C", Some("pixel-8"))
            .await
            .unwrap();

        let peer = get_peer_ref(&pool, "PEER4298C").await.unwrap().unwrap();
        assert_eq!(
            peer.device_name.as_deref(),
            Some("Javier's Phone"),
            "the user's override must survive a peer advertising its own name"
        );
        assert_eq!(
            peer.remote_device_name.as_deref(),
            Some("pixel-8"),
            "and the peer's claim must still be recorded, beside it"
        );

        // Clearing the override is what reveals the peer's name — the behaviour
        // `update_peer_name`'s doc comment has always claimed and, before 0114,
        // could not deliver, because nothing ever supplied a name.
        update_device_name(&pool, "PEER4298C", None).await.unwrap();
        let peer = get_peer_ref(&pool, "PEER4298C").await.unwrap().unwrap();
        assert_eq!(peer.device_name, None);
        assert_eq!(
            peer.remote_device_name.as_deref(),
            Some("pixel-8"),
            "clearing the override must fall back to the device-supplied value, not to \
             a truncated peer id"
        );
    }

    /// This device's own name round-trips through `app_settings`, and is
    /// overwritten on every boot so a hostname change propagates.
    #[tokio::test]
    async fn local_device_name_round_trips_and_refreshes_4298() {
        let (pool, _dir) = test_pool().await;
        assert_eq!(
            get_local_device_name(&pool).await.unwrap(),
            None,
            "before the app publishes one, there is no local name to advertise"
        );

        set_local_device_name(&pool, "javier-thinkpad")
            .await
            .unwrap();
        assert_eq!(
            get_local_device_name(&pool).await.unwrap().as_deref(),
            Some("javier-thinkpad")
        );

        set_local_device_name(&pool, "javier-framework")
            .await
            .unwrap();
        assert_eq!(
            get_local_device_name(&pool).await.unwrap().as_deref(),
            Some("javier-framework"),
            "the value is refreshed each boot, so a machine renamed in system settings \
             stops advertising its old name"
        );
    }

    /// A blank hostname is not a name. Reading it back as `None` is what keeps a
    /// device whose OS reports nothing from blanking its own row in every peer's
    /// device list.
    #[tokio::test]
    async fn a_blank_local_device_name_reads_as_absent_4298() {
        let (pool, _dir) = test_pool().await;
        set_local_device_name(&pool, "   ").await.unwrap();
        assert_eq!(
            get_local_device_name(&pool).await.unwrap(),
            None,
            "a whitespace-only hostname must read as no name at all"
        );
    }
}
