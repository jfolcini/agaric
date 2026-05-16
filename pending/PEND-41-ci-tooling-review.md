# PEND-41 — Local tooling + CI review: decisions doc + recommendations backlog

## Status (updated 2026-05-16)

**Batch 1 landed in session 754** — 6 recs closed: R6 (`.editorconfig`), R7 (count tables + hook removed), R8 (conventional-commits commit-msg), R21 (`CODEOWNERS`), R26 (cache-key bump procedure in decisions doc), R27 (license-header non-policy in decisions doc). The decisions doc `docs/architecture/ci-and-tooling.md` has been seeded (15 sections, ≈2100 words).

**Out-of-band: lychee robustness landed in session 756** — `GITHUB_TOKEN` injection on the prek lint step, `actions/cache@v5` for `.lycheecache` persistence, `--max-concurrency` 8 → 4, `--cache` flag on lychee. Diagnosed mid-session as the root cause of recurring Dependabot-PR lint flakes. Not a numbered rec — separate sub-issue surfaced while merging Dependabot PRs.

**Batch 2 partial landed in session 757** — R20 (cargo-machete allowlist inline rationale comments — every entry now carries a reachability note + transitive path) and R25 (per-test slow-warning budgets: `vitest.slowTestThreshold = 2000`, `nextest leak-timeout = "30s"` on both profiles). The cargo-machete quarterly verification hook (R20 part 2 — `cargo tree --invert` reachability check) is explicitly deferred to a follow-up.

**R1 landed in session 758 (2026-05-16)** — every job across `_validate.yml`, `ci.yml`, `release.yml` carries a measurement-derived `timeout-minutes:` with an inline comment citing the source run-id, sample size, and the +50% headroom calculation. Numbers measured from run `25966040732` (the first post-PEND-39-split successful main-branch run); n=1 for the split worker jobs. Build-matrix timeouts use per-matrix-cell expressions (`${{ matrix.label == 'windows' && 65 || 50 }}` in ci.yml; `${{ matrix.platform == 'windows-2025' && 75 || 60 }}` in release.yml) to honour the windows-runs-slower observation rather than coarse single-value-fits-all budgets.

**Remaining:** Batch 2 leftovers (R5, R13, R17, R19), Batch 3 (R9, R10, R12, R18, R22, R23, R29, R30), Batch 4 (R2, R14, R15, R24), and long-horizon (R3, R4, R11).

## Context

Agaric (Tauri 2 + React 19 + Rust desktop/mobile, solo, public OSS, GPL-3.0-or-later, GitHub Releases with Tauri auto-updater). Recent tooling/CI work: PEND-39 (CI parallelisation: split `_validate.yml` into lint + vitest×3 + playwright×2 + cargo-tests + `validate-all` aggregate; Swatinem shared cache key; mold linker) and PEND-40 (supply-chain hardening: SHA-pinned actions, weekly Dependabot for GHA, SLSA provenance via `actions/attest-build-provenance@v3` on every release asset, zizmor baseline, gitleaks, cargo-deny + audit, `.nsprc` 90-day expiry).

This PEND captures the **decisions made** + the **recommendations backlog** produced by a strict review against industry best practices for robustness / maintainability / performance / security.

Two outputs:

1. **`docs/architecture/ci-and-tooling.md`** — a new decisions doc matching the prose-narrative style of the existing `docs/architecture/*.md` pages (no ADR numbering). Operational tooling + CI decisions and tradeoffs; not commands (those live in `docs/BUILD.md`); not language/IPC contracts (those live in `docs/architecture/tooling.md`). Written and updated as each rec lands.
2. **This file** — the recommendations / workplan backlog. As each rec ships, cross it off here and reflect the decision in the architecture doc. When the backlog is fully drained, delete this file.

**Workflow rule**: after every task in this backlog is done, update relevant docs in the same commit (decisions doc, AGENTS.md, BUILD.md, etc.). Docs are downstream of execution, not pre-baked.

