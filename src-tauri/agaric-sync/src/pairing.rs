//! Sync pairing module — passphrase exchange leg of the device pairing flow.
//!
//! # Place in the pairing flow
//!
//! - **This module (`pairing`)** — pure helpers: EFF wordlist passphrase
//!   generation, QR payload encoding ([`crate::pairing::pairing_qr_payload`];
//!   the TS side parses it, see that function's doc comment), and
//!   [`crate::pairing::pairing_proof`], a domain-separated hash of the
//!   passphrase carried on the wire (#855).
//! - `crate::commands::sync_cmds` — Tauri-IPC orchestration: generates the
//!   QR payload via this module and arms the pending-pairing marker (see
//!   [`agaric_store::peer_refs::set_pending_pairing`]) with
//!   [`crate::pairing::pairing_proof`] of the confirmed passphrase.
//! - [`crate::transport::identity`] — owns the persistent iroh secret key whose
//!   public half is this device's `EndpointId`, the thing a peer pins.
//!
//! There is no application-layer pairing handshake: identity pinning is pure
//! transport-level TOFU. On the first authenticated connection to an unpinned
//! peer, [`agaric_store::peer_refs::bind_endpoint_id`] stores the peer's
//! `EndpointId` — the identity QUIC's own handshake authenticated
//! (`sync_daemon::server` on the responder side,
//! `sync_daemon::session_supervisor` on the initiator side) — and
//! `get_peer_ref_by_endpoint_id` resolves against it on every subsequent
//! connection. A two-device `PairingMessage` exchange
//! existed here previously but was never reachable in production (#3463)
//! and has been removed.
//!
//! Confidentiality and authenticity of the pairing exchange come from the QUIC
//! handshake and the endpoint-id pin, not from a derived session key — there is
//! no application-layer crypto in this module.

use agaric_core::error::AppError;
use agaric_store::peer_refs;
use sqlx::SqlitePool;
use std::sync::{Mutex, MutexGuard};
use tracing::instrument;

use crate::mdns::DiscoveredPeer;
use crate::sync_scheduler::{LocalEndpointAdvert, SyncScheduler};

use rand::seq::IndexedRandom;
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// EFF Large Wordlist (7,776 words for ~12.9 bits per word)
// ---------------------------------------------------------------------------

/// EFF large wordlist parsed once from the embedded text file.
/// Contains exactly 7,776 words sorted alphabetically.
static WORDLIST: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let raw = include_str!("eff_wordlist.txt");
    let words: Vec<&str> = raw.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(
        words.len(),
        7776,
        "EFF wordlist must contain exactly 7776 words"
    );
    words
});

/// Return a reference to the parsed EFF wordlist (7,776 entries).
pub fn wordlist() -> &'static [&'static str] {
    &WORDLIST
}

// ---------------------------------------------------------------------------
// Passphrase Generation
// ---------------------------------------------------------------------------

/// Generate a 4-word passphrase from the EFF large wordlist.
///
/// Entropy: log2(7776^4) ~= 51.7 bits.
pub fn generate_passphrase() -> String {
    let wl = wordlist();
    let mut rng = rand::rng();
    let words: Vec<&str> = (0..4)
        .map(|_| *wl.choose(&mut rng).expect("wordlist is non-empty"))
        .collect();
    words.join(" ")
}

// ---------------------------------------------------------------------------
// QR Code Payload & SVG Generation
// ---------------------------------------------------------------------------

/// Current pairing QR payload schema version — the shape a device that knows
/// where it is reachable emits. Increment whenever the JSON shape changes in a
/// way that would confuse older joiners.
pub const PAIRING_QR_VERSION: u32 = 2;

/// The version a payload carries when this device has no bound endpoint to
/// advertise.
///
/// It is not a lesser v2: it is byte-for-byte the v1 payload, because that is
/// exactly what it is — passphrase only, mDNS owning discovery. Tagging it `2`
/// would promise a joiner fields it does not carry.
pub const PAIRING_QR_VERSION_PASSPHRASE_ONLY: u32 = 1;

/// How many address candidates the QR will carry (#4037).
///
/// `ip_addrs()` is a `Vec` with no bound the user controls, and the QR is read
/// by a phone camera out of a 200 px box, so payload bytes are a scannability
/// budget. This is the `.take()` that keeps an unbounded list out of it.
///
/// Two is not a measured cliff. Measured, a third candidate costs no QR version
/// (two 241 B/v12, three 260 B/v12) — the earlier "last rung before density
/// degrades" reason died when `device_id` joined the payload. Two is simply what
/// a multi-homed host has, and dropping a candidate only ever costs a race,
/// never a pair: mDNS remains the discovery path and the fallback.
pub const MAX_QR_ADDR_CANDIDATES: usize = 2;

/// Build the JSON payload for a pairing QR code.
///
/// With `advert`, returns the v2 shape:
/// `{"v":2,"passphrase":"w1 w2 w3 w4","device_id":"…","endpoint_id":"…","addrs":["ip:port",…]}`.
/// Without it, the v1 shape: `{"v":1,"passphrase":"w1 w2 w3 w4"}`.
///
/// The leading `"v"` field tags the schema version so the joining
/// device fails fast on a payload it cannot parse — a stale QR or an
/// unrecognised future shape — rather than silently dropping fields.
///
/// # Why the addresses are here (#4037)
///
/// They are additive, and mDNS is untouched: it remains the re-discovery path
/// and the staleness fallback, because a DHCP lease that turns over between the
/// QR being rendered and being scanned invalidates every candidate in it. What
/// they buy is the *first* pair on a network where multicast does not work —
/// an AP with client isolation, a guest VLAN, an Android build whose background
/// firewall chain drops the packets. Without them that pair cannot happen at
/// all; with them the joiner has a path to race.
///
/// `device_id` is here because a dial is only half of what the joiner needs.
/// The session is keyed on the peer's device id — it is the `peer_refs.peer_id`
/// the joiner's TOFU bind writes and the `expected_remote_id` the orchestrator
/// is constructed with — and an mDNS-discovered peer supplies it in its TXT
/// record. A QR-dialled peer has no announcement to read one from, so without
/// this field the joiner would have to invent one, and `bind_endpoint_id`
/// refuses to be re-pointed afterwards: the invented id would be permanent, and
/// the real one could never bind.
///
/// The `endpoint_id` alone would not do it. A dial that names only a key, on a
/// LAN-only endpoint with no relay and no discovery service, has no path to try
/// and fails in well under a millisecond — measured, and pinned by
/// `transport::endpoint::tests::a_dial_naming_only_an_endpoint_id_fails_fast_instead_of_hanging`.
/// That measurement is also why a stale candidate is cheap: it costs the joiner
/// microseconds before the mDNS fallback gets its turn, not a dial budget.
///
/// This function stays a pure function of its arguments — it never touches an
/// `iroh::Endpoint`. The caller resolves the coordinates; see
/// [`start_pairing_armed`] for why they cannot simply be read at the call site.
///
/// This payload is parsed on the TS side
/// (`src/components/dialogs/PairingDialog.tsx`, `JSON.parse(data)`), not
/// in Rust — there is no `parse_pairing_qr` counterpart here. The two
/// were never equivalent: the TS parser also accepts a bare non-JSON
/// string as a plain passphrase and does not check `v`, so do not assume
/// a Rust round-trip of this exact shape exists.
pub fn pairing_qr_payload(passphrase: &str, advert: Option<&LocalEndpointAdvert>) -> String {
    let Some(advert) = advert else {
        return serde_json::json!({
            "v": PAIRING_QR_VERSION_PASSPHRASE_ONLY,
            "passphrase": passphrase,
        })
        .to_string();
    };
    serde_json::json!({
        "v": PAIRING_QR_VERSION,
        "passphrase": passphrase,
        "device_id": advert.device_id,
        "endpoint_id": advert.endpoint_id,
        "addrs": advert
            .addrs
            .iter()
            .take(MAX_QR_ADDR_CANDIDATES)
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>(),
    })
    .to_string()
}

