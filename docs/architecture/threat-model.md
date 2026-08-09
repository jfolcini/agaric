<!-- markdownlint-disable MD060 -->
# Threat model

Structured complement to [`SECURITY.md`](../../SECURITY.md). The prose policy lives there — what counts as in-scope, what counts as out-of-scope, who the trust anchors are, which mitigations are wired up, and how rotation works. This file holds the **structured artefact**: assets, trust boundaries, a data-flow diagram, and a per-boundary STRIDE breakdown. Read together they satisfy OSPS-SA-03.02 (conduct threat modelling and attack-surface analysis); read separately, the prose page is the one a triager skims and this page is the one a reviewer audits.

The framing carries over unchanged. Agaric is a single-user, multi-device, local-first application with no maintainer-operated cloud. Sync runs over the LAN between devices the same user has explicitly paired. Defensive effort is concentrated on **data integrity** — append-only op log, hash-chain consistency, atomic transactions — not on adversarial-peer hardening. Reports that assume an adversarial LAN peer, a root-on-device attacker, or a multi-tenant deployment will be triaged against the out-of-scope list rather than addressed in code.

## Scope and intent

This file is the structured threat-modelling artefact for the project. It is **not** the security policy; the policy is [`SECURITY.md`](../../SECURITY.md). It is **not** the architectural index; the language and IPC contracts live in [`tooling.md`](tooling.md) and the operational decisions live in [`ci-and-tooling.md`](ci-and-tooling.md). The audience here is a reviewer who needs to answer "did the project enumerate its trust boundaries and characterise the threats at each one?" without re-deriving the model from prose.

The doc is structured around STRIDE — Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege — applied per trust boundary rather than per feature. Per-feature threat modelling at this scale would produce a sprawling document that contributors do not read; per-boundary modelling produces a small set of tables that map cleanly onto the code surfaces a reviewer already navigates. STRIDE rows that resolve to "Out-of-scope" cite the relevant clause of [`SECURITY.md`](../../SECURITY.md) rather than re-litigating the framing.

The document is a living artefact. When a new trust boundary appears (server mode, a second cloud integration, a peer-to-peer transport change), the corresponding section is the first thing that gets updated; the prose in `SECURITY.md` follows. When a mitigation moves (a hook is renamed, a file is split), the cell linking to it gets updated and the rest of the row stays put. Numeric metrics are deliberately omitted — pointers to canonical source files are the only truthful answer, because count tables in long-lived documents drift faster than they get updated.

## Assets

The objects below are what the project is defending. Anything not on this list either composes from these (e.g. derived FTS indexes compose from notes content) or is out of scope (e.g. machine-level telemetry; the application gathers none).