This plan was built from six subagents in parallel: three Explore passes (CI workflows + release, prek + local hooks + docs, project shape + supply chain), one Plan agent for the doc structure + recs, one fact-check critic, one adversarial critic. The fact-check critic surfaced count corrections that have already been folded in below. User-feedback corrections to the first draft have also been folded in: R1 measures, doesn't imagine; R7 reverses to *remove* counts and hook; R11 is strict no-go for now; R12 documents the asymmetric branch-protection convention; R16 is uncertain pending decision.

## Verified ground truth

Numbers from explore-agent reports were inflated in several places. Authoritative values:

| What | Stale claim | Verified actual |
| --- | --- | --- |
| Pre-commit hooks | 42 | 49 (36 `[[repos.hooks]]` + 13 inline in `hooks = [...]` arrays) |
| Pre-push hooks | 1 | 2 (`no-commit-to-branch` at `prek.toml:14`, `verify-ci-equivalent` at `prek.toml:581`) |
| Rust files in `src-tauri/` | 228 | 358 |
| TS/TSX files in `src/` | 934 | 934 ✓ |
| Vitest test cases | 9874 (stale comment in `verify-ci-equivalent.sh:21`) | ≈9548 across 411 files |
| Rust `#[test]` / `#[tokio::test]` | 3500+ | 2528 |
| Playwright spec files | 29 | 28 |
| Linux desktop build "5-8 min with mold" | claimed | no such figure exists in repo; closest is "5-10 min" in `verify-release-build.sh` / `verify-ci-equivalent.sh` comments |
| `verify-ci-equivalent ~3-4 min`, `CI wall ~7-10 min` | claimed | anecdotal — present in maintainer comments (`prek.toml:562-563`, `_validate.yml:13-14`) but not measured |

Per the *no-counts-in-docs* feedback (R7), the architecture doc must not reproduce any of these numbers. They live here only to anchor the recs in reality.

Verified as accurate (use as anchors for the architecture doc): 100% SHA-pinning across 48/48 remote `uses:`; SLSA provenance steps for Linux (`release.yml:416`), Windows (`:425`), macOS both arches (`:435`), Android (`:634`); `validate-all` aggregate (`_validate.yml:351-352`); vitest 3-shard / Playwright 2-shard (`_validate.yml:189,217`); mold scope (validate + ci only, not release); `shared-key: rust-deps` vs `rust-android`; `save-if: main-only`; `unsafe_code = "deny"` at `src-tauri/Cargo.toml:41`; single `#![allow(unsafe_code)]` carve-out at `src-tauri/src/sync_daemon/android_multicast.rs:33` (unsafe blocks at `:105`, `:123` only); workflow-level `contents: read` with per-job write overrides; `id-token: write` + `attestations: write` only on attest jobs.

Absent (call this out in the doc): no `rustfmt.toml`, `clippy.toml`, `.editorconfig`, `.github/CODEOWNERS`, SBOM workflow step, commitlint / conventional-commits hook.

## Output 1 — `docs/architecture/ci-and-tooling.md` outline

Target length ≈1500–2200 words. Prose-first, fenced code only for load-bearing tokens. Cross-link rather than duplicate `tooling.md` / `BUILD.md` / `SECURITY.md`.