/// The peer a joiner's camera read out of a v2 pairing QR (#4037).
///
/// The wire shape of [`pairing_qr_payload`]'s v2 fields, carried back across
/// the IPC by `PairingDialog` so the daemon can dial the host it scanned. Every
/// field is a string because that is what came off a camera: nothing here has
/// been parsed or trusted yet, and [`Self::into_discovered`] is where it is.
#[derive(Debug, serde::Deserialize, specta::Type)]
pub struct ScannedPeerCandidate {
    pub device_id: String,
    pub endpoint_id: String,
    pub addrs: Vec<String>,
}

impl ScannedPeerCandidate {
    /// Turn a scanned candidate into the same [`DiscoveredPeer`] an mDNS
    /// announcement produces, or `None` if it is not dialable.
    ///
    /// # Why every field is refused rather than repaired
    ///
    /// This is the trust boundary: the values came off a camera, and the
    /// device id among them becomes a `peer_refs.peer_id` that
    /// `bind_endpoint_id` will not later re-point. So the device id goes
    /// through [`crate::sync_protocol::accept_stated_device_id`] — the same
    /// normaliser the wire's `sender_device_id` takes, for the same reasons
    /// (#4380/#4451) — which rejects rather than truncates, and a candidate
    /// with no parseable key or no parseable address is dropped whole. A
    /// dropped candidate costs nothing: mDNS is untouched and still owns
    /// discovery.
    ///
    /// An address list that parses to nothing is refused along with the rest,
    /// because a dial naming only a key has no path to race on a LAN-only
    /// endpoint — measured by
    /// `transport::endpoint::tests::a_dial_naming_only_an_endpoint_id_fails_fast_instead_of_hanging`.
    ///
    /// [`DiscoveredPeer`] carries one port for every address, so the first
    /// candidate's port is the one used — the same collapse `daemon_loop`
    /// already performs when it takes the mDNS SRV port from
    /// `addr().ip_addrs().next()`, over the same list of bound sockets.
    #[must_use]
    pub fn into_discovered(self) -> Option<DiscoveredPeer> {
        let device_id = crate::sync_protocol::accept_stated_device_id(&self.device_id)?;
        let endpoint_id = self.endpoint_id.trim().parse::<iroh::EndpointId>().ok()?;
        let socket_addrs: Vec<std::net::SocketAddr> = self
            .addrs
            .iter()
            .filter_map(|a| a.trim().parse::<std::net::SocketAddr>().ok())
            .collect();
        let port = socket_addrs.first()?.port();
        Some(DiscoveredPeer {
            device_id,
            endpoint_id: Some(endpoint_id),
            addresses: socket_addrs.iter().map(std::net::SocketAddr::ip).collect(),
            port,
        })
    }
}

/// Render `data` as a QR code and return the SVG markup.
///
/// The `qrcode` crate prefixes its output with an `<?xml …?>` declaration.
/// That prolog is invalid once the markup is injected into an HTML element
/// via `innerHTML` (the HTML parser treats `<?xml …?>` as a bogus comment),
/// so we strip it and hand the frontend a bare `<svg>…</svg>` fragment.
pub fn generate_qr_svg(data: &str) -> Result<String, AppError> {
    let code = qrcode::QrCode::new(data.as_bytes())
        .map_err(|e| AppError::InvalidOperation(format!("[pairing] QR generation failed: {e}")))?;
    let svg = code.render::<qrcode::render::svg::Color>().build();
    // Keep everything from the opening `<svg` tag onward, dropping the XML
    // declaration the renderer emits before it.
    Ok(match svg.find("<svg") {
        Some(idx) => svg[idx..].to_string(),
        None => svg,
    })
}

// ---------------------------------------------------------------------------
// Pairing Session
// ---------------------------------------------------------------------------

/// Lifetime of a pairing session / the pending-pairing activation marker.
///
/// A pairing session is short-lived: the host shows a QR, the joiner scans
/// The interactive pairing window used by `PairingSession::is_expired`.
///
/// Moved down into the store layer ([`agaric_store::peer_refs`]) so the
/// pending-pairing marker (see [`agaric_store::peer_refs::is_pending_pairing`])
/// can bound itself to the same clock without reaching *up* into this sync
/// module; re-exported here so `crate::pairing::PAIRING_TIMEOUT` and every
/// in-module use resolve unchanged. Once the interactive window has elapsed
/// an abandoned pairing must stop driving the daemon into pairing-mode.
pub use agaric_store::peer_refs::PAIRING_TIMEOUT;

// #3463: `MAX_PASSPHRASE_ATTEMPTS` and `PairingSession::{failed_attempts,
// attempts_exhausted, record_failed_attempt}` were removed here. They bounded
// repeated *local* guesses against the local `pairing_state` slot in
// `confirm_pairing_inner` (#1603). That comparison is gone — it made two-device
// pairing structurally impossible and authenticated nothing — so nothing was
// left for the counter to count, and an unreachable counter that reads like a
// security control is worse than none. The bound that matters is the wire-side
// one: the pending-pairing marker expires after [`PAIRING_TIMEOUT`], so a
// remote guesser has 5 minutes, one connection per try, against ~51.7 bits.

/// Domain-separation tag for [`pairing_proof`] (#855). Bumping it invalidates
/// every proof from an older peer, so keep it stable across compatible releases.
const PAIRING_PROOF_DOMAIN: &[u8] = b"agaric-pairing-proof-v1";

