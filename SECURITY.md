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
- **Accidental data exposure** — file modes that are too permissive on `notes.db` or `~/.local/share/com.agaric.app/`, secrets in logs (the `logger.ts` redactor missing a code path, a `log::info!` printing a private key), plaintext dumps of user content, IPC commands that return data outside the calling page.
- **Supply-chain concerns** — a direct or transitive dependency that ships a known CVE not yet covered by the `.nsprc` exception list, a typosquat in `package.json` / `Cargo.toml`, an install/post-install script that contacts an external network.
- **Threat-model violations in code** — anything that adds an outbound network call to a server the maintainer doesn't operate, opens a listening port the user didn't ask for, or otherwise widens the attack surface beyond "the user's own paired devices on a local network."
- **CSP / IPC bypass** — code that escapes Tauri's command allowlist, that lets the WebView reach arbitrary `file://` or `asset:` URLs, or that defeats the `default-src 'self'` policy declared in `tauri.conf.json`.
- **Crypto misuse** — incorrect use of the `rustls` / `chacha20poly1305` / `hkdf` / `blake3` / `rcgen` primitives the sync layer relies on (wrong nonce reuse, missing AAD, weak KDF parameters).

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

| Version                   | Supported                       |
|---------------------------|---------------------------------|
| latest `0.1.x` tag        | yes                             |
| earlier `0.1.x` tags      | no                              |
| pre-tag commits on `main` | best-effort, no guarantee       |

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

## Existing automated coverage

The repository already runs the following on every push to `main` and on every release tag — many classes of issue are caught here before they ship, so a report is most useful when it points at a class the existing tooling does **not** cover:

- **CodeQL** — JavaScript/TypeScript and Rust default queries (configured under GitHub Code scanning, baseline established in commit `91073a7`).
- **Dependabot** — npm and Cargo, with triage notes in `.nsprc` for accepted exceptions.
- **`prek` hook bundle** (`prek.toml`) — `gitleaks` (committed-secret scan), `cargo-deny` (license + advisory + crate-source policy), `cargo-machete` (unused deps), `npm audit` + `better-npm-audit` against `.nsprc`, and a `license-checker` pass.
- **`unsafe_code = "deny"`** in `src-tauri/Cargo.toml` — new `unsafe { … }` blocks fail CI before they land.

A report that points at an issue already covered by one of the above is still useful — it usually means a config gap. Please mention which tool(s) you ran when filing.
