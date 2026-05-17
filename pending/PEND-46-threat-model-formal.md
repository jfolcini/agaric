# PEND-46 — formal threat-model document

**Goal**: flip `OSPS-SA-03.02` (conduct threat modeling and attack surface analysis) from Unmet → Met on the OpenSSF Best Practices form (project 12870).

## Current state

`SECURITY.md` has a prose "Threat model — read this first" section and a more detailed § Threat-model reference (for maintainers). These describe the model in narrative form (single-user, multi-device, local-first, no cloud, sync peers are user's own devices).

`AGENTS.md` has a § Threat Model section that mirrors and extends the SECURITY.md text.

What's missing for OSPS-SA-03.02 is a **structured** threat model — typically STRIDE per asset, or an attack-tree, or a data-flow diagram with trust boundaries explicitly drawn. The prose treatment is enough for `assurance_case` (which we now claim Met) because the assurance case can compose from narrative; the OSPS criterion wants a recognisable threat-modelling artefact.

## Acceptance criteria

1. New file `docs/architecture/threat-model.md` (or similar) with:
   - **Assets**: enumerate what's worth protecting (notes content, sync peer trust state, OAuth tokens, signing keys, build artifacts).
   - **Trust boundaries**: at minimum (a) IPC frontend↔backend, (b) sync LAN, (c) update server (GitHub Releases), (d) GCal OAuth.
   - **Per-asset analysis**: STRIDE (Spoofing / Tampering / Repudiation / Information disclosure / Denial of service / Elevation of privilege) or equivalent. Each row: threat description, current mitigation, residual risk, accepted-or-mitigated.
   - **Attack surface**: list of network listeners, file paths, IPC commands, external services touched.
   - **Out-of-scope**: explicit re-statement that adversarial LAN peers, root-on-device attackers, and supply-chain attacks against transitive deps already covered by `cargo-deny` are out of scope.
2. Cross-link from `SECURITY.md` § Threat-model reference into the new doc as "structured detail".
3. `OSPS-SA-03.02` flipped to Met with a URL to the new file.

## Approach

1. Start from the existing prose in `SECURITY.md` § Threat-model reference and `AGENTS.md` § Threat Model. The substance is largely there — needs to be re-shaped into table form.
2. Use a 6-column STRIDE table per trust boundary:
   - Asset
   - Threat (STRIDE category + specific scenario)
   - Likelihood (Low/Med/High)
   - Impact (Low/Med/High)
   - Mitigation (current code / config that addresses it; link to file)
   - Status (Mitigated / Accepted / Out-of-scope)
3. Draw a simple ASCII or Mermaid data-flow diagram showing:
   - Frontend (renderer) ↔ Backend (Rust IPC) — capability-based allowlist boundary
   - Backend ↔ SQLite (on-disk; FS-permissions boundary)
   - Backend ↔ Sync daemon ↔ Network (mTLS + TOFU pinning boundary)
   - Backend ↔ GCal OAuth (OAuth 2.0 PKCE; OS keychain boundary)
   - Updater ↔ GitHub Releases (Sigstore + SLSA provenance boundary)
4. End with an "open questions" section that's allowed to be empty initially — the doc is meant to be a living artefact.

## Out of scope

- Attack-tree formalism (Microsoft Threat Modeling Tool / OWASP DragonFly export) — too heavy for a solo project at this stage.
- Formal verification or model checking.
- Threat modelling per-feature rather than per-trust-boundary.

## Estimated cost

M (2–3 h) — most of the content already exists in prose; the cost is in restructuring into tables + drawing the data-flow diagram.

## Tracking

`OSPS-SA-03.02` row in REVIEW-LATER until this lands.
