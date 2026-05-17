# Security Policy

## Threat model — read this first

Agaric is a **single-user, multi-device, local-first** application with **no cloud connectivity**. Sync runs over the local network between devices the same user has explicitly paired. There is no maintainer-operated server. The full threat model is documented in [`AGENTS.md` § Threat Model](AGENTS.md#threat-model); the short version is:

- Notes never leave the user's devices.
- Sync peers are **the user's own devices**, not adversaries. TLS + mTLS guards data integrity and prevents accidental cross-talk; it is not a defence against an attacker on the LAN.
- Defensive effort is concentrated on **data integrity** — append-only op log, hash-chain consistency, atomic transactions — not on adversarial-peer scenarios.

That makes the in-scope / out-of-scope list shorter than for a typical web app, and it determines which reports get triaged as security findings versus regular bugs.

## In scope

A vulnerability report is welcome if you can demonstrate any of the following:

- **Memory safety / undefined behaviour** in the Rust backend, despite the crate-wide `unsafe_code = "deny"` lint. New `unsafe { … }` blocks slipping past review, FFI mistakes, or out-of-bounds reads in any `bytes::` / `&[u8]` decoder all count.
- **Accidental data exposure** — file modes that are too permissive on `notes.db` or `~/.local/share/com.agaric.app/`, secrets in logs (a `log::info!` or `console.log` that prints a private key or OAuth token; the rolling `agaric.log` is in-process and unredacted), the `bug_report` deny-by-default redactor missing a code path so user content leaks into a support bundle, plaintext dumps of user content, IPC commands that return data outside the calling page.
- **Supply-chain concerns** — a direct or transitive dependency that ships a known CVE not yet covered by the `.nsprc` exception list, a typosquat in `package.json` / `Cargo.toml`, an install/post-install script that contacts an external network.
- **Threat-model violations in code** — anything that adds an outbound network call to a server the maintainer doesn't operate, opens a listening port the user didn't ask for, or otherwise widens the attack surface beyond "the user's own paired devices on a local network."
- **CSP / IPC bypass** — code that escapes Tauri's command allowlist, that lets the WebView reach arbitrary `file://` or `asset:` URLs, or that defeats the `default-src 'self'` policy declared in `tauri.conf.json`.
- **Crypto misuse** — incorrect use of the `rustls` / `blake3` / `rcgen` primitives the sync and op-log layers rely on.

## Out of scope

These are not security bugs in this project — they are by design and reports describing them will be closed:

- "An attacker on the local network can see / modify sync packets." Mitigations exist (TLS, mTLS, TOFU pinning) but the threat model assumes the LAN is trusted; see AGENTS.md.
- "An attacker who already has filesystem access can read `notes.db`." Local-first apps store local data — that is the model, not a leak.
- "An attacker sends malformed sync messages and the daemon panics." Sync peers are the user's own devices, not adversarial. Robustness against accidental corruption is welcome (file a regular bug); panics under hostile peer input are not treated as security issues.
- DoS / rate-limit scenarios against any local-only listener (sync daemon, OAuth callback server, MCP socket).
- Vulnerabilities that require the user to install a malicious package outside the legitimate distribution channel — that is outside the project's control surface.
- Findings against pre-tag commits on `main`. Always reproduce against the latest tagged release.

## Supported versions

Agaric is pre-1.0. The supported version is **the latest tagged release on `main`** (`0.1.x`). Earlier `0.1.x` point releases do not receive security updates; the upgrade path is to bump to the latest tag, which stays binary-compatible with on-disk data per the append-only-migrations invariant in AGENTS.md.

| Version range             | Status        | Security updates                                       | EOL trigger                          |
|---------------------------|---------------|--------------------------------------------------------|--------------------------------------|
| Latest `0.1.x` tag        | Supported     | Until the next `0.1.x` tag (typically days to weeks).  | New `0.1.(x+1)` tag pushed.          |
| Earlier `0.1.x` tags      | End-of-life   | No backports — upgrade to the latest `0.1.x` instead.  | EOL the day a newer `0.1.x` ships.   |
| Pre-tag commits on `main` | Best-effort   | No guarantee — tagged releases are the supported unit. | Always best-effort (no EOL trigger). |
| `1.x` (post-1.0 cut)      | Policy TBD    | To be defined when 1.0 is cut.                         | Placeholder — not yet defined.       |

**Why there is no LTS branch for `0.1.x`.** The project is pre-1.0 with a single maintainer, and the upgrade path is binary-compatible with on-disk data (append-only migrations + op-log invariants documented in AGENTS.md), so users can always move to the latest tag without losing data. Maintaining a parallel LTS branch would cost more than the user benefit at this stage; the policy will be revisited at the 1.0 cut.

**End-of-life signalling.** An EOL `0.1.x` release is **not removed** from GitHub Releases — its artefacts stay downloadable for reproducibility / archive value (and for users who must temporarily pin to a prior version while investigating an upgrade regression). EOL only means "no further security updates for that point release; install the latest tag for the fix." The signal is implicit in the table above and in this document; there is no separate EOL announcement channel.

## How to report

**Do not open a public GitHub issue or PR for a security finding.** Use one of the following private channels, in this order of preference:

1. **GitHub Security Advisory** — open a draft via the "Report a vulnerability" button at <https://github.com/jfolcini/agaric/security/advisories/new>. This keeps the report inside the same threading model used for Dependabot triage, and GitHub will assign a CVE / GHSA identifier when the advisory is published.
2. **Email** — `jfolcini86@gmail.com`, subject prefix `[agaric security]`. PGP is not currently published; if you would like an encrypted reply, say so in the first message and a key will be exchanged out-of-band.

Please include in the report:

- The affected commit SHA or release tag.
- A reproduction (commands, sample files, or a minimal patch demonstrating the issue).
- Your assessment of impact and which in-scope category it falls under.
- Whether you intend to publish the finding and on what timeline.

## What to expect

- **Acknowledgement** within 7 days. If you do not get one, please re-send via the other channel — the maintainer is a single person and email occasionally gets buried.
- **Triage decision** (in scope / out of scope / duplicate / not-a-bug) within 14 days.
- For in-scope reports, a **fix or mitigation plan** within 30 days where feasible. If a fix requires upstream changes (e.g. a CVE in a dependency that has no patched release yet), the response will say so explicitly and link to the upstream tracker.
- **Public disclosure** happens via a tagged release containing the fix plus a published GitHub Security Advisory. Reporters are credited unless they ask not to be.

## Credits

Researchers who report a valid in-scope vulnerability are credited here unless they explicitly ask to remain anonymous. The credit lists the reporter, the GHSA / CVE identifier of the resolved advisory, and the first release that ships the fix.

| Reporter | Advisory | First fixed in |
| --- | --- | --- |
| _(none yet — this section will populate as advisories are resolved)_ | — | — |

> If you would prefer to remain anonymous, say so in your initial report and the row above will record only "anonymous" + the advisory ID. The disclosure timeline (acknowledgement within 7 days, triage within 14 days, fix-or-plan within 30 days where feasible) is the same either way.

## Existing automated coverage

The repository already runs the following on every push to `main` and on every release tag — many classes of issue are caught here before they ship, so a report is most useful when it points at a class the existing tooling does **not** cover:

- **CodeQL** — JavaScript/TypeScript and Rust default queries (configured under GitHub Code scanning, baseline established in commit `91073a7`).
- **Dependabot** — npm and Cargo, with triage notes in `.nsprc` for accepted exceptions.
- **`prek` hook bundle** (`prek.toml`) — `gitleaks` (committed-secret scan), `cargo-deny` (license + advisory + crate-source policy), `cargo-machete` (unused deps), `npm audit` + `better-npm-audit` against `.nsprc`, and a `license-checker` pass.
- **`unsafe_code = "deny"`** in `src-tauri/Cargo.toml` — new `unsafe { … }` blocks fail CI before they land.

A report that points at an issue already covered by one of the above is still useful — it usually means a config gap. Please mention which tool(s) you ran when filing.

## Threat-model reference (for maintainers)

The sections below are the canonical reference for triaging advisories and reviewing security-sensitive changes. The framing here lets a fresh contributor decide "is this finding something we already accepted, something we mitigate elsewhere, or something we need to fix?" without re-deriving the threat model each time.

For the **structured detail** — assets, trust-boundary enumeration, a data-flow diagram, and per-boundary STRIDE tables (the OSPS-SA-03.02 artefact) — see [`docs/architecture/threat-model.md`](docs/architecture/threat-model.md). That file is the structured complement to the prose below; it does not replace it. The prose here is what a triager skims when deciding whether a report is in scope; the structured page is what a reviewer audits when checking whether a new feature crosses a trust boundary the model has not yet accounted for.

### Trust anchors

Anything compromised below would bypass the rest of the policy. We trust:

- **The maintainer's machine.** Code is signed and tags are cut from a developer workstation. A compromise here ships malware to every user; no in-repo control mitigates this.
- **Anthropic / Claude Code.** Used as an authoring assistant. Outputs are reviewed before commit, but a malicious patch landing through this path would still be a maintainer-machine compromise (above).
- **GitHub.** Hosts source, releases, Actions runners, and the advisory database used by Dependabot / CodeQL. A GitHub-side compromise would defeat SHA-pinned actions and the release pipeline.
- **The npm registry and crates.io.** Dependency tarballs are fetched from these registries. Sigstore provenance (`npm audit signatures`) covers packages that publish it; the rest are trusted on registry integrity alone. A registry-side compromise would defeat lockfile hashes only if the original publish was malicious.
- **Direct dependency maintainers.** Especially Tauri, rustls, Loro, TipTap, SQLite, and the keyring crate. A malicious release would land via Dependabot and reach users at the next tag; lockfile pinning slows but does not prevent this.

### Untrusted inputs

These are the bytes that cross into Agaric from outside the trust boundary. Each one needs to survive whatever decoder receives it without granting code execution or data exfiltration:

- **Synced peer payloads (LAN).** Pairing is TLS + mTLS with TOFU pinning, but there is no application-layer authentication of peer messages beyond device identity. Per the threat model, peers are the user's own devices — we do not harden the protocol against adversarial peers (see Out-of-scope).
- **Loro CRDT bytes.** Op-log entries from a paired peer are decoded by the `loro` crate. Decoder panics on hostile input are not treated as security issues (peers are trusted) but are welcome as regular bug reports.
- **User-pasted text and clipboard.** Rendered through the TipTap editor and the custom markdown serializer; sanitisation lives in the editor extensions and `dompurify` (via mermaid).
- **File imports (Markdown, OPML, JSON exports).** Parsed by frontend importers; treated as user-supplied content, not adversarial.
- **OAuth tokens (Google Calendar today).** PKCE flow via `tauri-plugin-oauth`; tokens are stored encrypted at rest in the OS keychain via the `keyring` crate (Secret Service on Linux, Keychain on macOS, Credential Manager on Windows — see `src-tauri/Cargo.toml` keyring feature list).
- **WebView content.** Constrained by the Tauri CSP (`default-src 'self'`, see `src-tauri/tauri.conf.json`) and the per-window capability allowlist ([`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json)).

### Accepted risks

Each accepted finding lives in exactly one canonical file. Do not duplicate the lists here — update the source and the rationale travels with it.

- **npm advisories** — [`.nsprc`](.nsprc). Every entry carries an `expiresOn` 90 days out, forcing periodic re-triage. Current waivers cluster around dev-only transitive deps (`lodash` via `depcheck`, `vite` dev-server CVEs, `fast-uri` via `better-npm-audit`) and mermaid-family advisories that the single-user threat model neutralises (no adversarial input).
- **Cargo advisories** — [`src-tauri/deny.toml`](src-tauri/deny.toml) `[advisories].ignore`. Almost every entry is a Tauri-transitive GTK3 / unic / paste / proc-macro-error binding that has no upstream maintainer but cannot be removed without dropping Linux support. Add an entry only with a `reason =` that names the upstream blocker.
- **Zizmor workflow findings** — [`.github/zizmor.yml`](.github/zizmor.yml). Currently only `cache-poisoning` is baselined, justified by the AGENTS.md "single-user, no adversarial peers" framing — a poisoned Actions cache would only affect the maintainer's own builds. `unpinned-uses` is enforced (no baseline entries); every action is pinned to a 40-char SHA and bumped weekly by Dependabot.

### Mitigations

Each item below names the file or tool that enforces it. If you change one, update the corresponding control here.

- **Tauri CSP** — `default-src 'self'; script-src 'self'; …` declared in `src-tauri/tauri.conf.json`. Blocks inline scripts and arbitrary outbound fetches from the WebView.
- **Tauri capabilities** — per-window allowlist in [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json). Frontend can only invoke the listed plugin permissions; adding a new capability requires editing this file.
- **Lockfiles + `--locked` everywhere** — `package-lock.json` and `src-tauri/Cargo.lock` are committed. CI installs run with `--locked` (see `cargo install --locked` invocations in `.github/workflows/_validate.yml`, `ci.yml`, `release.yml`); `npm ci` is used in place of `npm install` in CI.
- **SHA-pinned GitHub Actions** — every `uses:` reference in `.github/workflows/` is pinned to a 40-char commit SHA with a `# vX` comment. [`.github/dependabot.yml`](.github/dependabot.yml) bumps these weekly.
- **`cargo audit` + `cargo deny check`** — one prek hook (`cargo-deny`, see `prek.toml`) and a CI step in `.github/workflows/_validate.yml`. `cargo-deny` covers RustSec advisories, license policy, banned crates (`openssl` family), and the source allowlist (crates.io only).
- **`npm audit signatures`** — Sigstore provenance verification in `.github/workflows/_validate.yml`. Warn-only today; tightens as more of the npm ecosystem publishes attestations.
- **`better-npm-audit` against `.nsprc`** — `npm-audit` prek hook (`prek.toml`) fails on any advisory not listed in `.nsprc`. The 90-day `expiresOn` ensures waivers do not become permanent.
- **`gitleaks` + `detect-private-key`** — `prek.toml` blocks committed secrets and stray PEM blocks.
- **`unsafe_code = "deny"`** — crate-wide lint in `src-tauri/Cargo.toml`. New `unsafe { … }` blocks fail CI.
- **`zizmor`** — workflow-security linter; baseline in `.github/zizmor.yml`, see Accepted risks above.
- **CodeQL** — default JS/TS + Rust queries on every push to `main`.
- **IPC error sanitisation** — `tauri-command-sanitize` prek hook (`scripts/check-tauri-command-sanitize.mjs`) requires every IPC error path to route through `sanitize_internal_error` so internal error payloads never reach the frontend.

### Out of scope

The following are explicitly outside this threat model. Reports that fit these categories will be closed; designs that would require us to address them must first propose updating this document.

- Multi-tenant deployments. Agaric has no concept of "other users" — every paired device belongs to the same person.
- Network-exposed servers. There is no maintainer-operated backend; the sync daemon binds to the LAN only.
- Mobile MDM, secure-enclave attestation, or jailbreak detection.
- Anonymity properties of the LAN sync protocol (who is paired with whom, traffic-analysis resistance).
- Adversarial-peer hardening. See AGENTS.md § Threat Model and the In-scope / Out-of-scope sections above.
- DoS / rate-limiting on local-only listeners (sync daemon, OAuth callback, MCP socket).

**If a future change shifts any of these into scope** — for example a server-mode build, a multi-user feature, or a public deployment — this document must be revisited _before_ the change lands. The trust anchors, untrusted-input list, and mitigation set above all assume the local-first, single-user framing.

## Updater signing-key rotation

The `TAURI_SIGNING_PRIVATE_KEY` repo secret is the **root of trust for every auto-update**: it signs the updater payload that `release.yml` ships (via tauri-action), and the matching public key embedded in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) (`plugins.updater.pubkey`) is what the in-app updater (`src/hooks/useUpdateCheck.ts`) checks before applying a new bundle. If that private key leaks **and** the attacker can also induce the user's app to fetch a malicious payload (DNS spoofing, GitHub release-asset replacement via account compromise), the in-app signature check passes and the malicious update installs cleanly. The key is long-lived; rotation is the documented response.

**Cadence.** Rotate at least annually. Rotate immediately on any suspected compromise (laptop loss, leaked CI logs, suspicious GitHub Actions activity). The annual rotation runs on a calendar reminder kept in the maintainer's personal calendar, not in the repo — there is no in-repo automation for it.

**Procedure.**

1. Generate a fresh keypair locally: `cargo tauri signer generate -w ~/.tauri/agaric-<YYYY-MM>.key`. Choose a strong password; the maintainer stores the password in the system keychain (Secret Service / Keychain / Credential Manager) via the same `keyring` crate the app uses for OAuth tokens. Never commit the private key.
2. Update the GitHub Actions repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the new private key file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (its password) under repo Settings → Secrets and variables → Actions.
3. Update the embedded **public** key in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) `plugins.updater.pubkey` (the `cargo tauri signer generate` output prints both halves; the public half is what goes here). Commit on `main`.
4. Cut a release with `scripts/bump-version.sh` — the matrix runs against the new secrets, the new bundle is signed by the new key, and the new binary embeds the new public key.
5. **Document the user-facing consequence in the release notes.** Existing installs hold the _old_ public key, so when their auto-updater fetches the new bundle the signature check fails (different key, signature can't be verified) and the update is refused. Users on the old binary will need to **manually download and re-install** the new release from GitHub Releases. This is the cost of rotation; advertise it loudly in the release notes and the GitHub Security Advisory (below) so users don't read the refusal as a bug.

**Revocation.** Tauri's updater ships no online revocation channel — there is no CRL, no OCSP, no Rekor lookup. The implicit revocation is bidirectional and mechanical: the new binary will not trust anything signed by the old key (its embedded pubkey is the new one), and the old binary will not trust anything signed by the new key. Both directions are blocked by construction. That is the only revocation path available today.

**User notification.** On any rotation (especially compromise-triggered): (i) publish a GitHub Security Advisory under <https://github.com/jfolcini/agaric/security/advisories> describing the rotation and the manual re-install requirement; (ii) pin a notice at the top of the README for the duration of the rotation cycle; (iii) include a one-shot toast in the next release announcing the rotation so users opening the app see it even if they never read release notes. For routine annual rotations, the README notice and release-notes mention are sufficient; an advisory is reserved for compromise-triggered rotations.

**Sigstore-keyless alternative (deferred).** Tauri 2.x has discussion threads on cosign / Sigstore-based updater payload signing (no long-lived key; ephemeral Fulcio certificates bound to a GHA OIDC identity, transparency-logged in Rekor). Upstream tracker: the Tauri v2 updater plugin docs at <https://v2.tauri.app/plugin/updater/> are the canonical reference; cosign-based signing is not yet a first-class option in the plugin as of this writing. See [`PEND-41`](pending/PEND-41-ci-tooling-review.md) R22 — adoption deferred pending upstream support maturity. Revisit when Tauri ships a stable Sigstore signing path; the migration would remove this section's reason for existing.
