## Session 935 — #145 OSSF-3: Scorecard Vulnerabilities (gtk3 RUSTSEC waivers) (2026-06-01)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-01 |
| **Subagents** | orchestrator only (config/dependency triage) |
| **Items closed** | #145 |
| **Items modified** | #145 |
| **Tests added** | +0 (config-only; verified via `cargo deny check` + `cargo audit`) |
| **Files touched** | `src-tauri/deny.toml`, `src-tauri/.cargo/audit.toml` (generated), 1 session log |

**Summary:** Triaged the ~22 RUSTSEC advisories that zero out OSSF Scorecard's
`Vulnerabilities` check. The dependency tree is still on `gtk 0.18` / `wry 0.55` /
`tauri 2.11` — the GTK4 migration has NOT landed upstream, so the gtk-rs GTK3 binding
advisories (RUSTSEC-2024-0411..0420) plus the other "no longer maintained" transitive
notices remain genuinely unfixable transitive deps and stay waived. Live set confirmed
via a target-agnostic `cargo audit` run with the ignore list removed: **21 live
advisories**, all already present in `deny.toml`.

**Key finding — two scanners, two views:** `cargo deny` prunes the graph to the four
`[graph].targets`, so 3 entries report `advisory-not-detected` even though they are live
in the full-lockfile scan that `cargo audit` / OSV / Scorecard use:
- RUSTSEC-2023-0089 (atomic-polyfill, via loro→heapless→postcard)
- RUSTSEC-2024-0429 (glib 0.18.5 unsound `VariantStrIter`, function-scoped)
- RUSTSEC-2026-0097 (rand `thread_rng` unsound, function-scoped)
These MUST stay; a header comment now documents this so they aren't wrongly purged on
the strength of the cosmetic cargo-deny warning.

**Change made:**
- Removed the now-stale `RUSTSEC-2023-0071` (rsa Marvin Attack via sqlx-mysql) waiver —
  current sqlx 0.8.x no longer pulls the `rsa` crate (absent from `Cargo.lock`); both
  cargo-deny and cargo-audit confirm it is not present. Left a breadcrumb comment to
  re-add it if a future sqlx bump reintroduces `rsa`.
- Added an OSSF-3 header block to `[advisories]` documenting the gtk3 root cause, the
  revisit trigger (Tauri GTK4 migration complete → drop entries + re-run Scorecard), and
  the cargo-deny vs cargo-audit divergence.
- Regenerated `src-tauri/.cargo/audit.toml` via `scripts/sync-audit-from-deny.mjs`
  (22 → 21 advisories); `--check` mode passes.

**Verification:**
- `cd src-tauri && cargo deny check` — `advisories ok, bans ok, licenses ok, sources ok`
  (3 documented `advisory-not-detected` warnings, exit 0).
- `cd src-tauri && cargo audit` — exit 0, no un-waived advisories.
- `node scripts/sync-audit-from-deny.mjs --check` — in sync (exit 0).
- `taplo fmt --check src-tauri/deny.toml` — clean.

**Process notes:** The issue body's tracking link (wry#802) actually points at a 2022
macOS-beep PR, not the GTK4 tracking item — flagged in the issue update for the
maintainer to correct. Score recovers automatically when upstream wry/tauri finish the
GTK4 migration; until then the waivers are the correct, documented disposition. No app
source touched (db.rs / migrations left to the concurrent main agent).

**Commit plan:** single commit / pushed; PR opened, not merged.
