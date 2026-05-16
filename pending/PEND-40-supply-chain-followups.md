# PEND-40 — Supply-chain hardening follow-ups

> Captured 2026-05-16. Companion to the 5 "do now" items already shipped in the same session: `npx --yes` removed from `markdownlint-cli2`, `cargo audit` wired as a prek hook + CI tool, `npm audit signatures` step added to `_validate.yml`, all 35 GitHub Actions `uses:` references SHA-pinned across the 3 workflow files + Dependabot configured for weekly SHA bumps, `.nsprc` advisory exceptions given 90-day expirations. This file tracks the **stretch items** that wanted more design time or a higher coordination cost.

## What landed (context for the items below)

| # | Change | File(s) |
| --- | --- | --- |
| #1 + #6 | SHA-pin 9 distinct actions across 35 `uses:` sites | `.github/workflows/{_validate,ci,release}.yml`, `.github/dependabot.yml` (new), `.github/zizmor.yml` (cleanup) |
| #2 | `npx --yes markdownlint-cli2` → `npx markdownlint-cli2` (devDep-locked) | `prek.toml` |
| #3 | `npm audit signatures` warn-only CI step (Sigstore provenance check) | `.github/workflows/_validate.yml` |
| #4 | `cargo audit` as a CI warn-only step (not a prek hook — would block local dev because deny.toml's 19 ignores aren't replicated yet); installed via `taiki-e/install-action` alongside other tools | `.github/workflows/_validate.yml` |
| #7 | `expiresOn` 2026-08-14 added to all 14 `.nsprc` entries (90 days) | `.nsprc` |

Verification: `zizmor` reports **0 findings** on all 3 workflow files after SHA pinning. `prek run --all-files` should now exercise the new `cargo audit` hook on next run; if it fails, expect a follow-up commit to triage advisories.

## Stretch items (this plan)

### #5 — SLSA build provenance for release artifacts

**What:** Add `actions/attest-build-provenance@<SHA>` to `release.yml` after the Tauri bundle step + the `agaric-mcp` build step. Attaches a signed Sigstore attestation to each release asset (`.dmg`, `.AppImage`, `.deb`, `.msi`, `.exe`, the Android APK / AAB, the `agaric-mcp` sidecar binary).

**Why:** Lets a Play Store reviewer (PEND-36) — or any downstream user — verify "this `.apk` came from CI run #N on the `jfolcini/agaric` repo at commit X" without trusting our distribution channel. Defeats the impersonation attack class (someone uploads a malicious build to a typosquat GitHub release page).