1. **Scope and boundary** — four-doc map: `tooling.md` = language/IPC contracts; `BUILD.md` = commands; this file = operational tooling + CI decisions and tradeoffs; `SECURITY.md` = threat model + waiver policy.
2. **Hook stack: prek over pre-commit-python** — no Python bootstrap; same hook-repo ecosystem; faster startup. Tradeoff: smaller community-hook surface, irrelevant because every Agaric-specific hook is `language = "system"`.
3. **Pre-commit vs pre-push split — the latency budget** — fast hooks pre-commit (≤few seconds: biome, tsc, markdownlint, link-check, local guards); compile-heavy pre-push (`cargo nextest`, `cargo sqlx prepare --check`, full Playwright, `verify-ci-equivalent.sh`). Pre-push is the local mirror of `_validate.yml` (script is the contract). Cite `tooling.md §Dev tooling`.
4. **CI shape — reusable `_validate.yml` + `validate-all` aggregate** — `ci.yml` + `release.yml` both `uses: ./.github/workflows/_validate.yml`; four parallel workers (lint, vitest×3, playwright×2, cargo-tests) plus a trivial `validate-all` aggregate as the stable branch-protection target.
5. **Test sharding decisions** — vitest 3-way (per-shard happy-dom env dominates → near-linear); Playwright 2-way with `workers: 1` inside each shard (Radix/TipTap focus flake on parallel state; see R14); no cargo-nextest shard (nextest parallelises internally; an extra runner shard duplicates cache cost).
6. **OS matrix — explicit pins, not floats** — `ubuntu-24.04`, `windows-2025`, `macos-15`; rationale already in `ci.yml:55-69` comments. Apple-Silicon `macos-15` is ≈2-3× faster on Rust; x86_64 macOS bundles via SDK cross-compile from the same runner with revisit trigger when `macos-13` Intel runner is retired.
7. **Caching — Swatinem `shared-key`, main-only `save-if`, `cache-bin`** — three deliberate choices: `shared-key: rust-deps` across lint + cargo-tests + Linux desktop build (Swatinem segregates by OS + profile internally); separate `shared-key: rust-android` for Android cross-compile; `save-if: ${{ github.ref == 'refs/heads/main' }}` (only main populates the canonical cache; feature branches read but never write); `cache-bin: 'true'` persists `~/.cargo/bin/` across runs.
8. **Supply-chain posture** — 100% SHA-pinning; Dependabot weekly for GHA only (npm + cargo deferred — see R2); `taiki-e/install-action` for prebuilt binary install; `zizmor` as workflow linter (baseline-then-tighten); `actionlint` via prek closes the local-side gap.
9. **SLSA provenance, Sigstore, and the unsigned-binary tradeoff** — `actions/attest-build-provenance@v3` on every release asset; end-user verification path documented in `BUILD.md`. Frame the no-signing posture honestly: SLSA provenance does not substitute for OS-level code signing at the UX layer. macOS notarisation is strict no-go for now (R11); Windows SignPath OSS is a P0 to-do (R3).
10. **Advisory handling — three concentric rings** — *block* (`cargo deny check` against `deny.toml [advisories].ignore`); *warn* (`cargo audit` upstream RustSec, `npm audit signatures` Sigstore); *time-boxed waiver* (`.nsprc` with `expiresOn: 90d` per entry). The cargo-audit-warn-only asymmetry is acknowledged and slated for promotion (R5).
11. **Local↔CI parity — `verify-ci-equivalent.sh` as contract** — literal correspondence: vitest job = `npx vitest run`; playwright job = `npx playwright test`; cargo-tests job = `cargo nextest run --profile ci` + `agaric-mcp` build + UDS smoke + externalBin verify; warn-only steps mirrored in script Phase 4. What is deliberately *not* in the script: full Tauri bundle build, cross-OS builds, SLSA attestation (run `scripts/verify-release-build.sh` before tagging). Escape hatch: `SKIP_CI_VERIFY=1`; current audit trail is git history (R16 reason-string guard is uncertain).
12. **JNI / Android `unsafe_code` reconciliation** — workspace lint is `unsafe_code = "deny"` (`src-tauri/Cargo.toml:41`). Single `#![allow(unsafe_code)]` carve-out at `src-tauri/src/sync_daemon/android_multicast.rs:33` for JNI raw-pointer conversions (`unsafe` blocks at lines 105, 123). Contract: any *new* file needing the allow requires explicit review. R13 adds a central allowlist + hook to enforce non-expansion.
13. **Asymmetric branch-protection convention** — maintainer (jfolcini) pushes directly to `main`; all other contributors must PR. Required checks (`validate-all`) enforced on PRs; owner bypasses via repo-admin path. Accepted for solo development velocity; revisit trigger: first external maintainer joins. Verify exact mechanism by inspecting current rule before writing this section (see R12 method).
14. **Accepted risks and revisit triggers** — table-style prose. For each row: decision / why accepted / what would trigger a revisit. Includes: no macOS notarisation (R11 strict no-go for now), Dependabot npm+cargo grouped (R2 to land), cargo-audit warn-only (R5 to promote), Playwright `workers: 1` (R14 alternative pending), Intel mac via SDK cross-compile (R32 self-limiting), zizmor `cache-poisoning` baseline (single-user, no adversarial peers), no SBOM (R9 to land), no conventional-commits gate (R8 to land), no CODEOWNERS (R21 to land), no CI `timeout-minutes` (R1 to land).
15. **Open questions / things to revisit** — pointer to this PEND-41 and to relevant rows in `pending/REVIEW-LATER.md`.

