# PEND-04 — Threat-model audit: stale vs necessary security measures

## TL;DR

**The audit's main finding:** HKDF-SHA256 key derivation and ChaCha20-Poly1305 AEAD encryption — flagged in the original architectural review as "overkill for the threat model" — were **already removed in Session 510 (MAINT-110)**. Pairing now travels as plaintext JSON over the already-mTLS-secured, TOFU-pinned WebSocket, which is exactly the right shape for the threat model.

**What's actually stale: the documentation.** ARCHITECTURE.md §20 (Sync & Networking) still lists `hkdf` and `chacha20poly1305` in its crates table and still describes ChaCha20-Poly1305 as the pairing transport. COMPARISON.md line ~211 also references "ChaCha20-Poly1305 pairing." All other security measures (TLS, mTLS, X.509 CN verification, TOFU pinning, the 4-word EFF passphrase, QR pairing) are correctly aligned with the threat model and should be kept.

**Effective scope of this task: a documentation refresh.** Cost is S; risk is essentially zero.

## Threat model recap

Per AGENTS.md "Threat Model" section: Agaric is single-user, multi-device, local-first. Sync happens between the user's own devices on their LAN; **there are no adversaries**. TLS+mTLS exists for **data integrity and accidental cross-talk prevention** (preventing the user's laptop from accidentally syncing with a roommate's machine), not for defending against adversarial peers on the network. TOFU cert pinning is a convenience to detect device re-installs.

## Audit table