**Cost:** S (~1-2 h). Mostly figuring out which artifacts get attestations (probably all of them, including the desktop bundles even though Tauri's own signing already covers desktop).

**Risk:** Low. Attestation generation is parallel to existing signing; doesn't change artifact bytes. Worst case: the `actions/attest-build-provenance` action fails and we drop the step.

**Prereqs:** Repo needs `id-token: write` permission scoped to the release job (small change). `attestations: write` too. Both are job-level, not workflow-level.

**Verification:** `gh attestation verify <file> --repo jfolcini/agaric` should succeed for every release artifact.

### #8 — Audit `--locked` flags everywhere

**What:** Sweep all `cargo install`, `npm install`, `pnpm install` invocations across the repo (`scripts/`, workflows, docs) for missing `--locked` / `--frozen-lockfile`. Current state: most CI `cargo install` calls have `--locked` already; `npm ci` enforces lockfile by design; but worth a one-time grep + audit pass.

**Why:** Without `--locked`, `cargo install` can ignore the lockfile and pull newer deps than `Cargo.lock` says. Same for `npm install` vs `npm ci`. Subtle drift between dev and CI.

**Cost:** XS (~30 min sweep + maybe 2-3 edits).

**Risk:** XS.

### #9 — `cosign verify` on tool installs (local + CI)

**What:** For binaries we download outside the system package manager (e.g., `apt`/`crates.io`/`taiki-e/install-action`, which already does its own verification), wrap downloads with `cosign verify-blob`. Affects: the `bacon` install in PEND-37's L5 follow-up, anything fetched via `curl | sh`, manual binstall scripts.

**Why:** Catches MITM / DNS-hijack / compromised-CDN download tampering. Most installers don't verify by default; cosign + the publisher's public key adds an attestation check.

**Cost:** M (~3-4 h to identify all download paths + add verification + document the publisher pubkeys).

**Risk:** Medium. Easy to break installs when publisher key rotation isn't tracked. Worth doing only after `bacon` and any other "curl-installed" tools are inventoried.

**Skip-criterion:** if all our installs route through `apt`, `cargo install --locked` (crates.io is itself signed), or `taiki-e/install-action` (which verifies its downloads), there's nothing to harden — this item closes as no-op. Worth ~15 min of inventory before scheduling.

### #10 — Document the threat model

**What:** Write `docs/SECURITY-THREAT-MODEL.md` (or extend `SECURITY.md`) with:

1. **Trust anchors** — Anthropic, GitHub, npm registry, crates.io maintainers, the maintainer's machine.
2. **Untrusted inputs** — synced peer data (untrusted), Loro CRDT bytes from peers, user-pasted text, file imports, OAuth tokens (encrypted at rest).
3. **Accepted risks** — list the `.nsprc` waivers' rationale in one place; same for the zizmor `cache-poisoning` baseline.
4. **Mitigations** — CSP, Tauri capabilities, lockfiles, SHA-pinning, cargo audit, etc.
5. **Out-of-scope** — multi-tenant scenarios, network-exposed servers, anything the AGENTS.md "single-user local-first" framing excludes.

**Why:** Becomes the reference document for "should we accept this advisory?" decisions. Today those decisions live in scattered `.nsprc` notes, zizmor.yml comments, and AGENTS.md prose; consolidating them makes the framework explicit.

**Cost:** S (~2-3 h writing).

**Risk:** XS — pure documentation.

**Highest-leverage:** other items (#5, #8, #9, plus #1/#3/#4 already shipped) all reference "the threat model" implicitly. Writing it once means subsequent triage decisions land in 5 min instead of 30.

### Additional ideas worth flagging (not yet scheduled)

- **GitHub branch protection**: require status checks on PRs, require signed commits, restrict force-pushes on `main`. Not in scope here because branch protection lives in repo settings (web UI / `gh repo edit`), not in this repo's files. Worth a 30-min config session.
- **`cargo deny` `[bans]` `multiple-versions = "deny"`**: tightens the build to fail when transitive deps pull conflicting versions of the same crate. High value for security (smaller dep tree = smaller attack surface) but creates ongoing PR-blocker pain. Schedule only if there's appetite for the audit cycle.
- **OIDC for any cloud auth**: not applicable today (Agaric ships no secrets to clouds), but if PEND-36 adds Play Store API upload automation, use Google's OIDC trust instead of a long-lived service account key.
- **`prek` cargo install** in `_validate.yml` could move to `taiki-e/install-action` once that action ships a prek binary recipe (already covered by `cargo install --locked` for now).
- **Renovate vs Dependabot**: Renovate has more granular grouping rules (e.g., "group all @types/* together"). If Dependabot's PR firehose for npm/cargo gets unmanageable, swap to Renovate. Today only `github-actions` is enabled, so the firehose isn't a real concern yet.

## Cost / Impact / Risk

- **Cost:** S-M cumulative (~6-10 h for #5 + #8 + #9 + #10 combined; #9 is the only one that might balloon if the inventory of untrusted download paths is bigger than expected).
- **Impact:** **Medium**. The "do now" 5 items shipped already cut most of the immediate attack surface — these stretch items are "raise the bar further" rather than "close an open hole." #5 (SLSA provenance) has the highest user-facing value because it lets downstream verifiers trust release artifacts without trusting the distribution channel.
- **Risk:** **Low**. None of these change runtime behavior in production; they're all CI / build-time / docs.

## Open questions

1. Want SLSA provenance on **every** release artifact (Android APK + AAB, all desktop bundles, MCP sidecar) or only a subset (e.g., just the Play Store-bound AAB)? Recommend "all" — incremental cost is near-zero once the action is wired.
2. `cargo deny` `[bans]` policy — appetite for the ongoing PR-blocker overhead?
3. Threat model doc location — extend `SECURITY.md` (one file, more discoverable) or new `docs/SECURITY-THREAT-MODEL.md` (more space for nuance, less prominent)?
4. Branch protection: do this via `gh repo edit` from a script (reproducible, version-controlled in `scripts/setup-branch-protection.sh`) or one-time web-UI click (faster but undocumented)?

## Related

- `pending/PEND-37-local-dev-speed.md` — sibling perf plan; references this for the security-baseline updates that shipped alongside.
- `pending/PEND-39-ci-parallelism.md` — CI changes that shifted line numbers + invalidated zizmor baseline; resolved by the SHA-pinning that closed `unpinned-uses` entirely.
- `pending/PEND-36-play-store-publishing.md` — #5 (SLSA provenance) helps Play Store reviewers verify release artifacts.
- `SECURITY.md`, `AGENTS.md` "threat model" section — eventual home for #10's content.
- `.github/zizmor.yml` baseline, `.nsprc` waiver list — both reference "expires/triage" patterns this plan formalizes.