### Style discipline for the architecture doc

- No commands (run `grep -E '^\s*(\$|cargo|npm|gh|cd )' docs/architecture/ci-and-tooling.md` — expect ≈zero hits).
- No reproduced numeric metrics (no `9548`, `2528`, `49`, `411`, `28`, etc.). Cite `prek.toml` / `_validate.yml` / `package.json` / `Cargo.toml` as canonical sources.
- No duplication of `tooling.md §Dev tooling`, `tooling.md §Code-level`, or `SECURITY.md` content — cross-link.

## Output 2 — Recommendations backlog

Severity: **P0** must-do this week / **P1** should-do next cycle / **P2** nice / **P3** deferred. Categories: **SEC** / **ROB** / **MNT** / **PRF** / **DX**.

### P0 — Must-do

- **R1. Add job-level `timeout-minutes` everywhere — values from measurement, not imagination** (ROB). Default is 6h; a wedged process burns 6h of minutes silently. Method: for each job in `_validate.yml`, `ci.yml`, `release.yml`, pull observed wall-clock from recent successful main-branch runs (`gh run list --workflow=<wf> --branch=main --status=success --limit=20` then `gh run view <id> --json jobs | jq '.jobs[] | {name,started_at,completed_at}'`). Take the max (realistic upper bound including warm-cache misses), apply ≈50% headroom, round up to the nearest 5 min. Document numbers inline with a comment citing date + sample size. Revisit annually or when a job legitimately exceeds the bound. **ADOPT.** **HOLD until 2026-05-17** — maintainer made CI changes on 2026-05-16 that will influence wall-clock; wait for ≥1 day of post-change main-branch runs before sampling.
- **R2. npm + cargo Dependabot with `groups:` rules** (SEC). The "deferred until grouping rules exist" rationale in `dependabot.yml:24-27` is stale — Dependabot has supported `groups:` since 2023. Group radix-ui, tiptap, vitest, tauri, sqlx, tokio, plus a minor-and-patch catchall. Realistic volume: 8–10 PRs/week. Single highest-leverage gap. **ADOPT.**
- **R3. Apply for SignPath.io OSS Windows code signing** (SEC). Free for public OSS, integrates as one GHA step. Current "Windows code signing intentionally NOT wired" comment in `release.yml:441-448` declines a free path. **ADOPT** (application takes 2–3 weeks; start now).
- **R4. Document prek bootstrap in `CONTRIBUTING.md`** (DX). Currently no install instructions; contributor without prek installed gets fail-open (no hooks run). Add a Bootstrap section with `cargo install --locked prek` + `prek install`; optionally a `scripts/bootstrap.sh`. **ADOPT.**
- **R5. Promote `cargo audit` from warn → block** (SEC). The `.nsprc` 90-day-expiry pattern proves the team can run an explicit-waiver discipline. Mirror it in `deny.toml [advisories].ignore` with inline expiry comments. **ADOPT.**
- **R6. Add `.editorconfig`** (DX). ≈30 lines. Eliminates "fixed by formatter" PR noise for casual / GH-web / non-Biome editors. **ADOPT.**
- **R7. Eliminate count tables from docs AND remove the `agents-md-count-tables` hook** (MNT). Counts in narrative docs (test counts, hook counts, file counts) are worthless — they drift, demand maintenance, carry no insight a reader can act on. The contradiction between "AGENTS.md is locked" and "the count-tables hook *requires* the doc to drift" resolves by deleting both surfaces. Sweep AGENTS.md (and any other doc) for numeric metric tables; replace with qualitative descriptions or pointers to canonical source files (`prek.toml`, `_validate.yml`, `package.json`, `Cargo.toml`). Remove the `agents-md-count-tables` hook from `prek.toml`. **ADOPT.**
- **R8. Conventional-commits commit-msg hook** (MNT). Five-line prek hook (`conventional-pre-commit`, stage `commit-msg`). `CONTRIBUTING.md` and recent commits already follow the convention — locks it in. Do *not* adopt `@commitlint/cli` (200+ npm deps for a regex). **ADOPT.**