/// Proof that a peer knows the pairing passphrase, carried in
/// [`crate::sync_protocol::SyncMessage::HeadExchange::pairing_proof`] (#855).
///
/// Both devices independently store this value in their pending-pairing marker
/// when they arm ([`start_pairing_armed`]) or confirm ([`confirm_pairing`]) a
/// pairing;
/// the initiator echoes it in its `HeadExchange`, and the responder compares it
/// to its own stored value before it TOFU-pins an unpaired device
/// ([`crate::sync_daemon::server`]).
///
/// This closes the #855 CN-spoof window: a self-signed `CN=agaric-{victim}`
/// cert can be minted by anyone, but an attacker that does not know the
/// out-of-band passphrase cannot produce this value, so the responder never
/// pins its cert as the victim device. The proof travels only over the
/// confidential mTLS channel; a full man-in-the-middle relay is out of the
/// paired-device threat model (AGENTS.md §"Threat Model").
///
/// It is a domain-separated blake3 of the passphrase (not the raw passphrase),
/// so the value persisted in the pending-pairing marker is not the passphrase
/// itself and is not reusable outside this pairing sub-flow.
pub fn pairing_proof(passphrase: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(PAIRING_PROOF_DOMAIN);
    hasher.update(passphrase.as_bytes());
    hasher.finalize().to_hex().to_string()
}

/// Short-lived pairing session that tracks the generated passphrase.
///
/// Confidentiality and authenticity of the pairing exchange come from the QUIC
/// handshake and the endpoint-id TOFU pin ([`crate::transport`]), not from a
/// derived session key — see the module-level doc comment.
pub struct PairingSession {
    pub passphrase: String,
    pub created_at: std::time::Instant,
}

impl PairingSession {
    /// Create a new pairing session with a freshly generated passphrase.
    ///
    /// `local_device_id` / `remote_device_id` are kept on the signature
    /// for API symmetry with other pairing-related constructors but are
    /// unused — the pairing exchange relies on the underlying mTLS +
    /// cert-pin layer for confidentiality, so no per-session key is
    /// derived.
    pub fn new(_local_device_id: &str, _remote_device_id: &str) -> Self {
        Self {
            passphrase: generate_passphrase(),
            created_at: std::time::Instant::now(),
        }
    }
}

/// Response payload returned by [`start_pairing`].
///
/// [`PairingInfo`] itself carries only the passphrase and the rendered QR.
/// Where this device is reachable rides inside the QR payload (#4037), not as
/// a field here: the joiner learns it by scanning, and a user typing the four
/// words has no address to type alongside them.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PairingInfo {
    pub passphrase: String,
    pub qr_svg: String,
}

/// Acquire the pairing-state mutex, mapping a poisoned-lock failure
/// to a stable [`AppError::InvalidOperation`]. The error message is fixed
/// at `"pairing state lock poisoned"` so callers and tests can pattern-match
/// on it.
pub fn lock_pairing_state(
    pairing_state: &Mutex<Option<PairingSession>>,
) -> Result<MutexGuard<'_, Option<PairingSession>>, AppError> {
    pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))
}

/// Clear the #4297 "this peer says we are not paired" flag from every peer row,
/// on a user-initiated pairing act.
///
/// The companion to [`SyncScheduler::clear_backoff`] at the same two call sites,
/// and clears every peer for the same #3547 reason: a pairing act is new
/// information about the whole device list, and neither pairing role has a peer
/// id at this point — the flow carries a passphrase, and which peer it resolves
/// to is only known once the first authenticated connection lands.
///
/// A failure is logged and swallowed rather than propagated. The flag is a
/// display hint; refusing to start a pairing because a display hint could not be
/// cleared would turn a cosmetic problem into the loss of the one action that
/// fixes the underlying one. The stale flag also self-corrects: any session that
/// then moves data clears it, and if the pairing did not take, the next refusal
/// re-records it.
async fn clear_unpaired_flags_on_pairing_act(pool: &SqlitePool) {
    match peer_refs::clear_unpaired_by_peer_all(pool).await {
        Ok(0) => {}
        Ok(cleared) => tracing::info!(
            cleared,
            "cleared the 'peer has unpaired us' flag on a pairing act (#4297)"
        ),
        Err(e) => tracing::warn!(
            error = %e,
            "could not clear the 'peer has unpaired us' flag on a pairing act (#4297); a \
             stale re-pair prompt may linger until the next successful sync"
        ),
    }
}

/// Start a new pairing session.
///
/// Generates a fresh passphrase, creates a QR code SVG for sharing,
/// stores the session in `pairing_state`, and returns the pairing info
/// to the frontend.
///
/// The QR is always the passphrase-only v1 shape: this path does not arm the
/// pairing window, so it never wakes a dormant daemon and there is no bound
/// endpoint to advertise. [`start_pairing_armed`] is the path that resolves one.
#[instrument(skip(pairing_state), err)]
pub fn start_pairing(
    pairing_state: &Mutex<Option<PairingSession>>,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    install_pairing_session(pairing_state, PairingSession::new(device_id, ""), None)
}

/// Render `session`'s QR, store the session, and hand back the pairing info.
///
/// Split out of [`start_pairing`] because [`start_pairing_armed`] must mint the
/// passphrase *before* it can render the QR — it arms the pairing marker with a
/// proof of that passphrase, and arming is what produces the address the QR
/// carries.
fn install_pairing_session(
    pairing_state: &Mutex<Option<PairingSession>>,
    session: PairingSession,
    advert: Option<&LocalEndpointAdvert>,
) -> Result<PairingInfo, AppError> {
    let passphrase = session.passphrase.clone();
    let qr_svg = generate_qr_svg(&pairing_qr_payload(&passphrase, advert))?;

    *lock_pairing_state(pairing_state)? = Some(session);

    Ok(PairingInfo { passphrase, qr_svg })
}