| Measure | KEEP / REMOVE | Justification | Files |
| --- | --- | --- | --- |
| TLS 1.2+ (rustls + tokio-rustls) | KEEP | Transport integrity over WiFi; required for the "secure WiFi communication" threat-model floor | `sync_net/tls.rs`, `sync_net/connection.rs` |
| Self-signed ECDSA P-256 certs (rcgen) | KEEP | Per-device identity for mTLS handshake | `sync_cert.rs` |
| mTLS (mutual cert verification both ends) | KEEP | Prevents accidental cross-talk between unrelated devices on the same LAN | `sync_net/tls.rs` |
| X.509 CN verification (x509-parser) | KEEP | B-34 invariant: binds the TLS handshake to the claimed device ID. Without it, a paired peer could swap certs without notice. | `sync_cert.rs`, `sync_net/connection.rs` |
| TOFU cert pinning (SHA-256 in `peer_refs.cert_hash`) | KEEP | Detects device re-installs (key rotation triggers a re-pair); persistent device identity | `peer_refs.rs`, `sync_net/tls.rs` |
| `sha2` crate | KEEP | Used for cert pinning hashes and op-log hash chaining (the latter via blake3, but `sha2` still earns its keep on the cert-pin path) | `sync_cert.rs`, op-log paths |
| Pairing passphrase (4-word EFF wordlist) | KEEP | Human-verifiable confirmation against typo / wrong-device-paired; ~51.7 bits of entropy | `pairing.rs`, `eff_wordlist.txt` |
| HKDF-SHA256 key derivation | **ALREADY REMOVED (Session 510 / MAINT-110)** | Was used to derive a session key from the passphrase. Removed because TLS already provides the encrypted channel; HKDF was redundant. | (gone) |
| ChaCha20-Poly1305 AEAD encryption of pairing messages | **ALREADY REMOVED (Session 510 / MAINT-110)** | Was used to encrypt the pairing handshake JSON. Removed because TLS already provides confidentiality; ChaCha was redundant. Pairing now travels as plaintext JSON over mTLS. | (gone) |
| QR code (qrcode crate) | KEEP | Usability — eliminates manual entry of the paired peer's address + cert pin | `pairing.rs` |
| `dirs` crate (cert path resolution) | KEEP | Cross-platform path lookup for the persistent cert; cheap and standard | `sync_cert.rs` |
| `if-addrs` crate | KEEP | Implements L-65: filter mDNS announces to RFC1918 private IPv4 only (avoid leaking device IP onto guest WiFi / VPN). Necessary given the protocol shape. | `sync_daemon/discovery.rs` |
| `mdns-sd` crate | KEEP | Service discovery on the LAN. Necessary while transport stays mDNS+WebSocket (replaced if iroh ever lands, but that's PEND-10 territory). | `sync_daemon/discovery.rs` |

## Documentation updates required

The reviewer's audit confirmed three additional stale spots beyond the original draft. Full list below.

### ARCHITECTURE.md — three locations

**§1 crates table (around lines 87-88):**

- `hkdf + sha2` row → keep only `sha2` (still used for cert pinning)
- `chacha20poly1305` row → delete

**§20 Sync & Networking crates table (around lines 1633-1634):** same two rows, duplicated; same removal.

**§20 pairing description (around lines 1650-1653):** delete the HKDF + ChaCha steps entirely. Replace with:

> "Pairing uses a 4-word passphrase (EFF wordlist) shared via QR code. The pairing handshake travels as plaintext JSON over the already-established mTLS+TOFU-pinned WebSocket on the same connection used for sync — confidentiality and authenticity come from the rustls layer, not from application-layer crypto. The passphrase serves as a human-verifiable confirmation that both devices are talking to the right peer (defense against typo-paired or accidentally-cross-talking devices, in keeping with the threat model)."

**§"Alternatives" / "Lessons Learned" (around line 2415):** the line *"The current HKDF-SHA256 + ChaCha20-Poly1305 stack is correct and right-sized for the threat model."* is misleading — it implies the stack is current. Replace with something like *"After MAINT-110 we removed the HKDF + ChaCha layer because rustls already provides confidentiality and authenticity over the pairing channel; doubling up was extra surface for no threat-model benefit."*

### COMPARISON.md (~line 211)

Replace `"ChaCha20-Poly1305 pairing"` with `"plaintext JSON pairing over mTLS"` (or simply `"mTLS-secured pairing handshake"` if the audience for this doc doesn't need the detail).

### SECURITY.md (line 22)

Currently lists `chacha20poly1305` and `hkdf` as primitives the sync layer relies on. Replace:

```text
**Crypto misuse** — incorrect use of the `rustls` / `chacha20poly1305` / `hkdf` / `blake3` / `rcgen` primitives the sync layer relies on (wrong nonce reuse, missing AAD, weak KDF parameters).
```

with:

```text
**Crypto misuse** — incorrect use of the `rustls` / `blake3` / `rcgen` primitives the sync layer relies on.
```

### Cargo.toml

Direct dependencies: clean. `hkdf` and `chacha20poly1305` were removed from `[dependencies]` in Session 510 — verified.

**Note on transitive dependencies:** `hkdf` remains in the dependency tree as a transitive dep via the `keyring` crate's Linux backend (`dbus-secret-service` → `secret-service`). This is expected and does not affect the audit — Agaric's sync layer has zero direct or indirect crypto dependencies beyond `rustls`, `blake3`, `rcgen`, and `sha2` (cert-pin). The transitive `hkdf` is consumed only inside `dbus-secret-service` for keyring wire-format handling on Linux, never by Agaric code.

## Crates that can be dropped

**None.** The two crates worth dropping (`hkdf`, `chacha20poly1305`) were already dropped in MAINT-110.

## Files that survive but slim down

**None.** `pairing.rs` was already trimmed in MAINT-110 (per its current header comment, the file explicitly documents that there is no application-layer crypto in the module).

## Cost

**S (~1 hour total).**

| Step | Time |
| --- | --- |
| ARCHITECTURE.md §20 crates-table edit | 10 min |
| ARCHITECTURE.md §20 pairing-section rewrite | 20 min |
| COMPARISON.md line update | 5 min |
| Verification grep across all docs for any other stale HKDF/ChaCha mentions | 10 min |
| Cross-check that current pairing.rs comment matches the new ARCHITECTURE.md prose | 10 min |

## Impact

**Documentation quality: medium.** The next architectural reviewer (human or AI) won't be misled into auditing crypto that doesn't exist. Closes a real audit-confusion class.

**Code: zero.** No code changes. The code is already correct.

**Audit surface: small but real.** Removes two stale crate mentions from the dependency-review surface, making future security reviews quicker.

## Risk

**Essentially zero.** This is doc-only. No code path changes, no migrations, no peers affected.

## Testing

- Run `prek run --all-files` after the doc edits (markdown lint, link check).
- Visually verify ARCHITECTURE.md §20 renders cleanly.
- Confirm `grep -ri "hkdf\|chacha20\|chacha20poly1305\|derive_session_key\|encrypt_message" ARCHITECTURE.md COMPARISON.md AGENTS.md SECURITY.md` returns zero matches after edits.

## Open questions

1. Is the 4-word EFF passphrase still actually used, or was it removed alongside HKDF/ChaCha? **Verify via `grep -rn "eff_wordlist\|passphrase" src-tauri/src/`** before writing the new prose. The `eff_wordlist.txt` file exists in `src-tauri/src/eff_wordlist.txt` so probably yes — but worth confirming the consumption path.
2. SECURITY.md (~7 KB at the repo root) probably also contains crypto descriptions. Audit it for HKDF/ChaCha mentions during this task and update in the same commit.

## Approach

Single PR with all three doc updates (ARCHITECTURE.md + COMPARISON.md + SECURITY.md if applicable). No code changes. No tests beyond the prek lint pass.
