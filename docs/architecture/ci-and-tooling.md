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

- **macOS notarisation — strict no-go for now.** Not adopting in the current cycle; unquarantine instructions in [`../BUILD.md`](../BUILD.md) remain the UX.
- **Windows SignPath OSS — pending action.** Free for public OSS, integrates as one GHA step. Application queue runs multiple weeks.

The Tauri updater signing key — distinct from OS-level code signing — is the **root of trust for every auto-update**. See [`../../SECURITY.md`](../../SECURITY.md#updater-signing-key-rotation) § "Updater signing-key rotation" for cadence, procedure, revocation path, and the deferred Sigstore-keyless alternative.

## Advisory handling — three concentric rings

Vulnerability advisories filter through three rings of decreasing strictness. **Block** is `cargo deny check` driven by `src-tauri/deny.toml` with an explicit `[advisories].ignore` list — anything not on the list and unresolved fails the build (this also catches advisories published since the last triage, since `cargo audit` was promoted from warn-only). **Warn** is `npm audit signatures` (Sigstore provenance check on the npm dependency closure), run warn-only because the Sigstore-attested coverage of the npm ecosystem is still partial. **Time-boxed waiver** is `.nsprc` with an `expiresOn` field per ignored entry set 90 days from triage — the entry expires automatically, forcing a re-review rather than silent indefinite ignore. The same explicit-waiver discipline now applies to `src-tauri/deny.toml [advisories].ignore` with inline expiry comments per entry.

## Local↔CI parity — `verify-ci-equivalent.sh` as contract

`scripts/verify-ci-equivalent.sh` is the pre-push hook that runs the same checks as `_validate.yml`, in parallel where independent, with the same scoping. Vitest job corresponds to the full Vitest run; Playwright job to the full Playwright run; cargo-tests job to nextest plus the `agaric-mcp` build, UDS smoke, and externalBin staging verification. Warn-only steps (cargo audit, npm audit signatures) are mirrored in Phase 4. The script is the contract: if CI diverges from local pre-push, fix the script. Deliberately **not** in the script: full Tauri bundle build, cross-OS builds, SLSA attestation — those are CI-only, with `scripts/verify-release-build.sh` available for a pre-tag smoke. Escape hatch: `SKIP_CI_VERIFY=1` short-circuits the hook; the audit trail is git history. A reason-string guard on the escape hatch is uncertain pending decision.

## JNI / Android `unsafe_code` reconciliation

Workspace lint is `unsafe_code = "deny"` (`src-tauri/Cargo.toml:41`). Exactly one file holds a `#![allow(unsafe_code)]` carve-out: `src-tauri/src/sync_daemon/android_multicast.rs:33`, which acquires Android's `WifiManager.MulticastLock` over JNI — the only way to receive multicast packets on an Android Wi-Fi interface, and the only JNI raw-pointer surface in the tree. Each `unsafe` block inside that file is justified inline. Contract: any *new* file needing the allow requires explicit review, enforced by the `unsafe-code allowlist` prek hook (`src-tauri/unsafe-allowlist.txt` + `scripts/check-unsafe-allowlist.sh`).

## Asymmetric branch-protection convention

Solo-development convention: the maintainer (`jfolcini`) pushes directly to `main`; all other contributors must open a pull request. Accepted for solo-development velocity — the cost of running every doc edit through a PR cycle would dominate cadence with no review benefit at zero external contributors. Revisit trigger: the first external maintainer joins, at which point either the bypass actor is removed and the maintainer joins the PR cycle, or the bypass is widened with an explicit policy expansion noted here.

The enforcement substrate is a **repository ruleset** (the modern replacement for classic branch protection), not the legacy `branches/*/protection` API — `gh api repos/jfolcini/agaric/branches/main/protection` returns 404, and the live shape is only visible through `gh api repos/jfolcini/agaric/rules/branches/main` and `gh api repos/jfolcini/agaric/rulesets`. A single ruleset named `default` targets `~DEFAULT_BRANCH` with enforcement `active`. It carries six rule types: `deletion` (branch deletion blocked), `non_fast_forward` (force-push blocked), `required_signatures` (every commit on `main` must be cryptographically signed), `required_linear_history` (merge commits rejected — only squash or rebase produces a parent on `main`), `pull_request`, and `required_status_checks`. The `pull_request` rule requires one approving review, requires code-owner review (CODEOWNERS file at repo root drives the routing), requires last-push approval (stale approvals invalidate on a fresh push from the author), auto-dismisses stale reviews when new commits land, and requires every review thread to be resolved before merge. The `required_status_checks` rule pins `validate-all` (§4) as a required check and sets `strict_required_status_checks_policy: true` so a PR must be up-to-date with `main` (rebased onto the current tip) before merging. Three merge methods remain in `allowed_merge_methods` (`merge`, `squash`, `rebase`), but `required_linear_history` effectively forces squash or rebase since a classic merge commit produces a two-parent node on `main`.

The asymmetry is wired through the ruleset's `bypass_actors` list: a single actor with the Admin repository role, bypass mode `always`. This is what lets the maintainer push directly to `main` without opening a PR. The bypass covers the `pull_request`, `required_status_checks`, and `required_linear_history` rules but **not** `required_signatures` — direct pushes still have to carry signed commits, which is why the maintainer's local git config sets `commit.gpgsign = true` (or every commit goes through `git commit -S`). An unsigned direct push is rejected at the remote regardless of admin status.

The tighter PR-side parameters (code-owner review, last-push approval, stale-review dismissal, thread-resolution gate, required `validate-all`, strict-up-to-date, linear history) primarily lift the OpenSSF Scorecard `Branch-Protection` score and harden the external-contributor path. They cost the maintainer nothing on direct pushes because the admin bypass remains in place. If the maintainer cycle ever needs to go through a PR (e.g. someone else's branch picked up by the maintainer), the same gates apply — by design. The one Scorecard sub-check we deliberately do **not** satisfy is "branch protection settings apply to administrators" — that is the bypass, kept as the R12 design choice (revisit trigger: first external maintainer joins).

Drift on this ruleset is policed by the `branch-protection-assert.yml` daily cron, which re-reads the live rule-type set and diffs it against the expected six; an accidental UI toggle surfaces the next morning.

## Accepted risks and revisit triggers

Each row is a deliberate decision, the reason it is accepted today, and the trigger that would force a re-evaluation.

- **No macOS notarisation** — accepted because the Apple Developer Program fee and the operational overhead of an Apple-managed signing key are out of scope for the current cycle. Trigger: a downstream that requires notarisation (a managed corporate fleet, a third-party Mac app catalogue).
- **Playwright `workers: 1` globally** — accepted on the desktop runner because Radix and TipTap focus state flakes under parallel workers; CI runs with `workers: 2` per-shard after the recent audit identified the truly-serial specs.
- **x86_64 macOS via SDK cross-compile from Apple Silicon** — accepted because Apple's own Intel deprecation is in motion (post-macOS Tahoe transition); maintaining a separate Intel runner today would be paying for hardware that is already self-limiting. Trigger: an end-user-reported regression that cross-compile cannot reproduce.
- **`zizmor` `cache-poisoning` baseline (not strict)** — accepted because the threat model is single-user, no adversarial peers with repo-push capability. Trigger: the threat model expands to include external maintainers with merge rights.

The list deliberately omits items that have landed this batch (the count tables in `AGENTS.md` are gone, the conventional-commits hook is in, CODEOWNERS exists, an `.editorconfig` is in place). Those are no longer "accepted risks"; they are simply current state.

## Open questions / things to revisit

Things this doc does not commit to yet — and the canonical location for tracking them — are:

- CI/tooling backlog and longer-horizon items (transport changes, sync evolution, editor surface work) are tracked separately. Still-open follow-ups from the 2026-05-16 review wave include SignPath OSS, macOS notarisation, the vitest forks-vs-threads benchmark, and a `SKIP_CI_VERIFY` reason-string guard.