/// How long [`start_pairing_armed`] waits for this device's bound endpoint
/// before rendering the pairing QR (#4037).
///
/// Covers the interface sweep and the bind that follow the wake. It used to be
/// slack added to `SyncScheduler::debounce_window`, back when the dormant
/// waiter spent that window before rechecking; this change moved the waiter onto
/// the raw counter, so the window is not spent and summing it only obscured
/// what the budget rests on.
const QR_ENDPOINT_BIND_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// Start pairing AND arm the pairing window so the host's dormant daemon
/// activates for the duration.
///
/// #2008: a first-ever pair has zero peers, so on the host
/// [`crate::sync_daemon::SyncDaemon::should_start_active`] would return
/// `false` and the daemon would stay dormant — not announcing over mDNS,
/// not listening — so the joining device could neither discover nor connect
/// to it and pairing would deadlock. Setting the pending-pairing marker
/// (the same TTL-bounded marker the joiner's [`confirm_pairing`] sets)
/// flips `should_start_active` to `true`; `notify_change()` wakes a dormant
/// daemon immediately instead of waiting for its next poll. The marker is
/// cleared once a real `peer_ref` exists (`should_start_active`).
#[instrument(skip(pool, pairing_state, scheduler, device_id), err)]
pub async fn start_pairing_armed(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    let session = PairingSession::new(device_id, "");
    // #855: store the passphrase proof in the pending-pairing marker so the
    // responder can require the joiner to prove knowledge of the passphrase
    // before we TOFU-pin it (closes the CN-spoof window).
    peer_refs::set_pending_pairing(pool, &pairing_proof(&session.passphrase)).await?;
    // #3547: the wake below is a SINGLE wake, and it is what Branch B turns into
    // the dial a first-ever pair depends on. Backoff standing against a peer
    // would let `may_retry` skip it, and nothing would retry until the next
    // scheduled round. See `SyncScheduler::clear_backoff` for why a user-initiated
    // pairing act is new information, and why it clears every peer.
    scheduler.clear_backoff();
    // #4297: same act, same reasoning — see `clear_unpaired_flags_on_pairing_act`.
    clear_unpaired_flags_on_pairing_act(pool).await;
    scheduler.notify_change();

    // #4037: the QR is rendered *after* the arm, not before, and that ordering is
    // the whole plumbing design.
    //
    // On the flow this feature exists for — a first-ever pair — this device has
    // no peers, so the daemon is dormant: no mDNS, and crucially no bound QUIC
    // endpoint. There is no address to put in a QR because nothing is listening
    // yet. The arm above is what changes that: it flips `should_start_active`
    // and the wake takes the dormant waiter into `daemon_loop`, which binds and
    // then publishes where it bound (`SyncScheduler::publish_local_endpoint`).
    //
    // So the wait below is not a poll for something that already exists; it is
    // waiting on a transition this function just caused. Since the waiter no
    // longer debounces (it watches the raw counter), that transition costs the
    // bind and little else; the budget adds `debounce_window` to the slack only
    // as headroom, not because the window is spent. Every other case — any
    // device that has ever paired — is already active and this returns on the
    // first `borrow`.
    //
    // A timeout is not a failure: it means this device has no endpoint to
    // advertise, and the QR degrades to the passphrase-only v1 shape that mDNS
    // has always carried on its own.
    let advert = scheduler
        .await_local_endpoint(QR_ENDPOINT_BIND_BUDGET)
        .await;
    if advert.is_none() {
        tracing::warn!(
            "no bound sync endpoint to advertise; the pairing QR carries only the \
             passphrase and this pair depends on mDNS (#4037)"
        );
    }

    // Rendering after the arm means a QR-generation failure now leaves the marker
    // armed where it previously would not have. That is inert: the passphrase is
    // never shown either, so there is nothing for a peer to prove knowledge of,
    // and the marker expires with `PAIRING_TIMEOUT` regardless.
    install_pairing_session(pairing_state, session, advert.as_ref())
}