- **Notes content.** The user's writing — pages, blocks, attachments, tags, properties — stored in `notes.db` under `~/.local/share/com.agaric.app/` on Linux and the OS-correct equivalent elsewhere. This is the primary asset; everything else exists to keep it intact, available, and confined to the user's own devices.
- **Sync peer trust state.** The `peer_refs.endpoint_id` bindings that record "this device-ID is bound to this iroh `EndpointId`" (an ed25519 public key), plus this device's own secret key in `sync-endpoint.key` (mode `0o600`, app data dir). Stored alongside the database. Losing the secret key makes every paired peer stop recognising this device; corrupting the bindings allows accidental cross-talk between devices the user did not intend to pair. The pre-cutover `peer_refs.cert_hash` column still exists but no longer defends anything — nothing in production reads it.
- **Updater signing keys.** The long-lived `TAURI_SIGNING_PRIVATE_KEY` repository secret signs every auto-update payload; the matching public key is embedded in [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json) (`plugins.updater.pubkey`) and is what the in-app updater (`src/hooks/useUpdateCheck.ts`) verifies before applying a bundle. This is the root of trust for the entire updater pipeline. Rotation cadence, procedure, and the deferred Sigstore-keyless alternative are documented in [`SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation) § "Updater signing-key rotation".
- **Release artefacts.** The signed bundles (`.deb`, `.AppImage`, `.msi`, `.exe`, `.dmg`, `.app.tar.gz`, `.apk`) plus the updater tarballs and their detached `.sig` files, plus SLSA build provenance attested by `actions/attest-build-provenance` and pushed to Sigstore and the GitHub attestations API. End-user verification is documented in [`docs/BUILD.md`](../BUILD.md). These artefacts are what reach users; their integrity is what the updater signing key and the provenance attestation jointly defend.

## Trust boundaries

A trust boundary is where data crosses a control surface — where the decoder on one side cannot assume the encoder on the other followed the contract. Four boundaries matter for Agaric:

1. **Frontend ↔ Backend (Tauri IPC).** The WebView (renderer) reaches the Rust backend only through `#[tauri::command]` handlers gated by the capability allowlist in [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json) and the CSP in [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json). Capability-based; deny-by-default in spirit (a command must be both registered with `agaric_commands!` and permitted by capability before the frontend can invoke it).
2. **Backend ↔ SQLite.** Database file in the user's home directory; the trust boundary is the operating system filesystem permissions on `~/.local/share/com.agaric.app/`. No application-level encryption at rest; the OS handles disk encryption (FileVault / BitLocker / LUKS / Android FBE), and SQLCipher was rejected for cost-vs-threat reasons documented in [`tooling.md`](tooling.md#storage).
3. **Sync daemon ↔ LAN peer.** QUIC (iroh) between paired devices. Each end is named by an `EndpointId` — an ed25519 public key carried in its TLS 1.3 certificate — and the QUIC handshake proves possession of the matching secret before a single application byte moves, so identity is authenticated by the transport rather than claimed in an application message. That key is bound to a peer on first successful session (TOFU) in `peer_refs.endpoint_id`. Pairing state lives in the database; the authorization path is in [`src-tauri/agaric-sync/src/sync_daemon/server.rs`](../../src-tauri/agaric-sync/src/sync_daemon/server.rs) (`handle_incoming_sync_inner`: the S-1 unpaired gate, the #855 proof check, and `bind_endpoint_id`). The model assumes peers are the user's own devices; the LAN itself is **not** treated as a trusted medium even though the threat model treats adversarial-peer hardening as out of scope.
4. **Updater ↔ GitHub Releases.** Tauri's auto-updater fetches the manifest from `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` (see [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json)) and verifies the bundle against the embedded public key. Out-of-band, every release asset is also attested via SLSA provenance to Sigstore and the GitHub attestations API; end-user verification is optional but documented in [`docs/BUILD.md`](../BUILD.md).

## Data-flow diagram

```text
                                                      ┌──────────────────────────────┐
                                                      │       GitHub Releases        │
                                                      │  + Sigstore / Attestations   │
                                                      └────────────▲─────────────────┘
                                                                   │  HTTPS + minisign
                                                                   │  signature verify
                                                       (B4: updater trust boundary)
                                                                   │
                                                                   ▼
   ┌──────────────────────┐   B1: Tauri IPC      ┌────────────────────────────────┐
   │  Frontend (WebView)  │ ◀─── capability ───▶ │     Backend (Rust process)     │
   │  React + TipTap      │      allowlist        │   #[tauri::command] surface    │
   │  CSP: default-src    │      + CSP            │   sanitize_internal_error      │
   │  'self'              │                       │                                │
   └──────────────────────┘                       └───┬──────────┬───────────────┘
                                                     │          │
                                          B2: FS     │          │
                                          permissions│          │
                                                     ▼          ▼
                                            ┌─────────────┐ ┌────────┐
                                            │  SQLite     │ │ Sync   │
                                            │  notes.db   │ │ daemon │
                                            │  + WAL      │ │        │
                                            └─────────────┘ └───┬────┘
                                                                │
                                        B3: QUIC/UDP, ALPN-gated│
                              handshake-authenticated EndpointId│  + TOFU binding
                                                                ▼
                                                       ┌────────────────┐
                                                       │  Paired peer   │
                                                       │  (user-owned)  │
                                                       └────────────────┘
```

Each labelled edge marks a trust transition. B1 is the IPC boundary (capability allowlist + CSP). B2 is the on-disk boundary (FS permissions; no app-layer encryption). B3 is the sync boundary (QUIC with a handshake-authenticated `EndpointId`, gated on the `agaric/sync/0` ALPN, with the key TOFU-bound to a peer row). B4 is the updater boundary (Sigstore-attested release artefacts + minisign signature on the bundle). The diagram intentionally omits the MCP UDS socket — it is listed under Attack surface enumeration below; promoting it to the diagram would clutter it without adding a distinct trust transition (UDS is a process-local socket gated by file mode).

## Per-boundary STRIDE

The tables below use one row per (asset × STRIDE category) combination that the boundary materially exposes. Categories that are inapplicable at a given boundary (e.g. Repudiation in the IPC boundary, where every command call is initiated by the local user) are listed once with the rationale rather than repeated row-by-row.

### B1 — Frontend ↔ Backend (Tauri IPC)

| Asset | Threat (STRIDE) | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| Notes content | **Spoofing** — a non-`main` WebView origin or injected `<iframe>` reaches the IPC surface and impersonates the legitimate window. | Low | High | CSP `default-src 'self'` in [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json) blocks foreign origins from loading. Per-window capability in [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json) targets `["main"]` only. | Mitigated |
| Notes content | **Tampering** — a frontend bug or extension constructs a malformed IPC payload that bypasses backend validation. | Med | Med | Backend re-validates every input (ULID normalisation in `BlockId::Deserialize`, sqlx-compiled queries against the schema, `Validation` error variant for IPC-side rejection). Type-safe bindings are generated from the handler tree (`agaric_commands!` in `src-tauri/src/lib.rs`) so the wire shape cannot drift from the Rust signature. | Mitigated |
| Notes content | **Repudiation** — no human-readable audit trail of which IPC call mutated what. | Low | Low | Single-user model — there is no third party to repudiate to. The append-only op log (`op_log` table) records the substantive mutations; UI-level breadcrumbs are not retained by design. | Accepted |
| Notes content | **Information disclosure** — a `#[tauri::command]` returns internal error detail (file paths, SQL fragments, OS error codes) to the frontend, where it surfaces in a toast or a bug report. | Med | Med | `sanitize_internal_error` (`src-tauri/src/commands/mod.rs`) collapses `Database` / `Migration` / `Io` / `Json` / `Channel` / `Snapshot` variants into a generic `InvalidOperation("an internal error occurred")` over the wire. Enforced by the `tauri-command-sanitize` prek hook (see [`prek.toml`](../../prek.toml)). The function's own docstring frames this as a **UX consistency layer**, not a security boundary — an adversarial frontend with capability access could still exfiltrate; that scenario sits under the trusted-frontend assumption in [`SECURITY.md`](../../SECURITY.md#trust-anchors). | Mitigated (UX layer) |
| Notes content | **Denial of service** — a runaway IPC caller exhausts the write pool or holds a long-running transaction. | Low | Low | Single-user, local app: the only caller is the user's own frontend. Out-of-scope per [`SECURITY.md`](../../SECURITY.md#out-of-scope) "DoS / rate-limit scenarios against any local-only listener". | Out-of-scope |
| Notes content | **Elevation of privilege** — a command not on the capability list is invoked, or the WebView reaches arbitrary `file://` / `asset:` URLs and reads outside the allowlist. | Low | High | Capability allowlist in [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json) is the deny-by-default surface. The handler tree is enumerated by `agaric_commands!`; any new command must be registered there *and* in the capability JSON. CSP `connect-src 'self' ipc: http://ipc.localhost` blocks outbound fetches. | Mitigated |

### B2 — Backend ↔ SQLite (on-disk)

| Asset | Threat (STRIDE) | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| Notes content | **Spoofing** — a different process writes a fake `notes.db` into the app data dir, the backend opens it on next launch. | Low | High | Filesystem permissions in `~/.local/share/com.agaric.app/` are the trust boundary. An attacker who can write there already has the user's data; this is the local-first storage model, not a leak. | Out-of-scope (see [`SECURITY.md`](../../SECURITY.md#out-of-scope) "An attacker who already has filesystem access can read `notes.db`"). |
| Notes content | **Tampering** — a crash mid-transaction leaves the database in a half-applied state, or a migration corrupts a previously-shipped table. | Low | High | WAL mode + foreign keys on every connection (`src-tauri/src/db/pool.rs`); migrations are append-only and enforced by the `migrations-immutable` prek hook; new tables are required to use `STRICT` mode by the `migrations-strict-tables` hook. The append-only op log gives a recovery surface for content even if a derived table is corrupted. | Mitigated |
| Notes content | **Repudiation** — operations are not signed; an op log entry cannot be cryptographically tied back to which device authored it. | Low | Low | Single-user model — every device is the same person; per-device authorship is recorded as a hint, not as a signature. The hash-chain on the op log defends *integrity* (no silent reordering or insertion), which is the property the threat model actually wants. | Accepted |
| Notes content | **Information disclosure** — backups, sync exports, or `bug_report` payloads expose plaintext notes outside the app. | Med | Med | The `bug_report` IPC (`src-tauri/src/commands/bug_report.rs`) applies a **deny-by-default per-field-value redactor** — anything not matching a safe-token allowlist becomes `[REDACTED]`. Backups are an explicit user action and surface their location prominently. The rolling log file (`agaric.log`) lives inside the app data dir under the same FS-permission boundary as `notes.db`; in-process logging is *not* redacted (`src/lib/logger.ts` is a thin console wrapper), so a frontend `log::info!` that includes user content would persist that content to the log file — relevant only to attackers with local FS access (already out-of-scope, see [`SECURITY.md`](../../SECURITY.md#out-of-scope)). Disk-at-rest encryption is delegated to the OS (FileVault / BitLocker / LUKS / FBE). | Mitigated |
| Notes content | **Denial of service** — a corrupted database wedges the application; the user cannot open the app to back up their content. | Low | Med | Migrations refuse to run against an unrecognised schema rather than mutating it; the WAL gives a partial recovery surface. The `bug_report` workflow can extract the raw `notes.db` regardless of FE state. | Mitigated |
| Notes content | **Elevation of privilege** — a frontend caller reads database rows that the application logic intended to gate (e.g. a soft-deleted block, a different space's blocks). | Low | Med | Frontend space-scoped queries thread `space_id` at the SQL layer; soft-delete filtering is enforced in the query, not in the renderer; sqlx compile-time checks the query shape against the schema. **Note:** on the MCP surface, `space_id` is not an isolation boundary of either kind — the read-only tool surface is deliberately vault-wide (an agent reads across all spaces by ULID / enumeration regardless of any `space_id` it writes under), and the read-write surface's `space_id` check is only a self-declared consistency check against the target block's actual space (catches a stale/mismatched ULID, not an adversarial agent that supplies the block's real space). See [features/agent-access.md](../features/agent-access.md#space-scoping-reads-are-vault-wide-writes-are-space-scoped). This is intentional for reads (agents are whole-vault readers); no per-space isolation (read or write) exists today. | Mitigated (accidental cross-space writes); no isolation against an adversarial/injected agent |
| Sync peer trust state | **Tampering** — a forced edit to the `peer_refs` table changes the bound `endpoint_id` and silently re-pairs with a different device. | Low | Med | Same FS-permission boundary as notes content; a writer with that access has already won (and can equally rewrite `sync-endpoint.key`). The TOFU model intentionally records the *first* key and refuses to re-point it (`bind_endpoint_id` in `src-tauri/agaric-store/src/peer_refs.rs`), so the failure mode is a hard rejection rather than a silent re-pair. A column-level CHECK from migration `0107` additionally rejects any spelling that is not the canonical 64-character lowercase hex, so a hand-edited row cannot become invisible to lookup under SQLite's BINARY collation. | Accepted |

### B3 — Sync daemon ↔ LAN peer

The framing here matters: the threat model treats LAN peers as the user's own devices. The QUIC handshake, the ALPN gate and the TOFU binding exist to prevent *accidental* cross-talk (two users on the same Wi-Fi, a device wiped and re-installed under the same hostname) and to give the encrypted channel that the local-first community expects of any networked product. They are **not** a defence against an adversarial peer who has been let into the pairing graph. Reports framed against an adversarial-peer model are filed under the out-of-scope clauses of [`SECURITY.md`](../../SECURITY.md#out-of-scope).

**What the iroh cutover did and did not change here.** It made one class of attack impossible rather than merely detected: under the old stack a peer's device-ID was the Common Name of a self-signed certificate, so anyone could mint `CN=agaric-{victim}` and the whole `verify_peer_cert` / B-33 / B-34 apparatus existed to catch the claim. An `EndpointId` is not a claim — it is an ed25519 public key the handshake proves possession of — so there is nothing left to spoof at that layer.

It did **not** make authorization unnecessary, and reading it that way is the single most likely mistake in this area. Cryptographic identity answers *which key is this*; it does not answer *may this key sync my vault*, and anyone can generate a keypair. The S-1 unpaired gate, the #855 pairing-passphrase proof, the S-5 per-peer lock, #2537 cancel ownership and the #1519 pending-pairing bridge all survive the port. The #3324 first-message gate is **reframed, not removed**: because the #855 proof rides *inside* `HeadExchange`, for an unpaired peer authorization cannot precede the first receive, so the order is `recv → authorize → dispatch` and only the first two moved. What makes the bug class structurally unrepresentable is that `Role::Responder` carries the opening frame — `run_session` never reads one of its own, so it cannot dispatch a frame that did not pass authorization first.

| Asset | Threat (STRIDE) | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| Notes content | **Spoofing** — another device on the LAN advertises a paired peer's `device_id` in its mDNS TXT record and is dialled instead of the real one. | Low | Med | The mDNS record is unauthenticated by design; anyone on the LAN can advertise `device_id=<victim>` next to their own `endpoint_id`. What the forgery buys is nothing: the initiator's pinned-identity check (`try_sync_with_peer` step 4, [`session_supervisor.rs`](../../src-tauri/agaric-sync/src/sync_daemon/session_supervisor.rs)) refuses an announcement whose key differs from the one bound to that row, and the responder resolves an inbound peer by the handshake-authenticated key alone (S-1 in [`server.rs`](../../src-tauri/agaric-sync/src/sync_daemon/server.rs)), never by anything the peer said. A forged record costs a failed dial, not a session. **Exception:** a row with `endpoint_id IS NULL` has nothing to compare against — see the migrated-install row below. | Mitigated (bound rows); see re-TOFU row |
| Notes content | **Tampering** — a man-in-the-middle on the LAN edits sync packets in flight. | Med | High | QUIC carries TLS 1.3, which gives confidentiality + integrity on the channel, and the handshake authenticates both endpoints' `EndpointId` to each other before any application byte moves. Within the threat model this is sufficient (peers are the user's own devices); an active LAN MITM holding a paired device's ed25519 secret key is out of scope. | Mitigated (within model) |
| Notes content | **Repudiation** — a peer denies having sent an op-log mutation. | Low | Low | The op log is hash-chained; reorder or insertion is detected at apply time. Per-device authorship is recorded but not cryptographically signed. Single-user model means there is no third party to repudiate to. | Accepted |
| Notes content | **Information disclosure** — passive eavesdropping on the LAN. | Low | High | TLS 1.3 inside QUIC encrypts every sync connection. Anonymity properties of the sync graph (who is paired with whom, traffic-analysis resistance) are explicitly out of scope per [`SECURITY.md`](../../SECURITY.md#out-of-scope) — and note that the mDNS announcement broadcasts both `device_id` and `endpoint_id` in cleartext, which is what makes the graph observable. | Mitigated (content); graph is out of scope |
| Notes content | **Denial of service** — a peer floods the daemon with malformed packets, the decoder panics or wedges. | Low | Low | Single-user model — peers are the user's own devices, not adversarial. Decoder hardening against hostile peer input is welcomed as regular bugs but not treated as a security finding. See [`SECURITY.md`](../../SECURITY.md#out-of-scope) "DoS / rate-limit scenarios against any local-only listener". Some bounds exist anyway, as corruption/version-skew hygiene rather than as a defence: `MAX_FRAME_SIZE` (256 MB) is checked before a buffer is allocated and the buffer then grows in 5 MB steps as bytes land, so a four-byte length prefix cannot commit 256 MB; admission is capped at 16 sessions with the permit taken before the handshake; and setup is bounded by a 10 s handshake budget plus a 180 s first-frame budget, both off the accept loop. | Out-of-scope (bounded anyway) |
| Sync peer trust state | **Spoofing** — a wiped-and-reinstalled device comes back with the same device-ID but a fresh `EndpointId`; the bound key rejects it. | Med | Low | This is the intended failure mode. `sync-endpoint.key` is regenerated when the app data dir is wiped, so the device has a genuinely different identity; the initiator refuses the announcement with "peer identity does not match the one paired with this device" and re-pair is a deliberate action, not an automatic accept-on-conflict. `bind_endpoint_id` refuses to re-point a key already bound to a different peer (`src-tauri/agaric-store/src/peer_refs.rs`). | Mitigated |
| Sync peer trust state | **Spoofing** — during the post-upgrade re-TOFU window, an mDNS record claiming a paired device's `device_id` is bound as that device (#3514). | Low | Med | **This is a second TOFU event, and it is currently silent.** Migration `0107` adds `peer_refs.endpoint_id` but cannot backfill it — a certificate hash does not yield an ed25519 key — so every pre-cutover pair upgrades with `endpoint_id IS NULL` and the responder recognises nobody. The bootstrap is the initiator's: it matches an mDNS-announced `device_id` against an existing row and binds the announced key. Both devices dial on the resync tick, so the window is short (one tick), and it sits inside the stated threat model — a hostile device already on your LAN. But it is the same trust-on-first-use the old stack performed on the *first* connection, moved to the upgrade, for users who already completed the first one, with no UI. Options on #3514: accept and document (this row), require explicit re-confirmation for a re-bind, or narrow the window by binding only from a session whose `HeadExchange` is consistent with the stored heads. | Accepted (documented); tracked by #3514 |
| Sync peer trust state | **Tampering** — a race between two simultaneous first-pairing attempts overwrites each other's binding. | Low | Low | `bind_endpoint_id` preserves the peer's existing sync state instead of replacing the row (an `INSERT OR REPLACE` would silently reset version vectors when a device merely re-paired), refuses to re-point a key already bound elsewhere, and `get_peer_ref_by_endpoint_id` **refuses** to resolve a key that matches two peers rather than picking one — because picking one would make the answer depend on row order, and this is the lookup that decides whose vault a connection may touch. | Mitigated |
| Sync peer trust state | **Elevation of privilege** — an inbound and an outbound session with the same device overlap during the pairing window, because the per-peer lock key is asymmetric (#3511). | Low | Low | **Mitigated (#3511).** `HeadExchange` carries no `device_id`, and `get_local_heads` reads only `op_log`, so a fresh joiner with an empty log advertises no head of its own. The responder therefore fell back to locking on the endpoint id while the initiator locked on the device id, and S-5 — which exists to stop exactly that overlap — had a hole in precisely the window where both ends arm and dial simultaneously. Both roles now derive the key from the peer's `EndpointId` via `sync_daemon::peer_lock_key`: the responder has it from the QUIC/TLS 1.3 handshake before any application byte, the initiator has it before it can dial, so the two agree by construction and no wire field was added. Rejected alternative: a `#[serde(default)]` `device_id` on `HeadExchange` — it arrives *after* the connection is accepted, so the responder would still have to pick a key before it had one. Residual: an `EndpointId` is 1:1 with an install, so the lock admits one concurrent session per install rather than per device id. | Closed by #3511 |
| Notes content | **Elevation of privilege** — a paired peer issues op-log mutations beyond what the user intended (e.g. one device wipes another device's notes). | Low | High | Per the framing above, peers are the user's own devices and intentional mutation by any of them is in-scope behaviour, not an attack. Hardening against a *compromised* paired device (a stolen laptop that still holds its `sync-endpoint.key`) is **out-of-scope** — see [`SECURITY.md`](../../SECURITY.md#out-of-scope) "Adversarial-peer hardening". Mitigation, when one becomes necessary, would be unbinding a paired device's `endpoint_id` from a healthy peer plus replay-resistance on the op log. | Out-of-scope |

### B4 — Updater ↔ GitHub Releases

The updater is the only outbound network call the application makes that is **not** scoped to LAN sync or to a user-initiated cloud integration. A compromise here ships malware to every user; it is the most consequential boundary in the model.

| Asset | Threat (STRIDE) | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| Release artefacts | **Spoofing** — DNS poisoning or a mis-configured update server redirects the in-app updater to a malicious endpoint. | Low | High | The updater endpoint is hard-coded to `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` in [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json); HTTPS gives certificate authentication on the wire. Crucially, the **payload** carries its own minisign signature checked against the embedded `plugins.updater.pubkey` — even a successful endpoint hijack does not bypass the in-app signature check unless the attacker also holds the signing private key. | Mitigated |
| Release artefacts | **Tampering** — a malicious release asset is uploaded to the GitHub release, or an upstream Actions runner injects a malicious binary into the build. | Low | High | Every release asset is signed by the `TAURI_SIGNING_PRIVATE_KEY` (signature verified at install time via minisign), and every asset is attested via SLSA build provenance to Sigstore and the GitHub attestations API (`actions/attest-build-provenance`). Third-party actions are SHA-pinned rather than floating on a tag, and `_validate.yml` runs the full prek gate on every release tag. | Mitigated |
| Release artefacts | **Repudiation** — a release was published; the maintainer denies authorship. | Low | Low | SLSA provenance binds the artefact to the GHA workflow run that produced it (publicly logged); release tags are signed via the `required_signatures` repository ruleset. | Mitigated |
| Release artefacts | **Information disclosure** — the updater discloses the user's installed version to the release endpoint via the request fingerprint. | Med | Low | Release manifest fetches are anonymous GETs against a public CDN; the information leak is bounded to the user's install of a public binary, which is not treated as sensitive. | Accepted |
| Updater signing keys | **Spoofing** — an attacker who holds the leaked `TAURI_SIGNING_PRIVATE_KEY` signs a malicious update; the in-app signature check passes. | Low | High | Documented rotation procedure with annual cadence and immediate rotation on suspected compromise (see [`SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation)). Revocation is implicit and bidirectional: a rotated bundle will not validate against the old in-app pubkey, and the new in-app pubkey will not accept an old-key payload. The Sigstore-keyless alternative is deferred pending upstream Tauri support. | Accepted |
| Updater signing keys | **Information disclosure** — the private key leaks via CI logs, an actions-cache poisoning, or a maintainer-machine compromise. | Low | High | The secret is stored in GitHub Actions repository secrets; CI workflows mask secret values in logs; `zizmor` lints workflows for known leak patterns; SHA-pinned actions prevent a rogue dependency from exfiltrating. Trust-anchor compromise of the maintainer machine is acknowledged as un-mitigable in-repo (see [`SECURITY.md`](../../SECURITY.md#trust-anchors)). | Accepted |
| Release artefacts | **Denial of service** — GitHub Releases is unreachable; the updater cannot fetch the manifest. | Med | Low | The application continues to run on the currently-installed version; the updater is best-effort and surfaces a non-blocking toast on failure. | Accepted |
| Release artefacts | **Elevation of privilege** — a malicious updater payload runs at install time with installer privileges. | Low | High | The in-app signature check (minisign against the embedded pubkey) is the gate. SLSA provenance is the verification path for sophisticated users; OS-level code signing is intentionally not in place today (see the no-OS-signing tradeoff in [`ci-and-tooling.md`](ci-and-tooling.md#slsa-provenance-sigstore-and-the-unsigned-binary-tradeoff)). Windows SignPath OSS is in flight; macOS notarisation is a strict no-go for the current cycle. | Mitigated (in-app) / Accepted (OS-layer first-launch UX) |

## Attack surface enumeration

The boundaries above are the *control* surfaces. The list below is the *attack* surface — every place an external byte enters the process or a local byte leaves it. Reviewers walk this list when adding a feature to check whether a new entry needs to appear.

**Network listeners.**

- Sync daemon QUIC/**UDP** endpoint (`src-tauri/agaric-sync/src/transport/service.rs`, driven from `sync_daemon/session_supervisor.rs` and `server.rs`). Binds one interface address on an OS-assigned ephemeral port — `lan_bind_target` picks the first RFC 1918 IPv4 and falls back to loopback, so inbound reach is single-homed (#3513). `lan_only` (`transport/endpoint.rs`) disables relays, clears relay and IP transports and address lookup, injects a DNS resolver that answers nothing, and refuses a publicly-routable bind or an over-broad prefix — so the endpoint has no route to n0's infrastructure. Admission is capped at 16 concurrent responder sessions with over-capacity connections refused before the handshake, and the `agaric/sync/0` ALPN fails a non-Agaric dial inside the handshake. mDNS / multicast service advertisement (`_agaric._udp.local.`) attaches to the same lifecycle (see `mdns.rs` and `sync_daemon/discovery.rs`, with the Android multicast-lock JNI carve-out in [`android_multicast.rs`](../../src-tauri/agaric-sync/src/sync_daemon/android_multicast.rs)).
- MCP UDS socket — a Unix domain socket under the app data directory (`src-tauri/src/commands/mcp.rs`). RO and RW variants; gated by a marker file in the app data directory; not a TCP listener. File-mode is the trust boundary.

**File paths.**

- `~/.local/share/com.agaric.app/` (Linux) and the OS-correct equivalent elsewhere — hosts `notes.db` + WAL, sync peer state, `device-id`, the device's iroh secret key (`sync-endpoint.key`, hex, mode `0o600`), the MCP socket, the MCP enable markers, and the log file (`agaric.log` rolled by `tracing-appender`). The retired transport's combined cert+key PEM is left on disk unread rather than deleted — removing a key file is not something a version bump should do silently.
- Tauri updater cache — operating-system-dependent location; transient.

**IPC commands.**

- The full handler tree is enumerated by `agaric_commands!` in `src-tauri/src/lib.rs` — the canonical list, since the per-file breakdown under `src-tauri/src/commands/` drifts — and every handler routes its error path through `sanitize_internal_error` (`src-tauri/src/commands/mod.rs`), enforced by the `tauri-command-sanitize` prek hook. Capability gating is in [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json).

**External services touched.**

- **GitHub Releases** — the in-app updater fetches `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` and the bundle URL the manifest references.
- **GitHub Attestation API + Sigstore Rekor** — fetched only by users who choose to verify SLSA provenance out-of-band (commands documented in [`docs/BUILD.md`](../BUILD.md)); the running application itself does not call this surface.

**Supply-chain entry points.**

- npm registry — `package-lock.json` pinning, `npm audit signatures` (Sigstore provenance verification, warn-only), `better-npm-audit` against [`.nsprc`](../../.nsprc).
- crates.io — `Cargo.lock` pinning, `cargo deny check` driven by [`src-tauri/deny.toml`](../../src-tauri/deny.toml) (block tier), `cargo audit` (warn tier).
- GitHub Actions marketplace — every `uses:` SHA-pinned; [`.github/dependabot.yml`](../../.github/dependabot.yml) bumps weekly; `zizmor` lints workflows.

## Out of scope

The lists in [`SECURITY.md`](../../SECURITY.md#out-of-scope) are canonical; this section restates them in the threat-model frame so a reviewer skimming this page does not have to chase the cross-link.

- **Adversarial LAN peers.** Sync peers are the user's own devices. Decoder panics under hostile peer input, packet-injection attacks against a paired peer, traffic-analysis on the sync graph — all welcome as regular bugs, none treated as security findings.
- **Root-on-device attackers.** An attacker who already has read/write access to `~/.local/share/com.agaric.app/` already holds the user's data. Local-first apps store local data; that is the model.
- **Supply-chain attacks against transitive dependencies already covered by `cargo-deny`.** The block and warn controls plus explicit waiver tiers documented in [`ci-and-tooling.md`](ci-and-tooling.md#advisory-handling--three-concentric-rings) are the current control. Only `.nsprc` waivers are time-boxed; findings against entries on the rationale-based `deny.toml` ignore list need to be raised against the ignore-entry rationale, not the dependency.
- **Multi-user / multi-tenant scenarios.** Every paired device belongs to the same person. There is no concept of "other users" with separate permissions inside an Agaric install.
- **Network-exposed servers, server-mode builds, hosted backends.** None exist; if any were proposed, this document and [`SECURITY.md`](../../SECURITY.md) would be revisited *before* the change landed.
- **Mobile MDM, secure-enclave attestation, jailbreak detection.** Out of scope; the application targets desktop primarily and a single-user Android build secondarily, and assumes the OS provides the device-integrity story.
- **DoS / rate-limiting on local-only listeners.** Sync daemon, MCP socket — all bound to loopback or LAN with the single-user trust model.
- **Anonymity properties of the LAN sync protocol.** Who is paired with whom, traffic-analysis resistance — not in scope.

A proposed change that shifts any of these items into scope (a server build, a multi-user feature, a public deployment, an external-maintainer access model) must update this document and `SECURITY.md` before the change lands. The trust-anchor and mitigation lists upstream of this file all assume the local-first, single-user framing; widening that framing without revisiting them would silently un-mitigate items the documents currently claim mitigated.

## Assurance case

Reframes the STRIDE rows above as **top-level security claims + the arguments and evidence that justify them**. Satisfies the OpenSSF Best Practices Silver-tier [`assurance_case`](https://www.bestpractices.dev/en/criteria/2#2.assurance_case) criterion. Each claim cites the STRIDE row(s) that mitigate it and the CI evidence that verifies the mitigation in production.

The shape is intentionally narrative, not GSN-formal: the threat model above is the load-bearing artefact, and a separate GSN-style document would just drift against it (per the assurance-case design decision). Anyone updating a claim here should update the cited STRIDE row in the same commit.

### Claim 1 — User data stays on the user's device

**Argument.** Agaric is a local-first application. There is no server-side store, no maintainer-operated cloud copy, and no telemetry that phones home by default. The off-device data flows are opt-in LAN sync to the user's own paired devices and, only if explicitly enabled, an opt-in OpenTelemetry exporter that is code-constrained to a loopback collector the user runs themselves.

**Evidence.**

- [§Trust boundaries](#trust-boundaries) lists two boundaries that touch off-device surfaces (B3 LAN sync, B4 updater); both are either self-paired (B3) or read-only (B4).
- [`SECURITY.md`](../../SECURITY.md#in-scope) treats "an outbound network call to a server the maintainer doesn't operate" as an in-scope finding, carving out one documented, bounded exception.
- [`SECURITY.md`](../../SECURITY.md#observability-telemetry-egress-opt-in-loopback-only) — the OTel exporter is off by default, byte-identical to the file-only pipeline when unset, and enforced in code (`observability::config::validate_loopback_endpoint`) to reject any non-loopback endpoint host. A report that the opt-in exporter exists is not a finding; a report that its loopback enforcement can be bypassed is.

### Claim 2 — The Tauri IPC boundary is capability-gated

**Argument.** Every call from the JS frontend into the Rust backend traverses `tauri::Builder::invoke_handler!`. Capabilities for those handlers live in `src-tauri/capabilities/default.json`, and Tauri enforces the allowlist at build/runtime — an unregistered or unpermitted command cannot be invoked from the frontend. Frontend code cannot escalate to OS-level APIs (filesystem, network, shell) outside the allowlist.

**Evidence.**

- B1 STRIDE row: enumerates Spoofing/Tampering/Repudiation/Info-disclosure/DoS/Elevation per-row mitigations for the IPC surface.
- `src-tauri/capabilities/default.json` is the canonical capability allowlist.
- `lint`-stage CI job runs `cargo clippy -- -D warnings` against the IPC handler module (`src-tauri/src/commands/`); any new handler that bypasses the typed `tauri::command!` macro fails the build.
- The `tauri-command-sanitize` prek hook ([`prek.toml`](../../prek.toml), `scripts/check-tauri-command-sanitize.mjs`) blocks new IPC handlers that don't run through the `AppError`/sanitiser path.

### Claim 3 — Release artifacts are signed and attested

**Argument.** Every published bundle, SBOM, and APK is signed with the Tauri updater key and attested with [SLSA build provenance](https://slsa.dev/) via GitHub's `actions/attest-build-provenance` → Sigstore transparency log. End users (and downstream packagers) can verify origin and integrity offline.

**Evidence.**

- B4 STRIDE row: covers updater signing, updater pull-vs-push trust, leaked-key rotation.
- `.github/workflows/release.yml` runs `actions/attest-build-provenance` in per-platform `Attest …` steps covering the AppImage, .deb, .rpm, .dmg, .msi, .apk, SBOM, and OpenVEX outputs.
- Release notes (every release since 0.1.38) include the per-asset `gh attestation verify` recipe; consumers can replay it without trusting the workflow.
- Tauri updater public key pinned in `src-tauri/tauri.conf.json`; private key lives in `secrets.TAURI_SIGNING_PRIVATE_KEY` with documented rotation in [`SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation).

### Claim 4 — Vulnerabilities can reach the maintainer privately

**Argument.** [`SECURITY.md`](../../SECURITY.md) names the maintainer's GitHub Security Advisories private-disclosure path and a fallback email. Both are stable for the lifetime of the repository. The response timeline (acknowledgement, triage, fix-or-plan) is a published, fixed commitment rather than something negotiated per-report.

**Evidence.**

- [`SECURITY.md`](../../SECURITY.md#how-to-report) — the private-disclosure path and fallback email; the response timeline (acknowledgement within 7 days, triage within 14 days, fix-or-mitigation plan within 30 days where feasible) is in [§ What to expect](../../SECURITY.md#what-to-expect). Public disclosure happens via a tagged release plus a published GitHub Security Advisory; there is no fixed public-disclosure day-count, only the ack/triage/fix cadence above.
- The disclosure path is wired to the project's GitHub Security Advisories tab; reports there reach the maintainer's notification settings.
- The OpenSSF Best Practices form's [`vulnerability_report_process`](https://www.bestpractices.dev/en/criteria/0#0.vulnerability_report_process) criterion is Met (verified 2026-05-17) and points at the same document.

### Claim 5 — The supply chain is reviewed in three concentric rings

**Argument.** Dependencies are reviewed at three ringfences: blocking Rust advisory checks via `cargo-deny` and `cargo audit`, warn-only npm provenance verification via `npm audit signatures`, and time-boxed npm advisory waivers in `.nsprc`. Rust waivers in `deny.toml` are explicit but do not expire automatically: each carries a written rationale, with a concrete revisit trigger or tracking issue recorded where one is known.

**Evidence.**

- [`ci-and-tooling.md` §Advisory handling — three concentric rings](ci-and-tooling.md#advisory-handling--three-concentric-rings) documents the policy.
- `cargo-deny` runs on every PR via the prek hook suite in `_validate.yml`'s `lint` job; `cargo audit` runs in the same job.
- [`.nsprc`](../../.nsprc) gives every npm advisory waiver an `expiresOn` date; these are the time-boxed exceptions.
- `src-tauri/deny.toml` `[advisories].ignore` entries each carry a `reason`. The GTK3 bindings batch documents an upstream-release revisit trigger and the `quick-xml` entries cite tracking issue `#2310`; several other current entries have no explicit trigger and none has an automatic expiry.
- The Scorecard `Vulnerabilities` score-vs-policy gap (RUSTSEC noise from atk/gtk3 transitives via `wry → tauri`) auto-recovers when upstream finishes the gtk4 migration.

### How this is maintained

When any STRIDE row above is updated (new mitigation, accepted-risk → mitigated transition, threat moved to "out of scope" or back), the corresponding claim's evidence line gets updated in the same commit. The OpenSSF Best Practices form's [`assurance_case`](https://www.bestpractices.dev/en/criteria/2#2.assurance_case) field points at this section directly so the live link to evidence stays the contract.

## Open questions

Living artefact — this section is allowed to be empty, and any entry here is an item the threat model has not yet committed to. As of the current revision:

- **Sigstore-keyless updater signing** — adoption deferred pending upstream Tauri support maturity. When it lands, the B4 boundary's "leaked `TAURI_SIGNING_PRIVATE_KEY`" row downgrades from Accepted to Mitigated and the rotation procedure in [`SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation) is rewritten around ephemeral Fulcio certificates.
- **Windows code signing (SignPath OSS)** — application in flight. When it lands, the B4 "first-launch UX" row tightens from Accepted to Mitigated on Windows.
- **macOS notarisation** — explicit no-go for the current cycle. The row remains Accepted until a downstream packager forces a revisit.
- **The post-upgrade re-TOFU is silent (#3514).** Documented in the B3 table and accepted for now. If it is decided that a *second* trust-on-first-use event owes the user a confirmation the first one had, this stops being Accepted.
- **Loro payloads are uncompressed on the wire (#3512).** zstd compression retired with the chunking layer, and the `HeadExchange.wire_compression` field that advertised it was removed in #3543 (it was write-only: set on send, discarded on receive). This is not itself a security claim, but the uncompressed 4× JSON expansion of Loro payloads against the 256 MB frame cap puts a hard offer failure at roughly 64 MB of state in one space — a threshold nobody has measured.
- **Inbound is single-homed (#3513).** Not a confidentiality or integrity question; it is an availability one, and it is stated in the attack-surface listener entry so nobody reads "binds each non-loopback interface" into the model.

When any of the above ships, the corresponding STRIDE row above gets updated and the entry here is removed in the same commit.