### P1 — Should-do

- **R9. SBOM generation in `release.yml`** (SEC). `anchore/sbom-action` per platform, CycloneDX + SPDX, attached to release and attested. SLSA L3 effectively requires it; EU CRA progressively enforces from 2027. **ADOPT.**
- **R10. OpenSSF Scorecard workflow** (SEC). Free, weekly cron, badge for README. Out-of-the-box score ≈7–9 given existing posture; flags remaining gaps externally. **ADOPT.**
- **R12. Document the asymmetric branch-protection convention** (MNT). Maintainer pushes directly to `main`; all other contributors must PR. Verify the exact mechanism via `gh api repos/jfolcini/agaric/branches/main/protection` + the repo settings UI, then document literally in the decisions doc: bypass mechanism, why accepted (solo development velocity), revert trigger (first external maintainer joins), required checks for PRs, force-push status, branch deletion, linear history. **ADOPT.**
- **R13. Central `unsafe_code` allowlist + prek guard** (SEC/MNT). Workspace lint is `deny`; single file has `#![allow(unsafe_code)]`. Add `src-tauri/unsafe-allowlist.txt` (one entry: `src/sync_daemon/android_multicast.rs`) and a prek hook that fails any new `#![allow(unsafe_code)]` not on the allowlist. **ADOPT.**
- **R14. Playwright per-suite serial mode, drop global `workers: 1`** (PRF). `playwright.config.ts` has `fullyParallel: true` *and* `workers: 1` — internally contradictory. Audit specs to identify focus-state-sharing ones; tag them with `test.describe.configure({ mode: 'serial' })`; set `workers: 2` (CI) / `'50%'` (local). ≈2× E2E throughput per shard. **ADOPT** (audit first).
- **R15. Vitest pool A/B benchmark — `forks` vs `threads`** (PRF). Default is `forks`. For happy-dom-heavy suites `threads` is typically 1.3–1.8× faster but can leak module state. One CI run to A/B. **ADOPT** if speedup >30%; document either way.
- **R17. Coverage reporting in CI as step-summary** (MNT). Coverage thresholds in `vitest.config.ts` are only enforced when the maintainer runs `--coverage` locally; CI's 3-shard run does not. Add `--coverage --reporter=github-actions` to one shard and post to `$GITHUB_STEP_SUMMARY`. No Codecov dependency. **ADOPT.**
- **R18. Release notes: verify-recipe step-summary** (DX/SEC). Final step in `release.yml` templates per-asset `gh attestation verify` commands into release notes + `$GITHUB_STEP_SUMMARY`. Closes the "we ship provenance but users don't know how to check it" gap. **ADOPT.**
- **R19. Drop `depcheck`, keep `knip`** (MNT). Both detect unused deps; knip is strictly superset. Removes two `.nsprc` lodash waivers (1115806, 1115810) as transitive deps disappear. **ADOPT.**
- **R20. `cargo machete` allowlist: inline reasons + quarterly verification** (MNT). 12 entries with no co-located rationale. Add `# reason / transitive path` comment per entry; quarterly hook runs `cargo tree --invert` to confirm each entry is still actually reachable. **ADOPT.**
- **R21. CODEOWNERS** (MNT). `* @jfolcini` plus path-specific markers for sensitive files (`/src-tauri/src/sync_daemon/android_multicast.rs`, `/.github/workflows/`, `/src-tauri/migrations/`, `/.nsprc`). 30 seconds; future-proofs first external contribution. **ADOPT.**
- **R22. Tauri updater signing-key rotation procedure** (SEC). Long-lived `TAURI_SIGNING_PRIVATE_KEY` repo secret is the root of trust for every auto-update. Document rotation cadence (annual), procedure, revocation path, user notification. Investigate Tauri 2.6+ Sigstore-keyless updater signing. **ADOPT** the documentation; **DEFER** the cosign migration pending Tauri support maturity.
- **R23. License-compatibility audit for GPL-3.0-or-later contagion** (SEC). Both `cargo-deny` and npm `license-checker` run, but verify the explicit GPL-3.0-or-later compatibility allowlist (AGPL OK; "non-commercial OSI-like" not OK). **ADOPT.**

