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
- **Sync peer trust state.** The TOFU-pinned device certificate hashes that record "this device-ID is bound to this self-signed cert". Stored alongside the database. Losing this state breaks pairing; corrupting it allows accidental cross-talk between devices the user did not intend to pair.
- **OAuth tokens.** Today only Google Calendar (PKCE flow via `tauri-plugin-oauth`). Access and refresh tokens live in the OS keychain (Secret Service on Linux, Keychain on macOS, Credential Manager on Windows — see the `keyring` crate feature list in [`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml)), keyed per space (`oauth_tokens_<SPACE_ULID>`). Compromise grants the holder read/write access to the user's Google Calendar within the scope granted at consent time.
- **Updater signing keys.** The long-lived `TAURI_SIGNING_PRIVATE_KEY` repository secret signs every auto-update payload; the matching public key is embedded in [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json) (`plugins.updater.pubkey`) and is what the in-app updater (`src/hooks/useUpdateCheck.ts`) verifies before applying a bundle. This is the root of trust for the entire updater pipeline. Rotation cadence, procedure, and the deferred Sigstore-keyless alternative are documented in [`SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation) § "Updater signing-key rotation".
- **Release artefacts.** The signed bundles (`.deb`, `.AppImage`, `.msi`, `.exe`, `.dmg`, `.app.tar.gz`, `.apk`) plus the updater tarballs and their detached `.sig` files, plus SLSA build provenance attested by `actions/attest-build-provenance` and pushed to Sigstore and the GitHub attestations API. End-user verification is documented in [`docs/BUILD.md`](../BUILD.md). These artefacts are what reach users; their integrity is what the updater signing key and the provenance attestation jointly defend.

## Trust boundaries

A trust boundary is where data crosses a control surface — where the decoder on one side cannot assume the encoder on the other followed the contract. Five boundaries matter for Agaric:

1. **Frontend ↔ Backend (Tauri IPC).** The WebView (renderer) reaches the Rust backend only through `#[tauri::command]` handlers gated by the capability allowlist in [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json) and the CSP in [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json). Capability-based; deny-by-default in spirit (a command must be both registered with `agaric_commands!` and permitted by capability before the frontend can invoke it).
2. **Backend ↔ SQLite.** Database file in the user's home directory; the trust boundary is the operating system filesystem permissions on `~/.local/share/com.agaric.app/`. No application-level encryption at rest; the OS handles disk encryption (FileVault / BitLocker / LUKS / Android FBE), and SQLCipher was rejected for cost-vs-threat reasons documented in [`tooling.md`](tooling.md#storage).
3. **Sync daemon ↔ LAN peer.** TLS with mTLS between paired devices; self-signed certificates pinned on first observation (TOFU). Pairing state lives in the database; the verification path is in [`src-tauri/src/sync_daemon/server.rs`](../../src-tauri/src/sync_daemon/server.rs) (see `verify_peer_cert`). The model assumes peers are the user's own devices; the LAN itself is **not** treated as a trusted medium even though the threat model treats adversarial-peer hardening as out of scope.
4. **Updater ↔ GitHub Releases.** Tauri's auto-updater fetches the manifest from `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` (see [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json)) and verifies the bundle against the embedded public key. Out-of-band, every release asset is also attested via SLSA provenance to Sigstore and the GitHub attestations API; end-user verification is optional but documented in [`docs/BUILD.md`](../BUILD.md).
5. **GCal OAuth.** The PKCE authorisation-code flow runs through a loopback HTTP server bound on a random localhost port (`tauri-plugin-oauth` → `oauth_callback::bind_one_shot`); tokens land in the OS keychain. Refresh tokens are long-lived; access tokens are short-lived but stored alongside refresh tokens in the same keyring entry.

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
   └──────────────────────┘                       └───┬──────────┬──────────┬─────┘
                                                     │          │          │
                                          B2: FS     │          │          │  B5: HTTPS +
                                          permissions│          │          │  OS keychain
                                                     ▼          ▼          ▼
                                            ┌─────────────┐ ┌────────┐ ┌────────────┐
                                            │  SQLite     │ │ Sync   │ │ Google     │
                                            │  notes.db   │ │ daemon │ │ Calendar   │
                                            │  + WAL      │ │        │ │ (OAuth)    │
                                            └─────────────┘ └───┬────┘ └────────────┘
                                                                │
                                                  B3: TLS + mTLS│ + TOFU pin
                                                                ▼
                                                       ┌────────────────┐
                                                       │  Paired peer   │
                                                       │  (user-owned)  │
                                                       └────────────────┘
```

Each labelled edge marks a trust transition. B1 is the IPC boundary (capability allowlist + CSP). B2 is the on-disk boundary (FS permissions; no app-layer encryption). B3 is the sync boundary (TLS + mTLS + TOFU). B4 is the updater boundary (Sigstore-attested release artefacts + minisign signature on the bundle). B5 is the GCal OAuth boundary (PKCE flow over HTTPS; tokens at rest in the OS keychain). The diagram intentionally omits the MCP UDS socket and the loopback OAuth callback port — they are listed under Attack surface enumeration below; promoting them to the diagram would clutter it without adding distinct trust transitions (UDS is a process-local socket gated by file mode; the OAuth callback port is a one-shot bind during a single interactive flow).

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
| Notes content | **Tampering** — a crash mid-transaction leaves the database in a half-applied state, or a migration corrupts a previously-shipped table. | Low | High | WAL mode + foreign keys on every connection (`src-tauri/src/db.rs`); migrations are append-only and enforced by the `migrations-immutable` prek hook; new tables are required to use `STRICT` mode by the `migrations-strict-tables` hook. The append-only op log gives a recovery surface for content even if a derived table is corrupted. | Mitigated |
| Notes content | **Repudiation** — operations are not signed; an op log entry cannot be cryptographically tied back to which device authored it. | Low | Low | Single-user model — every device is the same person; per-device authorship is recorded as a hint, not as a signature. The hash-chain on the op log defends *integrity* (no silent reordering or insertion), which is the property the threat model actually wants. | Accepted |
| Notes content | **Information disclosure** — backups, sync exports, or `bug_report` payloads expose plaintext notes outside the app. | Med | Med | The `bug_report` IPC (`src-tauri/src/commands/bug_report.rs`) applies a **deny-by-default per-field-value redactor** — anything not matching a safe-token allowlist becomes `[REDACTED]`. Backups are an explicit user action and surface their location prominently. The rolling log file (`agaric.log`) lives inside the app data dir under the same FS-permission boundary as `notes.db`; in-process logging is *not* redacted (`src/lib/logger.ts` is a thin console wrapper), so a frontend `log::info!` that includes user content would persist that content to the log file — relevant only to attackers with local FS access (already out-of-scope, see [`SECURITY.md`](../../SECURITY.md#out-of-scope)). Disk-at-rest encryption is delegated to the OS (FileVault / BitLocker / LUKS / FBE). | Mitigated |
| Notes content | **Denial of service** — a corrupted database wedges the application; the user cannot open the app to back up their content. | Low | Med | Migrations refuse to run against an unrecognised schema rather than mutating it; the WAL gives a partial recovery surface. The `bug_report` workflow can extract the raw `notes.db` regardless of FE state. | Mitigated |
| Notes content | **Elevation of privilege** — a frontend caller reads database rows that the application logic intended to gate (e.g. a soft-deleted block, a different space's blocks). | Low | Med | All multi-space queries are space-scoped at the SQL layer; soft-delete filtering is enforced in the query, not in the renderer; sqlx compile-time checks the query shape against the schema. | Mitigated |
| Sync peer trust state | **Tampering** — a forced edit to the `peer_records` table changes the pinned cert hash and silently re-pairs with a different device. | Low | Med | Same FS-permission boundary as notes content; a writer with that access has already won. The TOFU model intentionally records the *first* hash and refuses subsequent ones (`src-tauri/src/sync_daemon/server.rs`), so the failure mode is a hard rejection rather than a silent re-pair. | Accepted |
| OAuth tokens | **Information disclosure** — refresh tokens leak via a `log::info!` that prints the token, or a `bug_report` includes the keyring entry. | Low | High | OAuth tokens live in the OS keychain via the `keyring` crate (Secret Service / Keychain / Credential Manager), never in `notes.db`. The `bug_report` deny-by-default redactor (`src-tauri/src/commands/bug_report.rs`) replaces any field value not on a safe-token allowlist with `[REDACTED]` when generating support bundles. The frontend `logger.ts` is a thin console wrapper with no redaction — code authors must not pass token material into log payloads (enforced by review, not by a layered control). | Mitigated |

### B3 — Sync daemon ↔ LAN peer

The framing here matters: the threat model treats LAN peers as the user's own devices. TLS + mTLS + TOFU exist to prevent *accidental* cross-talk (two users on the same Wi-Fi, a device wiped and re-installed under the same hostname) and to give the encrypted channel that the local-first community expects of any networked product. They are **not** a defence against an adversarial peer who has been let into the pairing graph. Reports framed against an adversarial-peer model are filed under the out-of-scope clauses of [`SECURITY.md`](../../SECURITY.md#out-of-scope).

| Asset | Threat (STRIDE) | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| Notes content | **Spoofing** — another device on the LAN advertises the same mDNS service name as a paired peer and accepts the connection. | Low | Med | mTLS handshake requires the client cert CN to match the claimed device-ID and the cert hash to match the TOFU-pinned hash (`verify_peer_cert` in [`src-tauri/src/sync_daemon/server.rs`](../../src-tauri/src/sync_daemon/server.rs)). A spoofed peer will fail both checks. | Mitigated |
| Notes content | **Tampering** — a man-in-the-middle on the LAN edits sync packets in flight. | Med | High | TLS via `rustls` gives confidentiality + integrity on the channel; mTLS authenticates both endpoints to each other. Within the threat model this is sufficient (peers are the user's own devices); an active LAN MITM with the keys to spoof a paired identity is out of scope. | Mitigated (within model) |
| Notes content | **Repudiation** — a peer denies having sent an op-log mutation. | Low | Low | The op log is hash-chained; reorder or insertion is detected at apply time. Per-device authorship is recorded but not cryptographically signed. Single-user model means there is no third party to repudiate to. | Accepted |
| Notes content | **Information disclosure** — passive eavesdropping on the LAN. | Low | High | TLS encryption on every sync connection. Anonymity properties of the sync graph (who is paired with whom, traffic-analysis resistance) are explicitly out of scope per [`SECURITY.md`](../../SECURITY.md#out-of-scope). | Mitigated |
| Notes content | **Denial of service** — a peer floods the daemon with malformed packets, the decoder panics or wedges. | Low | Low | Single-user model — peers are the user's own devices, not adversarial. Decoder hardening against hostile peer input is welcomed as regular bugs but not treated as a security finding. See [`SECURITY.md`](../../SECURITY.md#out-of-scope) "DoS / rate-limit scenarios against any local-only listener". | Out-of-scope |
| Sync peer trust state | **Spoofing** — a wiped-and-reinstalled device re-pairs with the same device-ID but a fresh cert; the TOFU pin rejects the new cert. | Med | Low | This is the intended failure mode. The user is shown a clear "this device's identity has changed" UI; re-pair is a deliberate action, not an automatic accept-on-conflict. The TOFU pinning logic refuses to overwrite an existing pin (`src-tauri/src/sync_daemon/server.rs`). | Mitigated |
| Sync peer trust state | **Tampering** — a race between two simultaneous first-pairing attempts overwrites each other's pinned hash. | Low | Low | The TOFU code path serialises the write and rejects the second attempt rather than overwriting; see the race-window comment in [`src-tauri/src/sync_daemon/server.rs`](../../src-tauri/src/sync_daemon/server.rs). | Mitigated |
| Notes content | **Elevation of privilege** — a paired peer issues op-log mutations beyond what the user intended (e.g. one device wipes another device's notes). | Low | High | Per the framing above, peers are the user's own devices and intentional mutation by any of them is in-scope behaviour, not an attack. Hardening against a *compromised* paired device (a stolen laptop that still holds a valid TLS cert) is **out-of-scope** — see [`SECURITY.md`](../../SECURITY.md#out-of-scope) "Adversarial-peer hardening". Mitigation, when one becomes necessary, would be revocation of paired device certs from a healthy peer plus replay-resistance on the op log. | Out-of-scope |

### B4 — Updater ↔ GitHub Releases

The updater is the only outbound network call the application makes that is **not** scoped to LAN sync or to a user-initiated cloud integration. A compromise here ships malware to every user; it is the most consequential boundary in the model.

| Asset | Threat (STRIDE) | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| Release artefacts | **Spoofing** — DNS poisoning or a mis-configured update server redirects the in-app updater to a malicious endpoint. | Low | High | The updater endpoint is hard-coded to `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` in [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json); HTTPS gives certificate authentication on the wire. Crucially, the **payload** carries its own minisign signature checked against the embedded `plugins.updater.pubkey` — even a successful endpoint hijack does not bypass the in-app signature check unless the attacker also holds the signing private key. | Mitigated |
| Release artefacts | **Tampering** — a malicious release asset is uploaded to the GitHub release, or an upstream Actions runner injects a malicious binary into the build. | Low | High | Every release asset is signed by the `TAURI_SIGNING_PRIVATE_KEY` (signature verified at install time via minisign), and every asset is attested via SLSA build provenance to Sigstore and the GitHub attestations API (`actions/attest-build-provenance@v3`). Source workflows are SHA-pinned (no floating `@v3`), and `_validate.yml` runs the full prek gate on every release tag. | Mitigated |
| Release artefacts | **Repudiation** — a release was published; the maintainer denies authorship. | Low | Low | SLSA provenance binds the artefact to the GHA workflow run that produced it (publicly logged); release tags are signed via the `required_signatures` repository ruleset. | Mitigated |
| Release artefacts | **Information disclosure** — the updater discloses the user's installed version to the release endpoint via the request fingerprint. | Med | Low | Release manifest fetches are anonymous GETs against a public CDN; the information leak is bounded to the user's install of a public binary, which is not treated as sensitive. | Accepted |
| Updater signing keys | **Spoofing** — an attacker who holds the leaked `TAURI_SIGNING_PRIVATE_KEY` signs a malicious update; the in-app signature check passes. | Low | High | Documented rotation procedure with annual cadence and immediate rotation on suspected compromise (see [`SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation)). Revocation is implicit and bidirectional: a rotated bundle will not validate against the old in-app pubkey, and the new in-app pubkey will not accept an old-key payload. The Sigstore-keyless alternative is deferred pending upstream Tauri support. | Accepted |
| Updater signing keys | **Information disclosure** — the private key leaks via CI logs, an actions-cache poisoning, or a maintainer-machine compromise. | Low | High | The secret is stored in GitHub Actions repository secrets; CI workflows mask secret values in logs; `zizmor` lints workflows for known leak patterns; SHA-pinned actions prevent a rogue dependency from exfiltrating. Trust-anchor compromise of the maintainer machine is acknowledged as un-mitigable in-repo (see [`SECURITY.md`](../../SECURITY.md#trust-anchors)). | Accepted |
| Release artefacts | **Denial of service** — GitHub Releases is unreachable; the updater cannot fetch the manifest. | Med | Low | The application continues to run on the currently-installed version; the updater is best-effort and surfaces a non-blocking toast on failure. | Accepted |
| Release artefacts | **Elevation of privilege** — a malicious updater payload runs at install time with installer privileges. | Low | High | The in-app signature check (minisign against the embedded pubkey) is the gate. SLSA provenance is the verification path for sophisticated users; OS-level code signing is intentionally not in place today (see the no-OS-signing tradeoff in [`ci-and-tooling.md`](ci-and-tooling.md#slsa-provenance-sigstore-and-the-unsigned-binary-tradeoff)). Windows SignPath OSS is in flight (tracked as `CI-R3` in [`../../pending/REVIEW-LATER.md`](../../pending/REVIEW-LATER.md)); macOS notarisation is a strict no-go for the current cycle (`CI-R11`). | Mitigated (in-app) / Accepted (OS-layer first-launch UX) |

### B5 — GCal OAuth

Only the Google Calendar integration uses OAuth today; the row pattern below generalises to any future OAuth integration that lands.

| Asset | Threat (STRIDE) | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| OAuth tokens | **Spoofing** — a third party impersonates the user to Google. | Low | High | PKCE flow (RFC 7636) via `tauri-plugin-oauth` binds the authorisation code to a code-verifier that never leaves the device. The callback runs on a one-shot loopback HTTP server (`oauth_callback::bind_one_shot` in `src-tauri/src/gcal_push/oauth_callback.rs`) and rejects requests after the first valid redirect. | Mitigated |
| OAuth tokens | **Tampering** — a man-in-the-middle on the network intercepts the redirect and rewrites the code. | Low | High | Authorisation runs over HTTPS to Google; the redirect lands on loopback, where there is no network path for a MITM to insert. PKCE binds the code to the code-verifier, so even a leaked authorisation code cannot be exchanged for a token without the verifier. | Mitigated |
| OAuth tokens | **Repudiation** — the user denies having authorised the integration. | Low | Low | Google's own OAuth consent records are authoritative; the application records the connected account email per space, surfaceable from Settings. | Accepted |
| OAuth tokens | **Information disclosure** — tokens leak via logs, the keychain backend is misconfigured, or a `bug_report` includes the keyring entry. | Low | High | Tokens live in the OS keychain via the `keyring` crate (Secret Service / Keychain / Credential Manager — see [`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml)). The `bug_report` deny-by-default redactor (`src-tauri/src/commands/bug_report.rs`) drops any field value not on a safe-token allowlist; keyring contents are never read by the bug-report flow. The frontend `logger.ts` has no redaction layer — code authors must not pass token material into log payloads (enforced by review, not by a layered control). | Mitigated |
| OAuth tokens | **Denial of service** — Google revokes the token while the user is offline; the integration refuses to sync. | Med | Low | The integration surfaces a typed `Gcal` `AppError` variant (passes through `sanitize_internal_error` unaltered) so the FE shows a clear "reconnect Google Calendar" prompt. No silent retry storms. | Mitigated |
| OAuth tokens | **Elevation of privilege** — the granted scope exceeds the operations the application performs. | Low | Med | The OAuth scope set is enumerated at connect time and matches the operations the agenda surface needs (read + write on the user's primary calendar). Adding a scope requires a code change reviewed against this list. | Mitigated |

## Attack surface enumeration

The boundaries above are the *control* surfaces. The list below is the *attack* surface — every place an external byte enters the process or a local byte leaves it. Reviewers walk this list when adding a feature to check whether a new entry needs to appear.

**Network listeners.**

- Sync daemon TCP listener (`src-tauri/src/sync_daemon/orchestrator.rs`, `server.rs`). Binds on a configured port on each non-loopback interface; rustls + mTLS terminates the channel. mDNS / multicast service advertisement attaches to the same lifecycle (see `discovery.rs`, with the Android multicast-lock JNI carve-out in [`android_multicast.rs`](../../src-tauri/src/sync_daemon/android_multicast.rs)).
- OAuth callback loopback server (`src-tauri/src/gcal_push/oauth_callback.rs`). One-shot bind on a random loopback port for the duration of a single interactive OAuth flow; rejects after the first valid redirect.
- MCP UDS socket — a Unix domain socket under the app data directory (`src-tauri/src/commands/mcp.rs`). RO and RW variants; gated by a marker file in the app data directory; not a TCP listener. File-mode is the trust boundary.

**File paths.**

- `~/.local/share/com.agaric.app/` (Linux) and the OS-correct equivalent elsewhere — hosts `notes.db` + WAL, sync peer state, the MCP socket, the MCP enable markers, and the log file (`agaric.log` rolled by `tracing-appender`).
- OS keychain entries — `oauth_tokens_<SPACE_ULID>` per connected space, plus the sync TLS certificate's private key under a keyring entry rather than on disk plaintext. See [`tooling.md`](tooling.md#storage).
- Tauri updater cache — operating-system-dependent location; transient.

**IPC commands.**

- The full handler tree is enumerated by `agaric_commands!` in `src-tauri/src/lib.rs` and lives under `src-tauri/src/commands/*.rs` (`agenda.rs`, `attachments.rs`, `bug_report.rs`, `compaction.rs`, `drafts.rs`, `gcal.rs`, `history.rs`, `journal.rs`, `link_metadata.rs`, `logging.rs`, `mcp.rs`, `pages.rs`, `properties.rs`, `queries.rs`, `spaces.rs`, `sync_cmds.rs`, `tags.rs`, plus the block-scoped tree under `commands/blocks/`). Every handler routes its error path through `sanitize_internal_error` (`src-tauri/src/commands/mod.rs`), enforced by the `tauri-command-sanitize` prek hook. Capability gating is in [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json).

**External services touched.**

- **GitHub Releases** — the in-app updater fetches `https://github.com/jfolcini/agaric/releases/latest/download/latest.json` and the bundle URL the manifest references.
- **Google Calendar API** — OAuth-scoped read + write on the user's primary calendar; only when the user has explicitly connected an account.
- **GitHub Attestation API + Sigstore Rekor** — fetched only by users who choose to verify SLSA provenance out-of-band (commands documented in [`docs/BUILD.md`](../BUILD.md)); the running application itself does not call this surface.

**Supply-chain entry points.**

- npm registry — `package-lock.json` pinning, `npm audit signatures` (Sigstore provenance verification, warn-only), `better-npm-audit` against [`.nsprc`](../../.nsprc).
- crates.io — `Cargo.lock` pinning, `cargo deny check` driven by [`src-tauri/deny.toml`](../../src-tauri/deny.toml) (block tier), `cargo audit` (warn tier).
- GitHub Actions marketplace — every `uses:` SHA-pinned; [`.github/dependabot.yml`](../../.github/dependabot.yml) bumps weekly; `zizmor` lints workflows.

## Out of scope

The lists in [`SECURITY.md`](../../SECURITY.md#out-of-scope) are canonical; this section restates them in the threat-model frame so a reviewer skimming this page does not have to chase the cross-link.

- **Adversarial LAN peers.** Sync peers are the user's own devices. Decoder panics under hostile peer input, packet-injection attacks against a paired peer, traffic-analysis on the sync graph — all welcome as regular bugs, none treated as security findings.
- **Root-on-device attackers.** An attacker who already has read/write access to `~/.local/share/com.agaric.app/` already holds the user's data and the keychain entries the user's session has unlocked. Local-first apps store local data; that is the model.
- **Supply-chain attacks against transitive dependencies already covered by `cargo-deny`.** The block / warn / time-boxed-waiver tiers documented in [`ci-and-tooling.md`](ci-and-tooling.md#advisory-handling--three-concentric-rings) are the current control. Findings against entries on the `deny.toml` ignore list need to be raised against the ignore-entry rationale, not the dependency.
- **Multi-user / multi-tenant scenarios.** Every paired device belongs to the same person. There is no concept of "other users" with separate permissions inside an Agaric install.
- **Network-exposed servers, server-mode builds, hosted backends.** None exist; if any were proposed, this document and [`SECURITY.md`](../../SECURITY.md) would be revisited *before* the change landed.
- **Mobile MDM, secure-enclave attestation, jailbreak detection.** Out of scope; the application targets desktop primarily and a single-user Android build secondarily, and assumes the OS provides the device-integrity story.
- **DoS / rate-limiting on local-only listeners.** Sync daemon, OAuth callback, MCP socket — all bound to loopback or LAN with the single-user trust model.
- **Anonymity properties of the LAN sync protocol.** Who is paired with whom, traffic-analysis resistance — not in scope.

A proposed change that shifts any of these items into scope (a server build, a multi-user feature, a public deployment, an external-maintainer access model) must update this document and `SECURITY.md` before the change lands. The trust-anchor and mitigation lists upstream of this file all assume the local-first, single-user framing; widening that framing without revisiting them would silently un-mitigate items the documents currently claim mitigated.

## Open questions

Living artefact — this section is allowed to be empty, and any entry here is an item the threat model has not yet committed to. As of the current revision:

- **Sigstore-keyless updater signing** — adoption deferred pending upstream Tauri support maturity. When it lands, the B4 boundary's "leaked `TAURI_SIGNING_PRIVATE_KEY`" row downgrades from Accepted to Mitigated and the rotation procedure in [`SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation) is rewritten around ephemeral Fulcio certificates.
- **Windows code signing (SignPath OSS)** — application in flight, tracked as `CI-R3` in [`../../pending/REVIEW-LATER.md`](../../pending/REVIEW-LATER.md). When it lands, the B4 "first-launch UX" row tightens from Accepted to Mitigated on Windows.
- **macOS notarisation** — explicit no-go for the current cycle, tracked as `CI-R11` in [`../../pending/REVIEW-LATER.md`](../../pending/REVIEW-LATER.md). The row remains Accepted until a downstream packager forces a revisit.

When any of the above ships, the corresponding STRIDE row above gets updated and the entry here is removed in the same commit.