/// Confirm pairing with a remote device — the **joiner** half of the flow.
///
/// The user typed the passphrase displayed on the *other* device. This arms
/// **this** device's TTL-bounded pending-pairing marker with
/// `pairing_proof(typed)` and clears the local offer session, because a device
/// that accepts someone else's passphrase is a joiner, not a host.
///
/// # #3463 — why there is no local comparison any more
///
/// Before #3463 this compared the typed passphrase against the passphrase in
/// *this* device's own `pairing_state` slot. Two-device pairing therefore could
/// never succeed: the pairing dialog starts a session on every device that
/// opens it, so the two devices hold independently-random passphrases and the
/// joiner's comparison mismatched with probability ~1.
///
/// Removing it costs nothing, because it never authenticated anything: the slot
/// is local state the local user created seconds earlier, so "matches the local
/// slot" is a statement about this device only. The check that actually gates
/// trust is on the wire and is untouched — `sync_daemon::server` admits an
/// unpaired device during the pairing window only if the `pairing_proof` it
/// offers constant-time-matches the proof in the responder's own marker (#855),
/// and the initiator sources that offered proof from its own marker
/// (`session_state_machine::start`). The protocol's precondition is thus
/// "both devices hold a marker for the SAME passphrase", and establishing that
/// is exactly this function's job.
///
/// # Attempt limiting (#1603) is gone — deliberately
///
/// `MAX_PASSPHRASE_ATTEMPTS` / `pairing.attempts_exhausted` bounded repeated
/// *local* guesses against the local slot. With no local comparison there is no
/// local guess to count, so keeping the counter would be dead code that reads
/// like a security control. The bound that matters is on the wire and already
/// exists: the pending-pairing marker expires after
/// `agaric_store::peer_refs::PAIRING_TIMEOUT` (5 minutes), after which
/// `get_pending_pairing_proof` reads as absent and an unpaired peer is rejected
/// outright. A remote guesser must produce `pairing_proof(P)` for a ~51.7-bit
/// passphrase inside that window, one TLS connection per try.
///
/// # Errors
///
/// No longer fails on passphrase content. #3463 removed both the local
/// comparison and the "a pairing session must exist" precondition, so this
/// function is infallible apart from DB and lock failures — it arms a local
/// marker, which is a local act that cannot be wrong about a value the user
/// just typed. In particular `pairing.no_active_session` is **not** returned
/// here any more; a correct joiner has no local session by construction.
///
/// The consequence is that a mistyped passphrase succeeds here and only fails
/// later, at the wire-side proof check. The UI must not claim success on the
/// strength of this returning `Ok` — see #3469.
///
/// On success the pending-pairing marker is armed and the scheduler is
/// signalled so a dormant sync daemon transitions to active mode without
/// waiting for its next poll interval.
///
/// # `scanned` — the host the QR named (#4037)
///
/// `Some` when the passphrase arrived by camera rather than by keyboard. It is
/// published to the scheduler so the daemon's next change round dials it
/// alongside anything mDNS found, which is what buys a first pair on a network
/// where multicast does not work. It is a *candidate*, not a requirement: an
/// unusable one is logged and dropped rather than failing the confirm, because
/// the arm below is the part pairing cannot do without and mDNS still covers
/// the ordinary case. See [`ScannedPeerCandidate::into_discovered`].
#[instrument(skip(pool, pairing_state, scheduler, passphrase, scanned), err)]
pub async fn confirm_pairing(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
    passphrase: String,
    scanned: Option<ScannedPeerCandidate>,
) -> Result<(), AppError> {
    // #3463: there is deliberately NO "a local pairing session must exist" guard
    // here, and removing it is part of the fix rather than a relaxation of it.
    //
    // A correct joiner never has a local session. It did not generate a
    // passphrase — it was handed one. Requiring a session would mean requiring
    // the joiner to first mint a competing passphrase of its own, which is
    // exactly the role confusion that made two-device pairing impossible: both
    // devices offering, neither accepting.
    //
    // The guard that used to live here read like a safety check but could only
    // ever be satisfied by a device in the *wrong* role, so it was not
    // protecting an invariant — it was enforcing the defect.
    //
    // Nothing security-relevant is lost. It tested state this same frontend had
    // written seconds earlier via `start_pairing`, so it authenticated nothing;
    // and arming the marker is inert without a passphrase the user typed. The
    // real bound is the marker's 5-minute TTL plus the wire-side constant-time
    // proof check in `sync_daemon::server`.
    //
    // Role exclusivity now lives where the roles actually are: the UI, which
    // requires an explicit host/joiner choice before either path can run. Making
    // that unrepresentable in the *backend* type (a `PairingRole` enum replacing
    // `Option<PairingSession>`) is the right end state and is scoped into the
    // pairing rewrite on plan #3464, where the passphrase becomes an iroh ticket.

    // The FE has no remote device_id at confirm time — the QR carries a
    // passphrase and an endpoint, never a device id, and mDNS + TOFU establish
    // the real peer on the first authenticated connection. So we set a persistent pending-pairing marker
    // that wakes the dormant daemon to *accept* that first connection, instead
    // of writing a junk empty-string `peer_refs` row (which used to be the only
    // thing tripping `should_start_active`, but showed as a blank ghost peer and
    // lingered forever). `_remote_device_id` is consequently always `""` from
    // the FE; the old branch that pre-created a NULL-`cert_hash` `peer_ref` for
    // a supplied device id was the CN-spoof pinning surface removed by #855.
    //
    // #855/#3463: the marker carries `pairing_proof` of the TYPED passphrase, so
    // this device and the host end up holding the same proof — each can then
    // both offer it (as initiator) and require it (as responder).
    peer_refs::set_pending_pairing(pool, &pairing_proof(&passphrase)).await?;

    // Clear the local offer session: this device is a joiner, and leaving its
    // own competing passphrase on display invites the role confusion of #3463.
    *lock_pairing_state(pairing_state)? = None;

    // #3547: this is the confirm the whole #3502 fix exists to serve — the
    // moment the two markers finally agree — and the wake below is the single
    // wake that turns it into a dial. Every pre-confirm dial in this window was
    // doomed by construction (the user had not typed yet), so any backoff they
    // left behind is not evidence about *this* dial; it would just make the one
    // that matters probabilistic. See `SyncScheduler::clear_backoff`.
    scheduler.clear_backoff();
    // #4297: same act, same reasoning — see `clear_unpaired_flags_on_pairing_act`.
    clear_unpaired_flags_on_pairing_act(pool).await;

    // #4037: published BEFORE the wake, so the round that wake triggers already
    // sees the candidate. The order is the whole point — a candidate published
    // after `notify_change` would sit out the one round the user is waiting on.
    if let Some(scanned) = scanned {
        match scanned.into_discovered() {
            Some(peer) => {
                tracing::info!(
                    peer_id = %peer.device_id,
                    candidates = peer.addresses.len(),
                    "pairing QR named a host to dial; racing it against mDNS (#4037)"
                );
                scheduler.publish_scanned_peer(peer);
            }
            None => tracing::warn!(
                "the scanned pairing QR named a host this device cannot dial \
                 (unusable device id, endpoint id, or address list); this pair \
                 depends on mDNS (#4037)"
            ),
        }
    }

    // Wake a dormant daemon (if any). Harmless if the daemon is
    // already active — `notify_change` is debounced by
    // `wait_for_debounced_change`.
    scheduler.notify_change();

    Ok(())
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
impl PairingSession {
    /// Returns `true` if the session has exceeded [`PAIRING_TIMEOUT`].
    ///
    /// **Not used in production** for the in-memory session — the slot is
    /// cleared on confirm/cancel. The same [`PAIRING_TIMEOUT`] *is* enforced
    /// in production for the persisted pending-pairing marker
    /// ([`agaric_store::peer_refs::is_pending_pairing`]). Retained here for test
    /// coverage of the session-timeout logic.
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() >= PAIRING_TIMEOUT
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_proof_is_deterministic_and_passphrase_specific() {
        // #855: the proof is a stable, domain-separated blake3 hex of the
        // passphrase — both devices derive the same value from the same
        // passphrase, and a different passphrase yields a different proof.
        let p1 = pairing_proof("correct horse battery staple");
        let p2 = pairing_proof("correct horse battery staple");
        assert_eq!(p1, p2, "same passphrase must yield the same proof");
        assert_eq!(p1.len(), 64, "blake3 hex digest is 64 chars");
        assert!(p1.chars().all(|c| c.is_ascii_hexdigit()), "hex digits only");

        let other = pairing_proof("correct horse battery stapler");
        assert_ne!(
            p1, other,
            "a different passphrase must yield a different proof"
        );

        // It is NOT the passphrase itself, and NOT a bare blake3 of it (domain
        // separation) — so the value stored in the marker is not a reusable
        // secret outside this sub-flow.
        assert_ne!(p1, "correct horse battery staple");
        let bare = blake3::hash("correct horse battery staple".as_bytes())
            .to_hex()
            .to_string();
        assert_ne!(p1, bare, "domain separation must change the digest");
    }

    #[test]
    fn generate_passphrase_returns_four_words() {
        let phrase = generate_passphrase();
        let words: Vec<&str> = phrase.split(' ').collect();
        assert_eq!(words.len(), 4, "passphrase should contain exactly 4 words");
    }

    #[test]
    fn generate_passphrase_words_are_from_wordlist() {
        let wl = wordlist();
        let phrase = generate_passphrase();
        for word in phrase.split(' ') {
            assert!(
                wl.contains(&word),
                "word '{word}' should be in the EFF wordlist"
            );
        }
    }

    /// A fixture advert: two candidates, so "all bound addresses" is
    /// distinguishable from "the first one".
    ///
    /// The key comes from the shared `test_endpoint_id` helper rather than a
    /// hand-typed string, so it is a *real* `EndpointId` in its real `Display`
    /// spelling (64 lowercase hex). The QR-size test below measures bytes, and
    /// a hand-typed placeholder of the wrong length would make those numbers
    /// quietly wrong.
    fn advert() -> LocalEndpointAdvert {
        LocalEndpointAdvert {
            // A canonical v4 UUID, which is what `get_or_create_device_id`
            // writes and therefore what the QR-size measurement below has to
            // weigh — a short placeholder would understate the payload.
            device_id: "b7f0d0f4-4d9a-4a1e-9f0b-2f6a1c3d4e5f".to_owned(),
            endpoint_id: crate::mdns::test_endpoint_id("QR_HOST_4037").to_string(),
            addrs: vec![
                "192.168.1.42:59553"
                    .parse()
                    .expect("a valid socket address"),
                "10.0.0.7:59553".parse().expect("a valid socket address"),
            ],
        }
    }

    /// With no bound endpoint, the payload is the v1 payload — not a v2 payload
    /// with the address fields missing or empty.
    ///
    /// The distinction is the whole compatibility story: a v1-only joiner reads
    /// `v` (or, in the shipped TS parser, does not) and must find exactly what
    /// it has always found. Announcing `"v":2` while carrying no endpoint would
    /// make the version tag a lie.
    #[test]
    fn pairing_qr_payload_without_an_advert_is_the_v1_shape() {
        let payload = pairing_qr_payload("alpha bravo charlie delta", None);
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(parsed["v"], 1, "payload must include \"v\":1");
        assert_eq!(parsed["passphrase"], "alpha bravo charlie delta");
        let object = parsed
            .as_object()
            .expect("QR payload must be a JSON object");
        assert_eq!(
            object.len(),
            2,
            "the degraded payload must contain exactly {{v, passphrase}}, got: {:?}",
            object.keys().collect::<Vec<_>>()
        );
        for absent in ["device_id", "endpoint_id", "addrs", "host", "port"] {
            assert!(
                !object.contains_key(absent),
                "a device with no bound endpoint must not advertise '{absent}'"
            );
        }
    }

    /// The v2 shape, pinned exactly: four keys, no more and no fewer.
    ///
    /// This replaces the "exactly {{v, passphrase}}" assertion that encoded the
    /// pre-#4037 decision. It is deliberately just as tight — a payload that
    /// grows a fifth field is a schema change a joiner has to be told about,
    /// which is what `v` is for.
    #[test]
    fn pairing_qr_payload_with_an_advert_is_the_v2_shape() {
        let advert = advert();
        let payload = pairing_qr_payload("alpha bravo charlie delta", Some(&advert));
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        let object = parsed
            .as_object()
            .expect("QR payload must be a JSON object");

        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["addrs", "device_id", "endpoint_id", "passphrase", "v"],
            "the v2 payload is exactly {{v, passphrase, device_id, endpoint_id, addrs}}"
        );
        assert_eq!(parsed["v"], 2, "the addressed payload declares v2");
        assert_eq!(parsed["passphrase"], "alpha bravo charlie delta");
        assert_eq!(parsed["device_id"], advert.device_id);
        assert_eq!(parsed["endpoint_id"], advert.endpoint_id);
        assert_eq!(
            parsed["addrs"],
            serde_json::json!(["192.168.1.42:59553", "10.0.0.7:59553"]),
            "every bound candidate goes in, in order — iroh races them"
        );
        // `host`/`port` were the pre-#4037 shape and are still not it: the
        // address is one `ip:port` string per candidate, not a split pair, and
        // there is more than one of them.
        for absent in ["host", "port"] {
            assert!(
                !object.contains_key(absent),
                "the v2 payload carries 'addrs', never '{absent}'"
            );
        }
    }

    /// The `v` a payload declares is the constant, not a literal that drifted.
    #[test]
    fn pairing_qr_payload_version_fields_match_their_constants() {
        let advert = advert();
        let addressed: serde_json::Value =
            serde_json::from_str(&pairing_qr_payload("a b c d", Some(&advert)))
                .expect("payload must be valid JSON");
        assert_eq!(
            addressed["v"].as_u64(),
            Some(u64::from(PAIRING_QR_VERSION)),
            "the addressed payload's version is PAIRING_QR_VERSION"
        );

        let degraded: serde_json::Value =
            serde_json::from_str(&pairing_qr_payload("a b c d", None))
                .expect("payload must be valid JSON");
        assert_eq!(
            degraded["v"].as_u64(),
            Some(u64::from(PAIRING_QR_VERSION_PASSPHRASE_ONLY)),
            "the degraded payload's version is PAIRING_QR_VERSION_PASSPHRASE_ONLY"
        );
        assert_ne!(
            PAIRING_QR_VERSION, PAIRING_QR_VERSION_PASSPHRASE_ONLY,
            "the two shapes must be distinguishable by their version tag alone"
        );
    }

    #[test]
    fn generate_qr_svg_contains_svg_tag() {
        let svg = generate_qr_svg("test data").expect("QR generation should succeed");
        assert!(
            svg.contains("<svg"),
            "QR output must contain an <svg tag, got: {svg}"
        );
    }

    #[test]
    fn generate_qr_svg_strips_xml_prolog() {
        // The markup is injected into the DOM via innerHTML, where a leading
        // `<?xml …?>` declaration is invalid; it must start at `<svg`.
        let svg = generate_qr_svg("test data").expect("QR generation should succeed");
        assert!(
            svg.starts_with("<svg"),
            "QR output must start with <svg (no XML prolog), got: {svg}"
        );
        assert!(
            !svg.contains("<?xml"),
            "QR output must not contain an XML declaration, got: {svg}"
        );
    }

    #[test]
    fn pairing_session_expires_after_timeout() {
        let mut session = PairingSession::new("device-a", "device-b");
        assert!(
            !session.is_expired(),
            "freshly created session must not be expired"
        );
        // Simulate passage of time by back-dating created_at
        session.created_at = std::time::Instant::now() - std::time::Duration::from_secs(301);
        assert!(session.is_expired(), "session must be expired after 5+ min");
    }

    /// QR payload should correctly escape special characters in passphrase.
    #[test]
    fn qr_payload_special_chars_in_passphrase() {
        let passphrase = r#"hello "world" & <friends>"#;
        for advert in [None, Some(advert())] {
            let payload = pairing_qr_payload(passphrase, advert.as_ref());
            let parsed: serde_json::Value =
                serde_json::from_str(&payload).expect("payload must be valid JSON");
            assert_eq!(
                parsed["passphrase"].as_str().unwrap(),
                passphrase,
                "special characters must survive JSON round-trip in both shapes"
            );
        }
    }

    /// A payload's size, in the terms that decide whether a phone camera can
    /// read it off a dialog: bytes in, QR version and module count out.
    ///
    /// # What the numbers are, and what they cost
    ///
    /// `PairingQrDisplay` renders the SVG into a fixed 200 px box with 12 px of
    /// padding, so the code gets 176 px however many modules it has. Adding the
    /// `qrcode` crate's 4-module quiet zone on each side:
    ///
    /// | payload | bytes | QR version | modules | across 176 px |
    /// |---|---|---|---|---|
    /// | v1, passphrase only | 61 | 4 | 33 (+8) | 4.3 px/module |
    /// | v2, one candidate | 224 | 11 | 61 (+8) | 2.6 px/module |
    /// | v2, two candidates (the cap) | 241 | 12 | 65 (+8) | 2.4 px/module |
    /// | v2, three candidates | 260 | 12 | 65 (+8) | 2.4 px/module |
    ///
    /// Every figure above is transcribed from a failing run, not computed. Two
    /// earlier versions of this table were hand-derived and both were wrong, in
    /// the bytes and in the version; that is the whole reason this test exists,
    /// so its own numbers have no business being estimates.
    ///
    /// Three fields dominate and none is negotiable: `endpoint_id` (52
    /// z-base-32 characters, ~70 bytes with its key and quoting) is what a dial
    /// names, `device_id` (a 36-character UUID, ~51 bytes) is what the session
    /// is keyed on, and at least one address is what makes the key reachable on
    /// a LAN-only endpoint. Together they carry the payload from version 4 to
    /// version 11 before a second address is even considered. Each further
    /// address is ~24 bytes, which is why `MAX_QR_ADDR_CANDIDATES` exists — but
    /// note the last row: at this size a third address no longer costs a
    /// version. The cap's remaining job is bounding a list that `ip_addrs()`
    /// does not bound, not buying a version back.
    ///
    /// 2.4 px/module at the cap is a real narrowing of the margin — a v1 code
    /// got 4.3 — though at 96 dpi it still puts ~0.64 mm on each module, above
    /// the ~0.5 mm a phone camera wants. If this is ever measured as marginal in
    /// the hand, the fix is on the display side (the 200 px box, or its 12 px
    /// padding), not in the payload: every field here is load-bearing for the
    /// dial.
    ///
    /// This is a **record**, not a limit. It asserts the version the shipped
    /// payload actually lands on, so a later field that pushes it up another
    /// version has to be a decision someone makes rather than a number that
    /// drifts under a QR nobody re-measured.
    #[test]
    fn the_v2_payload_costs_eight_qr_versions_over_v1() {
        fn qr_shape(data: &str) -> (usize, i16, usize) {
            let code = qrcode::QrCode::new(data.as_bytes()).expect("payload encodes as a QR");
            let qrcode::Version::Normal(version) = code.version() else {
                panic!("a byte payload must encode as a normal (not Micro) QR code");
            };
            (data.len(), version, code.width())
        }

        // A realistic worst case for the passphrase: long words from the EFF
        // list, which is the other thing setting the byte count.
        let passphrase = "zoologist zucchini yearbook wristwatch";
        assert_eq!(
            qr_shape(&pairing_qr_payload(passphrase, None)),
            (61, 4, 33),
            "passphrase-only payload: bytes, QR version, modules per side"
        );

        // The common case: a host binds one LAN address.
        let single = LocalEndpointAdvert {
            addrs: vec![advert().addrs[0]],
            ..advert()
        };
        assert_eq!(
            qr_shape(&pairing_qr_payload(passphrase, Some(&single))),
            (224, 11, 61),
            "one candidate: bytes, QR version, modules per side"
        );

        // Multi-homed — Wi-Fi and Ethernet both up.
        assert_eq!(
            qr_shape(&pairing_qr_payload(passphrase, Some(&advert()))),
            (241, 12, 65),
            "two candidates: bytes, QR version, modules per side — one version \
             MORE than a single candidate, so a multi-homed host does pay. If this \
             moved, \
             re-measure against the 200 px display box before shipping it — the QR \
             is read by a phone camera at dialog size, and that is the bound these \
             numbers are about"
        );

        // The cap is what stops that growth from being unbounded: `ip_addrs()`
        // returns every bound address, and nothing about the user's network
        // limits how many that is.
        let many = LocalEndpointAdvert {
            addrs: vec![
                "192.168.1.42:59553"
                    .parse()
                    .expect("a valid socket address"),
                "10.0.0.7:59553".parse().expect("a valid socket address"),
                "172.17.0.1:59553".parse().expect("a valid socket address"),
                "192.168.64.1:59553"
                    .parse()
                    .expect("a valid socket address"),
                "10.211.55.2:59553".parse().expect("a valid socket address"),
            ],
            ..advert()
        };
        let payload = pairing_qr_payload(passphrase, Some(&many));
        assert_eq!(
            payload.matches(":59553").count(),
            MAX_QR_ADDR_CANDIDATES,
            "five bound addresses must be truncated to the cap, not all carried"
        );
        assert_eq!(
            qr_shape(&payload),
            (241, 12, 65),
            "at the cap the QR is exactly the two-candidate one — that is the \
             point of the cap. Measured, five uncapped addresses keep adding \
             ~24 bytes each and do eventually climb; a third alone happens to \
             land on the same version 12, so the cap is bounding the list, not \
             buying a version"
        );
    }

    // -- The scanned candidate (#4037) ---------------------------------------

    /// The joiner's side of the payload above, round-tripped: what the host
    /// wrote into the QR must parse back into the same `DiscoveredPeer` an mDNS
    /// announcement of that host would have produced.
    ///
    /// Built by *reading the rendered payload* rather than by hand, so the two
    /// halves cannot drift apart under a field rename: a producer that stopped
    /// emitting `device_id` reds this test at the `expect`, not three releases
    /// later on a user's LAN.
    #[test]
    fn a_scanned_v2_payload_parses_back_into_the_host_the_advert_described() {
        let advert = advert();
        let payload: serde_json::Value = serde_json::from_str(&pairing_qr_payload(
            "alpha bravo charlie delta",
            Some(&advert),
        ))
        .expect("the payload is JSON");
        let scanned: ScannedPeerCandidate = serde_json::from_value(payload)
            .expect("the v2 payload deserialises as the candidate the joiner sends back");

        let peer = scanned
            .into_discovered()
            .expect("a candidate built from a real advert must be dialable");

        assert_eq!(
            peer.device_id, advert.device_id,
            "the session is keyed on this, and `bind_endpoint_id` makes it permanent"
        );
        assert_eq!(
            peer.endpoint_id.map(|k| k.to_string()),
            Some(advert.endpoint_id.clone()),
            "the dial names the key the host published"
        );
        assert_eq!(
            peer.addresses,
            advert
                .addrs
                .iter()
                .map(std::net::SocketAddr::ip)
                .collect::<Vec<_>>(),
            "every candidate path survives — iroh races them"
        );
        assert_eq!(peer.port, advert.addrs[0].port());
    }

    /// Every field is refused *whole*, and the address list is not optional.
    ///
    /// One arm per reason a candidate can be undialable, plus the accepted
    /// baseline they are each a single mutation away from — without that
    /// baseline a `into_discovered` that returned `None` for everything would
    /// satisfy all four refusals.
    #[test]
    fn an_unusable_scanned_candidate_is_refused_whole() {
        let good = || ScannedPeerCandidate {
            device_id: "b7f0d0f4-4d9a-4a1e-9f0b-2f6a1c3d4e5f".to_owned(),
            endpoint_id: crate::mdns::test_endpoint_id("QR_HOST_4037").to_string(),
            addrs: vec!["192.168.1.42:59553".to_owned()],
        };
        assert!(
            good().into_discovered().is_some(),
            "baseline: each refusal below is one field away from this"
        );

        assert!(
            ScannedPeerCandidate {
                device_id: String::new(),
                ..good()
            }
            .into_discovered()
            .is_none(),
            "an empty device id would become a `peer_refs` row every peer-facing \
             query hides"
        );
        assert!(
            ScannedPeerCandidate {
                device_id: "d".repeat(1024),
                ..good()
            }
            .into_discovered()
            .is_none(),
            "an over-long id must be REFUSED, never truncated: a shortened id is a \
             different id, and `bind_endpoint_id` would make it permanent (#4380)"
        );
        assert!(
            ScannedPeerCandidate {
                endpoint_id: "not-a-key".to_owned(),
                ..good()
            }
            .into_discovered()
            .is_none(),
            "a dial names a key; there is nothing to attempt without one"
        );
        assert!(
            ScannedPeerCandidate {
                addrs: vec!["not-an-address".to_owned()],
                ..good()
            }
            .into_discovered()
            .is_none(),
            "a LAN-only endpoint has no relay and no discovery, so a key with no \
             candidate path has nowhere to go"
        );
        assert!(
            ScannedPeerCandidate {
                addrs: vec![],
                ..good()
            }
            .into_discovered()
            .is_none(),
            "…and an empty list is the same statement"
        );
    }

    /// `confirm_pairing` hands the scanned host to the scheduler, where the
    /// daemon's next change round reads it.
    ///
    /// The negative half is in the same test on purpose: a typed passphrase
    /// must leave the slot empty, or "publishes what it was given" would hold
    /// for an implementation that published something unconditionally.
    #[tokio::test]
    async fn confirm_pairing_publishes_the_scanned_host_for_the_next_round() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;

        let typed = SyncScheduler::new();
        confirm_pairing(&pool, &Mutex::new(None), &typed, "a b c d".into(), None)
            .await
            .expect("a typed passphrase confirms");
        assert!(
            typed.scanned_peer().is_none(),
            "a typed passphrase names no host to dial"
        );

        let advert = advert();
        let scanned_sched = SyncScheduler::new();
        confirm_pairing(
            &pool,
            &Mutex::new(None),
            &scanned_sched,
            "a b c d".into(),
            Some(ScannedPeerCandidate {
                device_id: advert.device_id.clone(),
                endpoint_id: advert.endpoint_id.clone(),
                addrs: advert.addrs.iter().map(ToString::to_string).collect(),
            }),
        )
        .await
        .expect("a scanned passphrase confirms");

        let published = scanned_sched
            .scanned_peer()
            .expect("the scanned host must reach the scheduler the daemon reads");
        assert_eq!(published.device_id, advert.device_id);
        assert_eq!(
            published.endpoint_id.map(|k| k.to_string()),
            Some(advert.endpoint_id)
        );
    }

    /// A QR the camera read badly must not cost the user the pairing.
    ///
    /// The candidate only ever *races* mDNS, so dropping it costs a first pair
    /// nothing unless multicast is also broken; failing the confirm would cost
    /// every pair, including the ones mDNS would have completed. So the marker
    /// is armed exactly as it is for a typed passphrase, and only the candidate
    /// is dropped.
    #[tokio::test]
    async fn confirm_pairing_arms_the_marker_even_when_the_scanned_host_is_unusable() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        let scheduler = SyncScheduler::new();

        confirm_pairing(
            &pool,
            &Mutex::new(None),
            &scheduler,
            "alpha bravo charlie delta".into(),
            Some(ScannedPeerCandidate {
                device_id: "b7f0d0f4-4d9a-4a1e-9f0b-2f6a1c3d4e5f".to_owned(),
                endpoint_id: "not-a-key".to_owned(),
                addrs: vec!["192.168.1.42:59553".to_owned()],
            }),
        )
        .await
        .expect("an unusable candidate must not fail the confirm");

        assert!(
            scheduler.scanned_peer().is_none(),
            "an undialable candidate must not be published — the daemon would \
             spend a round on it"
        );
        assert_eq!(
            peer_refs::get_pending_pairing_proof(&pool)
                .await
                .expect("the marker is readable")
                .as_deref(),
            Some(pairing_proof("alpha bravo charlie delta").as_str()),
            "the arm is the part pairing cannot do without, and it is unconditional"
        );
    }

    // -- The plumbing (#4037) ------------------------------------------------

    /// `start_pairing_armed` puts the *published* endpoint into the QR.
    ///
    /// Asserted by rebuilding the payload from the returned passphrase and
    /// comparing the rendered SVG byte for byte, because `PairingInfo` exposes
    /// the QR and not the payload behind it. Comparing against BOTH shapes is
    /// what makes it a real assertion: equal to the addressed payload's code
    /// and unequal to the degraded one, so a plumbing regression that silently
    /// drops the advert cannot pass.
    #[tokio::test]
    async fn start_pairing_armed_carries_the_published_endpoint_into_the_qr() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        let scheduler = SyncScheduler::new();
        let advert = advert();
        scheduler.publish_local_endpoint(advert.clone());
        let slot = Mutex::new(None);

        let info = start_pairing_armed(&pool, &slot, &scheduler, "device-host")
            .await
            .expect("arming a pairing on a migrated pool succeeds");

        // `assert!` rather than `assert_eq!` throughout: these compare rendered
        // QR SVGs, which run to tens of kilobytes of path data, and printing two
        // of them tells a reader nothing the message does not already say.
        assert!(
            info.qr_svg
                == generate_qr_svg(&pairing_qr_payload(&info.passphrase, Some(&advert)))
                    .expect("the addressed payload renders"),
            "the QR must encode the endpoint the daemon published"
        );
        assert!(
            info.qr_svg
                != generate_qr_svg(&pairing_qr_payload(&info.passphrase, None))
                    .expect("the degraded payload renders"),
            "…and must not be the passphrase-only code, or the assertion above \
             would hold for a build that never read the advert at all"
        );
    }

    /// With no endpoint published inside the budget, the QR degrades to the
    /// passphrase-only shape rather than failing or blocking indefinitely.
    ///
    /// The debounce window is squeezed to keep the budget (window + slack) short;
    /// production sizes it from the real 3 s window, which is what a dormant
    /// daemon spends before it rechecks the peer table.
    #[tokio::test]
    async fn start_pairing_armed_degrades_when_no_endpoint_is_published() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        let scheduler = SyncScheduler::with_intervals(
            std::time::Duration::from_millis(10),
            std::time::Duration::from_secs(60),
        );
        let slot = Mutex::new(None);

        let info = start_pairing_armed(&pool, &slot, &scheduler, "device-host")
            .await
            .expect("a device with no bound endpoint can still offer a passphrase");

        assert!(
            info.qr_svg
                == generate_qr_svg(&pairing_qr_payload(&info.passphrase, None))
                    .expect("the degraded payload renders"),
            "a device with nothing to advertise falls back to the v1 code that \
             mDNS has always carried on its own"
        );
        // The arm itself is unaffected — that is the part pairing cannot do
        // without, and it must not be contingent on having an address.
        assert!(
            peer_refs::is_pending_pairing(&pool)
                .await
                .expect("the marker is readable"),
            "the pending-pairing marker must be armed whether or not an endpoint \
             was there to advertise"
        );
    }
}
