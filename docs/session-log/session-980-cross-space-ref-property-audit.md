## Session 980 — detect cross-space synced ref properties (audit A5) (#436) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#436` |
| **Dimension** | correctness (latent integrity; P3 / verified low) |
| **Tests added** | +1 (A5 detection incl. orphan tolerance + `space`-key exemption); updated 1 |
| **Files touched** | 2 |
| **Schema / wire-format** | none (runtime `sqlx::query`, no `.sqlx` change) |

**Summary:** The two cross-space validators (`validate_content_cross_space_refs`,
`validate_ref_property_cross_space`) run only on the LOCAL command paths; the
sync-ingress / bulk-import apply path has no cross-space gate. The audit's
adversarial verification narrowed the *real* residual gap: link/tag-ref EDGES
already carry a PEND-15 Phase-3 **write-time** cache filter on the sync path
(`reindex_block_links` / `reindex_block_tag_refs`), so synced cross-space links
are NOT materialized — but **ref-type `block_properties` (`value_ref`, e.g.
`linked_page`)** are written verbatim into the source-of-truth table with no
equivalent filter and no audit-diagnostic category (A1–A4 omit ref properties).

**Why detection, not write-time gating:** a synced op is already committed in
the CRDT, so rejecting or skipping it on apply would diverge SQL from the
authoritative engine state — for a source-of-truth table that is worse than the
latent gap. The links/tags Phase-3 path can filter a *derived cache*; a
source-of-truth table cannot be silently filtered without a divergence-tolerant
design. That is a deferred design decision, out of scope for a P3/low. The
issue's narrowed recommendation is exactly "add a ref-property category to the
audit diagnostic" — the safe, complete remediation here.

**Change:**
- New **A5** category in the read-only `audit_cross_space_refs` diagnostic:
  cross-space ref-type `block_properties` rows, using the orphan-tolerant rule
  of `validate_ref_property_cross_space` (both spaces assigned and differing;
  the `space` key exempt). Runtime `sqlx::query` → no `.sqlx` regen. Wired into
  `AuditReport` / `run_audit` / `format_report` (4→5 categories).
- Updated `cross_space_validation.rs` module doc (the exact "not yet gated — a
  follow-up" comment #436 cited) to record that A5 now provides detection and
  that write-time apply-path gating remains a deferred, divergence-aware design
  decision.

**Files touched:**
- `bin/audit_cross_space_refs.rs` — A5 category + `audit_a5` + report wiring + test; updated the empty-pool format test (5 categories).
- `spaces/cross_space_validation.rs` — module-doc clarification (no code change).

**Verification:**
- New `audit_detects_cross_space_ref_property`: a Personal→Work `linked_page`
  property is the only A5 hit; an orphan-target `project` ref is tolerated; a
  cross-pointing `space` key is exempt; A1–A4 stay 0.
- `cargo nextest run --bin audit_cross_space_refs` → **12 passed**. clippy +
  rustfmt clean; lib builds.

**Commit plan:** single commit; branched off `main`; PR against `main`.