### P2 — Nice

- **R24. Cargo release profile: add `panic = "abort"`** (PRF). −5–10% binary size, faster cold start. Verify no `catch_unwind` boundary depends on unwinding (Tauri IPC uses `Result`). Reject `lto = "fat"` (2–5 min added to every release build). **ADOPT** partial.
- **R25. Per-test slow-warning budgets** (PRF/MNT). `vitest --slowTestThreshold=2000`; `nextest.toml` slow-timeout 60s / leak-timeout 90s. Catches regressions cheaply. **ADOPT.**
- **R26. Document Swatinem cache-key bump procedure** (MNT). When `Cargo.lock` changes incompatibly with cached `target/`, rescue is to bump the `shared-key` suffix. Currently tribal knowledge. **ADOPT** documentation.
- **R27. License-header non-policy made explicit** (MNT). LICENSE is canonical; per-file headers add noise without a downstream that requires them. **REJECT** enforcement; **ADOPT** explicit non-policy documentation so future contributors don't re-litigate.
- **R28. Reusable workflow relative-ref documentation** (SEC). `uses: ./.github/workflows/_validate.yml` is safe (in-repo, `pull_request:` not `pull_request_target:`); one-paragraph note in the decisions doc / threat model. **ADOPT** doc only.
- **R29. Build-time secret scanner against release artifacts** (SEC). gitleaks catches secrets in source, not embedded in compiled binaries. Add a `strings | grep` step or TruffleHog against built `.deb` / `.msi` / `.app` / `.apk`. **ADOPT.**
- **R30. Branch-protection assertion workflow** (ROB). Scheduled workflow calls `gh api repos/.../branches/main/protection` and asserts required checks include `validate-all`. Catches accidental UI toggle. **ADOPT.**

### P3 — Deferred / Reject

- **R11. macOS notarisation — strict no-go for now, review way later** (SEC). User-stated decision: not adopting in the current cycle. SLSA-provenance-substitute posture stays; `BUILD.md` unquarantine instructions remain the user-facing UX. The decisions doc records this explicitly as a deferred review item (not "ADOPT", not silent acceptance). **DEFER** with explicit revisit-later marker.
- **R16. `SKIP_CI_VERIFY` reason-string / safe-glob guard — UNCERTAIN** (MNT). Habit-creep argument vs friction-cost argument is genuinely balanced for a solo workflow. **DEFER pending user decision.** If user later adopts: cheap version (reject `=1`, require non-empty reason string) is ~10 lines of bash; rigorous version (safe-glob allowlist) requires git-diff inspection in the pre-push script.
- **R31. Required commit signing (Sigstore gitsign or GPG)** — solo threat model doesn't include stolen-laptop attacker with repo-push capability. **REJECT** until threat model expands; revisit if/when external contributors land.
- **R32. macOS Intel dedicated runner** — SDK cross-compile works today; Apple's own Intel deprecation (post-macOS Tahoe ≈2026) is self-limiting. **REJECT** change; **ADOPT** documenting the revisit trigger.
- **R33. TruffleHog source-code scanner alongside gitleaks** — diminishing returns at solo scale. **DEFER** (note: R29 uses TruffleHog at release-artifact stage, different use case).
- **R34. Reproducible-build verification** — substantial effort; build twice + diff hashes; likely fails today on timestamps. **DEFER** until bandwidth for a multi-week effort.
- **R35. Fuzzing on parsing surfaces** (sync protocol, IPC, markdown, OPML) — `cargo-fuzz` scheduled workflow. **DEFER**, real engineering effort.
- **R36. `cargo-vet` / `cargo-crev` for transitive dep trust** — next step after cargo-deny but adds significant ongoing maintenance. **DEFER.**
- **R37. CITATION.cff + `.well-known/security.txt`** — RFC 9116. Tiny but low-priority. **DEFER.**
- **R38. Vulnerability-disclosure SLA + incident-response runbook** — verify `SECURITY.md` states disclosure channel, response SLA, supported versions. **ADOPT** documentation review; runbook is **DEFER.**

