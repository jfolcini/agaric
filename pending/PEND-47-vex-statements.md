# PEND-47 — publish OpenVEX statements on releases

**Goal**: flip `OSPS-VM-04.02` (account for non-affecting vulnerabilities in VEX) from Unmet → Met on the OpenSSF Best Practices form (project 12870).

## Current state

Every release ships per-platform SBOMs (SPDX-JSON + CycloneDX-JSON) attested under SLSA build provenance. The SBOMs list every dependency; an external scanner running against an SBOM will flag CVEs that affect a transitive dep — even when Agaric's call patterns make the vulnerable code path unreachable from the app.

Right now we have no machine-readable statement saying "Agaric does not use the vulnerable path; this CVE does not affect Agaric." We do have prose statements in `src-tauri/deny.toml` `[advisories].ignore` rationale, but those aren't published in a scanner-consumable format.

OpenVEX 0.2.0 (Vulnerability Exploitability eXchange) is the canonical format: a JSON-LD document with one statement per (advisory, product, status) triple, where status ∈ `not_affected | affected | fixed | under_investigation`.

## Acceptance criteria

1. Release workflow produces a `vex.openvex.json` artifact per release (single file covering all platforms — VEX statements aren't platform-scoped).
2. The VEX file enumerates every advisory currently waived in `src-tauri/deny.toml` `[advisories].ignore` with the corresponding rationale as the `justification` field (typically `vulnerable_code_not_in_execute_path`, `inline_mitigations_already_exist`, or `component_not_present` per the OpenVEX vocabulary).
3. VEX file attached to each release as an asset and attested under SLSA build provenance (same flow as the SBOMs).
4. `OSPS-VM-04.02` flipped to Met with a URL to a release's VEX asset.

## Approach

**Generation strategy options:**

- **(A) Hand-rolled JSON generator** — small Node or Python script reads `src-tauri/deny.toml`, parses the `[advisories].ignore` entries (each is `{ id = "RUSTSEC-...", reason = "..." }`), maps the reason text to an OpenVEX justification code via a small translation table, emits the OpenVEX JSON.
- **(B) `vexctl` tool** — the canonical OpenVEX CLI (Go binary). Pre-commit hook would be heavier; CI install via `taiki-e/install-action` if there's a release.
- **(C) `cargo audit --json` + post-process** — generate VEX from the audit output. Loses the per-advisory rationale we already have.

Recommend (A) — keeps the existing `deny.toml` as the source of truth; the script is ~40 lines of Python. Lives at `scripts/generate-vex.mjs` for parity with `scripts/merge-vitest-coverage.mjs`.

**Wiring into release.yml:**

```yaml
- name: Generate OpenVEX statements
  run: node scripts/generate-vex.mjs > agaric-${{ matrix.target }}.openvex.json

- name: Attest VEX
  uses: actions/attest-build-provenance@<sha>
  with:
    subject-path: agaric-${{ matrix.target }}.openvex.json

- name: Upload VEX to release
  run: gh release upload "$GITHUB_REF_NAME" agaric-${{ matrix.target }}.openvex.json --clobber
```

The VEX file is platform-independent in principle, but emitting one per platform mirrors the SBOM pattern and keeps the attest step simple (matrix dispatch). Future optimisation: emit one VEX in a single non-matrix job and attest once.

**Mapping table** (src-tauri/deny.toml reason → OpenVEX justification):

| `deny.toml` reason | OpenVEX status | OpenVEX justification |
| --- | --- | --- |
| "not maintained", "advisory only" | `not_affected` | `component_not_present` (if removed) or `vulnerable_code_not_in_execute_path` |
| "vulnerable function not called" | `not_affected` | `vulnerable_code_not_in_execute_path` |
| "mitigated by input validation" | `not_affected` | `inline_mitigations_already_exist` |
| "fixed in upstream X.Y.Z" | `fixed` | (no justification needed for `fixed`) |
| (unmatched / no rationale) | `under_investigation` | (placeholder; manual review required) |

## Out of scope

- VEX for transitive npm advisories — `.nsprc` covers them but the rationale format differs. Separate item if the OSPS criterion explicitly demands.
- Real-time VEX (consumed by Dependabot / Renovate at scan time). Static per-release JSON is what OSPS-VM-04.02 expects.
- vex-generating GitHub App. Self-contained shell + JSON.

## Estimated cost

M (2–3 h) — most of the cost is in the rationale→justification mapping table (one-time) and the release.yml wiring (mechanical). Future maintenance is automatic as long as `deny.toml` entries have a consistent reason format.

## Tracking

`OSPS-VM-04.02` row in REVIEW-LATER until this lands.
