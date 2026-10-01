# Session 1860 — Scorecard Vulnerabilities: triage RUSTSEC-2026-0255 and generate osv-scanner waivers (#5207)

Scorecard's `Vulnerabilities` check read 0/10 even though every advisory it counted was already waived in `deny.toml` or `.nsprc`. One Rust advisory, RUSTSEC-2026-0255, had never been triaged. This session triages it. It also has `scripts/sync-audit-from-deny.mjs` write the `osv-scanner.toml` files Scorecard honours.

**RUSTSEC-2026-0255.** The advisory is against `sized-chunks` 0.6.5, which comes in through Loro 1.13.6's `im` stack. It is `informational = "unsound"` and has no patched release. If an element's `Drop` panics inside `clear`, `drop_left` or `drop_right`, that element is dropped twice. cargo-deny passed it because its `unsound` scope defaults to `workspace`; that scope is unchanged. `cargo audit` printed it as an allowed warning. It now sits in `deny.toml` next to its #3161 siblings. The reason gives the #3161 rationale and adds that shipped builds use the release profile's `panic = "abort"`, so the panicking `Drop` ends the process before the second free.

**A parser bug found on the way.** The first draft of that reason contained `[profile.release]`. The script finds the `ignore = [ … ]` array with a non-greedy `\[([\s\S]*?)\]`, so the `]` inside the reason ended the match early. Every later entry was silently dropped: RUSTSEC-2026-0097 disappeared from `audit.toml`, and `cargo audit` started printing it. The drift check stayed green, because it compares the script's output with itself. The closing `]` must now start its own line (`^\]` with `m`). The reason was also reworded so it contains no brackets.

**osv-scanner, checked before building.** I installed osv-scanner 2.6.0 with `go install` and ran `osv-scanner scan source -r .` from the worktree root. The vulnerability API was reachable.
- **Without config files** it exited 1 with 40 findings: 2 in `package-lock.json` (extract-zip, both GHSAs), 20 in `src-tauri/Cargo.lock` and 18 in `src-tauri/fuzz/Cargo.lock`. That is 20 distinct advisory groups, and Scorecard scores `10 − count` with a floor of 0.
- **With only `src-tauri/osv-scanner.toml`** in place, `src-tauri/Cargo.lock` was filtered, but the fuzz lockfile still showed all 18. Config is read per lockfile directory and is not inherited from a parent.
- **With all three files** in place (`src-tauri/`, `src-tauri/fuzz/`, root) it exited 0 with 0 findings: "Filtered 43 vulnerabilities". The filter matches on aliases too, so `RUSTSEC-2026-0097` also suppresses `GHSA-cq8v-f236-94qc`.
- **Scorecard's own path, from source.** The pinned `scorecard-action` v2.4.4 builds Scorecard v5.5.0, which uses osv-scanner v2.3.2. In 2.3.2, `normalizeConfigLoadPath` (the lockfile's directory plus `osv-scanner.toml`) is the same as in 2.6.0, and so is the alias-aware `filterPackageVulns`. Scorecard calls `DoScan` on its extracted tarball without a config override, and the extraction keeps every regular file. I did not run Scorecard itself: building it ran the disk out of space, so I removed the Go caches.
- **`.nsprc`.** Both entries' `notes` open with exactly one GHSA ID. Each matches the advisory URL that `npm audit --json` gives for that numeric source (1139346 → GHSA-jmr9-qjv8-65gv, 1193685 → GHSA-7pqw-9j4j-h8q3).

Both conditions of the issue's decision rule held, so I built it rather than the doc-only fallback.

**What changed.**
- `sync-audit-from-deny.mjs` also writes `src-tauri/osv-scanner.toml` and `src-tauri/fuzz/osv-scanner.toml` (the same 28 IDs from `deny.toml`). It writes a root `osv-scanner.toml` from `.nsprc`: the GHSA ID each entry's `notes` must open with, and `expiry` as `ignoreUntil`. Entries with `active: false` are skipped, as better-npm-audit skips them.
- An entry whose notes don't open with a GHSA ID, or whose expiry isn't `YYYY-MM-DD`, throws. `--check` names every stale file.
- The existing `audit-toml-in-sync` hook covers the new inputs and outputs. Only its `files` pattern and name changed; no hook was added.
- Docs: SECURITY.md now lists only `Code-Review` as a by-design 0, and says what `Vulnerabilities` counts. Its old bullet blamed GTK3 advisories. Also updated: ci-and-tooling.md § Advisory handling, the threat-model Claim 5 evidence line, and the pointer in `deny.toml`'s header comment. Those two paragraphs also named the `.nsprc` field `expiresOn`; better-npm-audit reads `expiry`.

**Worth knowing.**
- RustSec withdrew the ten GTK3 binding advisories (RUSTSEC-2024-0411…0420) on 2026-08-14. Their `deny.toml` entries now match nothing: cargo-deny reports them `advisory-not-detected`, and osv-scanner lists them as unused ignores. I did not remove them here.
- SECURITY.md still says `.nsprc` is empty and names `expiresOn` in § npm advisories (two places). Both are stale and unrelated to this change, so they are untouched.
- `generate-vex.mjs` classifies RUSTSEC-2026-0255 as `under_investigation`, like its #3161 siblings, because no `STATUS_MAP` rule matches that wording.

**Verified.**
- `cargo deny check advisories`: `advisories ok`, exit 0, before and after. There are 15 `advisory-not-detected` warnings (14 before, plus 0255 under the `workspace` unsound scope) and 1 yanked warning (chacha20).
- `cargo audit` in `src-tauri/`: 0 vulnerabilities and exit 0 before and after. Before, the warnings were the 0255 unsound one and the chacha20 yank. After, only the yank remains.
- `generate-vex.mjs` emits 28 statements.
- osv-scanner: 40 findings, exit 1, without the files; 0 findings, exit 0, with the generated files. The counts are above.
- `prek run audit-toml-in-sync --all-files --hook-stage manual` passes. `check-hook-budget.mjs` reports 129/140.
- **Falsification on copies** (each restored and `cmp`'d). The script has no test file, so each case was run by hand against `--check`:

  | Mutation | Result |
  |---|---|
  | drop 0255 from the generated fuzz `osv-scanner.toml` | red, names that file |
  | change one `.nsprc` expiry | red, names root `osv-scanner.toml` |
  | `.nsprc` notes not opening with the GHSA ID | throws |
  | drop 0255 from `deny.toml` | red, names all three Cargo-side files |
  | `]` in a reason, line-anchored parser | green (all 28 IDs kept) |
  | same `deny.toml`, old non-anchored regex restored | red, three files |
  | edit root `ignoreUntil`, run through prek | hook fails |
