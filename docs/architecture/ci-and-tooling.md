<!-- markdownlint-disable MD060 -->
# CI and tooling

Operational decisions: how the local hook stack and the GitHub Actions pipeline are shaped, what they trade off, and where the lines are drawn. Workflow contracts at the language / IPC boundary live in [`tooling.md`](tooling.md); the commands that exercise everything live in [`../BUILD.md`](../BUILD.md); the threat model and waiver policy live in [`../../SECURITY.md`](../../SECURITY.md). This file is the **why** for everything in between.

## Scope and boundary

Four documents partition the operational surface. [`tooling.md`](tooling.md) holds language and IPC contracts (Specta bindings, sqlx compile-time checks, ULID and RFC3339 invariants, IPC-boundary security mechanisms). [`../BUILD.md`](../BUILD.md) holds the commands. [`../../SECURITY.md`](../../SECURITY.md) holds the threat model and waiver policy. This file holds the **decisions and tradeoffs** about pipeline shape, hook placement, and accepted risks with revisit triggers. Counts and metrics are not reproduced — pointers to canonical source files (`prek.toml`, `_validate.yml`, `package.json`, `Cargo.toml`) are the only truthful answer.

## Hook stack: prek over pre-commit-python

The hook driver is [prek](https://github.com/j178/prek), the Rust reimplementation of the Python `pre-commit` framework. It consumes the same `prek.toml` schema and hook-repo ecosystem, but avoids the Python interpreter bootstrap — previously the single largest fixed cost on cold machines. Tradeoff: the community hook surface is smaller, but every Agaric-specific hook is `language = "system"` and shells out, so the smaller catalogue is irrelevant in practice. The canonical hook inventory is `prek.toml`.

## Pre-commit vs pre-push split — the latency budget

Hooks split by wall-clock cost. Pre-commit (biome, type-check, markdownlint, link-check, local guards) finishes in seconds. Compile-heavy hooks (cargo nextest, sqlx prepare check, full Playwright, the CI-equivalent verifier) run on pre-push, because adding a minute to every commit destroys the small-commit habit. The pre-push stage is the local mirror of `_validate.yml` — see §11. Pre-commit hooks that enforce architectural contracts (bindings parity, mock parity, migrations-immutable, snapshot redaction, IPC error-path coverage) are documented in [`tooling.md`](tooling.md#dev-tooling); they sit in pre-commit because they are fast token-level checks.

## CI shape — reusable `_validate.yml` + `validate-all` aggregate

Both `ci.yml` (every push, every PR) and `release.yml` (every tag) call the same reusable workflow via `uses: ./.github/workflows/_validate.yml`. It fans out into parallel workers — lint, vitest matrix, Playwright matrix, cargo-tests — plus a trivial `validate-all` job that `needs:` every sibling. `validate-all` exists so branch protection and downstream callers depend on one stable check name, immune to sibling-job renames. Workers can be added or removed without churning the protected-check list.

## Test sharding decisions

Vitest fans out three ways because each shard pays its own happy-dom env-setup cost; per-shard speedup is near-linear, matrix overhead negligible. Playwright fans out two ways with `workers: 1` inside each shard because Radix and TipTap focus state is genuinely flaky under parallel workers — `playwright.config.ts` carries `fullyParallel: true` alongside `workers: 1`, an internal contradiction acknowledged as a revisit item (path forward: per-suite `test.describe.configure({ mode: 'serial' })` on the focus-sharing specs, then lift the global cap). The cargo-tests job runs without a runner-level shard: nextest parallelises internally, and an extra shard would duplicate compile cost without freeing wall-clock.

## OS matrix — explicit pins, not floats

Release and CI both pin runner images explicitly: `ubuntu-24.04`, `windows-2025`, `macos-15`. Floating aliases (`*-latest`) move silently and have caused deprecation warnings and image-rebuild lag at past transitions; pinning makes the move a Dependabot PR. The Apple-Silicon `macos-15` image runs Rust workloads materially faster than Intel-era runners; x86_64 macOS bundles are produced via SDK cross-compile from the same runner. Dedicating an Intel runner is rejected as self-limiting — Apple's own Intel deprecation is in motion (§14).

## Caching — Swatinem `shared-key`, main-only `save-if`, `cache-bin`

Three deliberate choices in every `Swatinem/rust-cache` invocation. First, **`shared-key: rust-deps`** across the lint, cargo-tests, and Linux desktop-build slots — Swatinem segregates the cache key internally by `runner.os` and by profile, so deduplication happens within an OS while macOS / Windows / Android jobs get their own cache spaces with no cross-OS poisoning. The Android cross-compile uses a separate `shared-key: rust-android` because its `target/` tree and rustup targets are disjoint from the host slot; sharing would defeat both caches. Second, **`save-if: ${{ github.ref == 'refs/heads/main' }}`** — only `main` writes to the cache; feature branches read it but never save. This stops every feature-branch churn from evicting the canonical baseline. Third, **`cache-bin: 'true'`** persists `~/.cargo/bin/` across runs so cargo-installed plugins (prek, sqlx-cli) survive between jobs.

```yaml
save-if: ${{ github.ref == 'refs/heads/main' }}
```

**Cache rescue procedure.** When `Cargo.lock` changes in a way incompatible with cached `target/` artefacts (a corrupted incremental tree, a confusing linker mismatch), bump the suffix of the `shared-key` in `_validate.yml` and `ci.yml` (e.g. `rust-deps` → `rust-deps-v2`). The next main-branch run repopulates from scratch; feature branches start reading from the new key on their next push. Documented here so future contributors don't re-derive it from a wedged pipeline.

## Supply-chain posture

Every remote `uses:` is SHA-pinned to a commit, not a tag — verified across the workflow set. Dependabot runs weekly for the GitHub Actions ecosystem; npm and cargo are deferred pending grouping rules (see §14, R2). Rust-based developer tools (cargo-deny, cargo-machete, cargo-audit, sqruff, typos, zizmor, taplo) install via `taiki-e/install-action` against upstream prebuilt binaries, side-stepping the cold-cache compile that previously dominated lint runs. Workflow-level permissions default to `contents: read`, with per-job write overrides only where genuinely required (`id-token: write` and `attestations: write` appear only on the attestation jobs). `zizmor` lints the workflow files themselves on a baseline-then-tighten posture; `actionlint` via prek closes the local-side gap so workflow regressions surface before the push.

**License headers.** The repo-level `LICENSE` (GPL-3.0-or-later) is canonical; no per-file SPDX headers are enforced for new files. The non-policy is documented here so future contributors don't re-litigate it. Revisit trigger: a downstream packager — Flathub, Homebrew tap, Nix — requires per-file SPDX for ingestion.

## SLSA provenance, Sigstore, and the unsigned-binary tradeoff

Every release asset (Linux `.deb` / `.AppImage`, Windows `.msi` / `.exe`, macOS `.dmg` / `.app.tar.gz`, Android `.apk`, and the updater tarballs) is attested by `actions/attest-build-provenance@v3` and pushed to Sigstore plus the GitHub attestations API. End-user verification lives in [`../BUILD.md`](../BUILD.md). Detached `.sig` files (Tauri updater signatures) are intentionally **not** attested: they are verification metadata for the parent bundle, not standalone distributable artefacts.

Frame the no-OS-signing posture honestly: **SLSA provenance does not substitute for OS-level code signing at the UX layer.** A SmartScreen warning on Windows still appears on first install; macOS Gatekeeper still quarantines a non-notarised `.app`. Provenance lets a sophisticated user verify origin; it does not change the first-launch experience. Two follow-on positions:

- **macOS notarisation — strict no-go for now** ([`PEND-41`](../../pending/PEND-41-ci-tooling-review.md) R11). Not adopting in the current cycle; unquarantine instructions in [`../BUILD.md`](../BUILD.md) remain the UX.
- **Windows SignPath OSS — pending action** ([`PEND-41`](../../pending/PEND-41-ci-tooling-review.md) R3). Free for public OSS, integrates as one GHA step. Application queue runs multiple weeks; flagged P0.

## Advisory handling — three concentric rings

Vulnerability advisories filter through three rings of decreasing strictness. **Block** is `cargo deny check` driven by `src-tauri/deny.toml` with an explicit `[advisories].ignore` list — anything not on the list and unresolved fails the build. **Warn** is `cargo audit` (upstream RustSec, run after `cargo deny` to catch advisories published since `deny.toml` was last triaged) and `npm audit signatures` (Sigstore provenance check on the npm dependency closure). Both run warn-only so a freshly-published advisory does not block CI before the maintainer has triaged it. **Time-boxed waiver** is `.nsprc` with a `expiresOn` field per ignored entry, set 90 days from triage — the entry expires automatically, forcing a re-review rather than silent indefinite ignore. The asymmetry between `cargo audit`-warn and `cargo deny`-block is acknowledged and slated for promotion ([`PEND-41`](../../pending/PEND-41-ci-tooling-review.md) R5): the `.nsprc` 90-day pattern proves the team can run an explicit-waiver discipline, and mirroring it in `deny.toml` is the next step.

## Local↔CI parity — `verify-ci-equivalent.sh` as contract

`scripts/verify-ci-equivalent.sh` is the pre-push hook that runs the same checks as `_validate.yml`, in parallel where independent, with the same scoping. Vitest job corresponds to the full Vitest run; Playwright job to the full Playwright run; cargo-tests job to nextest plus the `agaric-mcp` build, UDS smoke, and externalBin staging verification. Warn-only steps (cargo audit, npm audit signatures) are mirrored in Phase 4. The script is the contract: if CI diverges from local pre-push, fix the script. Deliberately **not** in the script: full Tauri bundle build, cross-OS builds, SLSA attestation — those are CI-only, with `scripts/verify-release-build.sh` available for a pre-tag smoke. Escape hatch: `SKIP_CI_VERIFY=1` short-circuits the hook; the audit trail is git history. A reason-string guard on the escape hatch is uncertain pending decision.

## JNI / Android `unsafe_code` reconciliation

Workspace lint is `unsafe_code = "deny"` (`src-tauri/Cargo.toml:41`). Exactly one file holds a `#![allow(unsafe_code)]` carve-out: `src-tauri/src/sync_daemon/android_multicast.rs:33`, which acquires Android's `WifiManager.MulticastLock` over JNI — the only way to receive multicast packets on an Android Wi-Fi interface, and the only JNI raw-pointer surface in the tree. Each `unsafe` block inside that file is justified inline. Contract: any *new* file needing the allow requires explicit review. A central allowlist with a prek guard against non-allowlisted expansion is on the backlog ([`PEND-41`](../../pending/PEND-41-ci-tooling-review.md) R13).

## Asymmetric branch-protection convention

Solo-development convention: the maintainer (`jfolcini`) pushes directly to `main`; all other contributors must open a pull request. Required-check enforcement on PRs is `validate-all` (§4). Maintainer bypass runs through the repo-admin path. Accepted for solo-development velocity — the cost of running every doc edit through a PR cycle would dominate cadence with no review benefit at zero external contributors. Revisit trigger: the first external maintainer joins, at which point the convention flips and the bypass is removed.

> **Maintainer TODO.** Verify the exact mechanism via the branch-protection API (and the repo settings UI as cross-check), then append the literal specifics here: bypass mechanism (admin override vs. configured bypass actors), required checks for PRs, force-push status, branch deletion, linear history. Do not invent values not verified against the live config. The paragraph above captures the **convention**; this admonition asks for the literal protection-rule shape once verified.

## Accepted risks and revisit triggers

Each row is a deliberate decision, the reason it is accepted today, and the trigger that would force a re-evaluation. Pointers go to the rec backlog in [`PEND-41`](../../pending/PEND-41-ci-tooling-review.md).

- **No macOS notarisation** — accepted because the Apple Developer Program fee and the operational overhead of an Apple-managed signing key are out of scope for the current cycle. Trigger: a downstream that requires notarisation (a managed corporate fleet, a third-party Mac app catalogue). See R11 — strict no-go for now.
- **Dependabot grouping for npm and cargo pending** — accepted because the raw, ungrouped feed would generate untriagable PR volume. Trigger: grouping rules land per R2 (next cycle).
- **`cargo audit` warn-only, not block** — accepted to avoid a freshly-published advisory blocking CI before the maintainer can triage. Trigger: promote to block once the `.nsprc` waiver pattern is mirrored in `deny.toml` per R5.
- **Playwright `workers: 1` globally** — accepted because Radix and TipTap focus state genuinely flakes under parallel workers, and per-suite serial-mode tagging has not been audited yet. Trigger: per-suite audit lands per R14.
- **x86_64 macOS via SDK cross-compile from Apple Silicon** — accepted because Apple's own Intel deprecation is in motion (post-macOS Tahoe transition); maintaining a separate Intel runner today would be paying for hardware that is already self-limiting. Trigger: an end-user-reported regression that cross-compile cannot reproduce. See R32 — explicitly rejected as a change, documented as a revisit trigger.
- **`zizmor` `cache-poisoning` baseline (not strict)** — accepted because the threat model is single-user, no adversarial peers with repo-push capability. Trigger: the threat model expands to include external maintainers with merge rights.
- **No SBOM** — accepted because the SLSA provenance attestation already covers the primary supply-chain question (where did this binary come from). Trigger: SLSA L3 formal claim or EU CRA enforcement deadline. See R9.
- **No CI `timeout-minutes`** — accepted because GitHub Actions' 6h default rarely bites in practice and a wrong upper bound is worse than no bound. Trigger: measurement lands per R1 — pull observed wall-clock from successful main-branch runs, take the max with headroom, document inline.

The list deliberately omits items that have landed this batch (the count tables in `AGENTS.md` are gone, the conventional-commits hook is in, CODEOWNERS exists, an `.editorconfig` is in place). Those are no longer "accepted risks"; they are simply current state.

## Open questions / things to revisit

Things this doc does not commit to yet — and the canonical location for tracking them — are:

- The full rec backlog: [`../../pending/PEND-41-ci-tooling-review.md`](../../pending/PEND-41-ci-tooling-review.md). As each rec ships, the relevant row above flips from "accepted risk" to "current state", and the rec is crossed off the backlog. When the backlog is fully drained, that file is deleted in the same commit as the last rec.
- Longer-horizon items not specific to CI (transport changes, sync evolution, editor surface work): [`../../pending/REVIEW-LATER.md`](../../pending/REVIEW-LATER.md) is canonical.