### Triage summary

| Priority | Count | Verdict mix |
| --- | --- | --- |
| P0 | 8 | All ADOPT |
| P1 | 13 | All ADOPT (one partial, two doc-only) |
| P2 | 7 | 6 ADOPT, 1 REJECT-with-doc |
| P3 | 10 | 1 REJECT, 9 DEFER |

## Suggested implementation batches

Each batch is one session; doc updates (decisions doc, AGENTS.md, BUILD.md) land in the same commit as the rec.

- **Batch 1** (≈2h, zero risk): R6, R7, R8, R21, R26, R27. Plus seed the decisions doc with sections 1–8 and section 13.
- **Batch 2** (≈3h, needs one CI run each): R1 (measure first), R5, R13, R17, R19, R20, R25.
- **Batch 3** (≈3–4h, release-workflow changes): R9, R10, R12, R18, R22, R23, R29, R30.
- **Batch 4** (≈4–6h, process upgrades + perf benchmarks): R2, R14, R15, R24.
- **Long horizon** (multi-cycle, external dependencies): R3 (SignPath review queue ≈3 weeks), R4.

## Verification (apply after each batch lands)

1. No reproduced numeric metrics in `docs/architecture/ci-and-tooling.md` — grep for `9548`, `2528`, `49`, `411`, `28` should return zero matches.
2. No commands in the architecture doc — `grep -E '^\s*(\$|cargo|npm|gh|cd )' docs/architecture/ci-and-tooling.md` should return zero hits.
3. Cross-link sanity — every reference to `tooling.md` / `BUILD.md` / `SECURITY.md` / pending files resolves. `prek run md-link-targets`.
4. Style parity — read `docs/architecture/tooling.md` side-by-side and confirm prose density, paragraph length, H3 use look like siblings.
5. `prek run --all-files` clean (markdownlint, lychee, typos, taplo).
6. Word count for the architecture doc: 1500–2200. Under 1500 means under-explaining; over 2200 means scope creep into `tooling.md` / `SECURITY.md` territory.
7. When the last rec ships: delete this PEND file in the same commit.

## Critical files

- `docs/architecture/ci-and-tooling.md` *(NEW — produced incrementally as recs land)*
- `docs/architecture/tooling.md` *(boundary partner — the new doc must not duplicate)*
- `SECURITY.md` *(cross-link target for threat model + waiver policy)*
- `docs/BUILD.md` *(cross-link target for commands)*
- `.github/workflows/_validate.yml`, `ci.yml`, `release.yml` *(load-bearing references)*
- `scripts/verify-ci-equivalent.sh`, `scripts/verify-release-build.sh`
- `prek.toml`, `.github/dependabot.yml`, `.github/zizmor.yml`, `src-tauri/deny.toml`, `src-tauri/.cargo/audit.toml`, `.nsprc` *(cited references; do not duplicate content)*
- `AGENTS.md`, `CONTRIBUTING.md` *(touched by R4, R7, R21)*
