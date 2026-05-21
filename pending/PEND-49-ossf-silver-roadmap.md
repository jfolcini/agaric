# PEND-49 — Road from OpenSSF Best Practices **Passing → Silver**

> The Passing-tier badge was achieved 2026-05-17 (project [#12870](https://www.bestpractices.dev/projects/12870)). This plan catalogs the 14 Silver-tier criteria that are still **Unmet** on the bestpractices.dev self-assessment, with disposition and cost for each. It is the single source of truth for "the road to Silver"; the older `OSSF-1` line in `REVIEW-LATER.md` now points here.
>
> **Source of truth for current state:** `curl -s https://www.bestpractices.dev/projects/12870.json | jq '{passing: .badge_percentage_0, silver: .badge_percentage_1, gold: .badge_percentage_2}'`. Numbers below may drift — re-pull before scheduling.

## TL;DR

- **Passing:** 100 % (Met 2026-05-17). Badge already in `README.md`.
- **Silver:** 93 % at time of writing, 14 criteria Unmet.
- **Gold:** 43 %, 68 OSPS-* criteria untouched. **Not pursued while solo-maintained.**

The 14 Silver gaps split into five buckets. Only **bucket 5** (4 items) needs new engineering work; the other 10 are either already factually met, deliberately non-policy, upstream-blocked, or auto-meet once the project picks up an external contributor / maintainer.

## Bucket 1 — Already factually Met; only the form needs updating (~15 min)

Both are stale on the bestpractices.dev side because the form was last edited before `1a1146c8` raised the vitest gates.

| Criterion | Observed | Gate | Form fix |
|-----------|----------|------|----------|
| `test_statement_coverage90` | 90.17 % statements (CI run `25985548538`) | `vitest.config.ts` `statements: 89` (2 pp headroom for shard-merge wobble) | Update justification: "≥ 90 % statements observed; gate set 1 pp below to absorb shard-merge wobble." |
| `test_branch_coverage80` | 81.81 % branches | `branches: 80` | Update justification: "≥ 80 % branches observed; gate set at 80." |

**Action:** one editing pass on the bestpractices.dev form, then flip both to Met. Instant +2 criteria.

## Bucket 2 — Deliberate non-policy (keep Unmet on purpose)

| Criterion | Why Unmet stays | Action |
|-----------|-----------------|--------|
| `copyright_per_file` | Project uses repo-root `LICENSE` only; per-file headers are explicit non-policy (extra churn on every file, no consumer asks for it). | Keep current justification. No further action. |
| `license_per_file`   | Same rationale. SPDX-License-Identifier headers are not added. | Same. |

**Action:** none. Both stay Unmet by design. Mentioned here so a future maintainer doesn't re-open the question.

## Bucket 3 — Auto-meets when the project picks up external collaborators

| Criterion | Auto-meet trigger |
|-----------|-------------------|
| `bus_factor`                  | First external maintainer with merge rights joins. |
| `access_continuity`           | Same. (bestpractices.dev currently scores the two together for solo projects.) |
| `contributors_unassociated`   | First external contributor lands a non-trivial PR. |
| `small_tasks`                 | First `good-first-issue` label added once the issue tracker has real volume. Cheap to do now (S, ~15 min) — keeping deferred so the label isn't a stale fixture. |
| `two_person_review`           | Currently blocked by the R12 maintainer-bypass design choice (`docs/architecture/ci-and-tooling.md` §13). Flips to Met when the ruleset is flipped to symmetric. Same trigger as `OSSF-2` in `REVIEW-LATER.md`. |

**Action:** none until the trigger fires. When the first external contributor / maintainer lands, sweep these five at once.

## Bucket 4 — Upstream-blocked

| Criterion | Blocker |
|-----------|---------|
| `hardening` | Tauri webview doesn't expose customisable HTTP response headers (CSP / HSTS) the way a hosted web app would. Closest analog is capability-based IPC in `src-tauri/capabilities/default.json`. Revisit when CSP-via-Tauri lands upstream. Tracking issue: <https://github.com/tauri-apps/tauri/issues> (no concrete pin — none of the current upstream issues line up cleanly with the bestpractices.dev question shape). |

**Action:** none. Add the upstream link to the justification when a concrete tracking issue exists.

## Bucket 5 — Genuine engineering work needed

These four are the actual cost of Silver. Listed in the recommended order (cheapest first, tentpole last).

### 5a. `assurance_case` — S (~2-4 h, doc-only)

**What's needed:** a documented assurance case — top-level security claims plus the arguments and evidence that justify them.

**Current state:** `docs/architecture/threat-model.md` (200 lines) already provides STRIDE-per-trust-boundary analysis of five boundaries (B1–B5), attack-surface enumeration, and out-of-scope notes. That covers most of the *substance* of an assurance case; the gap is *framing*.

**Two viable shapes, in increasing cost:**

1. **Add an "Assurance case" section to `threat-model.md`** (~2 h). One paragraph per top-level claim ("user data stays local", "IPC is capability-gated", "release artifacts are signed and attested", "vulnerabilities reach the maintainer privately"), each linking to the STRIDE rows + the CI evidence (SLSA provenance, SBOMs, cosign signatures, SECURITY.md disclosure path).
2. **Standalone `docs/architecture/assurance-case.md`** (~4 h). Strict assurance-case shape (GSN-lite: G/S/Sn nodes) rather than prose. Heavier, more orthodox; harder to maintain in lockstep with the threat model.

**Recommendation:** start with (1). The threat model is the authoritative document; an assurance case sitting next to it that argues over the same STRIDE findings would just drift. Filed shape (1) lifts the Silver criterion with the lowest doc-rot cost.

### 5b. `security_review` — M (~4-8 h to define + first-pass)

**What's needed:** a documented "security review performed within the last 5 years" — for the bestpractices.dev form to flip to Met, this must be a *structured* review, not an aggregate of continuous-coverage tooling.

**Current continuous-coverage tooling** (does **not** qualify on its own per the form's wording, but is the evidence the review draws from):

- `cargo-deny` + `cargo audit` + RUSTSEC ignore-with-rationale (`src-tauri/deny.toml`)
- `zizmor` workflow lints
- `clippy` + `biome` + `gitleaks` + `prek` hook chain
- OpenSSF Scorecard weekly cron (`.github/workflows/scorecard.yml`)
- CodeQL on every push (`.github/workflows/codeql.yml`)

**Proposed structure** (defines what "review" means for this project):

- **Cadence:** at each `0.X.0` minor cut, or annually — whichever is sooner.
- **Scope:** STRIDE walkthrough of B1–B5 in `threat-model.md`, plus diff-sweep of code added since the prior review touching: IPC boundary (`src-tauri/src/commands/`), sync transport (`src-tauri/src/sync_*`), OAuth (`src-tauri/src/commands/gcal.rs`, `src-tauri/src/gcal_push/`), updater (`src-tauri/src/auto_update.rs`), MCP exposure (`src-tauri/src/mcp/`).
- **Deliverable:** `docs/security/review-YYYY-MM-DD.md` — a short report (1-3 pages) listing what was reviewed, what was found, and what was fixed or filed as REVIEW-LATER. Old reports stay in the repo as the audit trail; the latest one is what bestpractices.dev points at.
- **First pass:** run the structure against the current `main`, file the report. Subsequent passes happen on cadence.

**Why this is M not S:** the first pass actually has to *do* the review (~3-5 h) on top of writing the structure (~1 h). Subsequent passes are S (~2 h each).

### 5c. `installation_common` — M-L per platform (cumulative L)

**What's needed:** packaging in the platform's common package manager — at minimum one per OS family.

**Current state:** GitHub Releases ships `.deb` + `.rpm` + `.AppImage` + `.dmg` + `.msi` + `.apk`. No `apt` / `dnf` / `flatpak` / `brew` / `winget` / Play Store entry.

**Per-platform plans:**

| Platform | Path | Cost | Already tracked? |
|----------|------|------|------------------|
| Android  | Play Store via `PEND-36-play-store-publishing.md` | S engineering + M-L process | ✅ yes |
| Linux    | **Flathub** — most realistic single-package answer for a Tauri/GTK app; covers all common Linux desktops. Sub-tasks: write `org.agaric.Agaric.yml` manifest, mirror the AppImage build into a Flatpak builder, submit to flathub/flathub PR queue (review queue typically 1-4 weeks). | M (manifest + first submission) + M (Flathub review iterations) | ❌ no |
| macOS    | **Homebrew Cask** — `agaric.rb` cask in a tap (own tap is simplest; pushing to `homebrew/cask` requires an existing user base). Cheap once the macOS bundle ships with a stable download URL. | S (own tap) → M (homebrew/cask upstream once download counts justify) | ❌ no |
| Windows  | **winget** — `microsoft/winget-pkgs` PR with a manifest. Free, ~1-2 week review. Code-signing is a separate decision (CI-R3 SignPath.io OSS pending, see `REVIEW-LATER.md`); winget accepts unsigned with a warning. | S (manifest) + S (PR review iterations) | ❌ no |

**Recommendation:** Flathub first (covers the largest non-Play-Store install base and the Linux maintainer demographic this project's README targets). Then winget (cheapest after Flathub). Then Homebrew Cask. macOS notarisation (CI-R11, deferred) doesn't gate Homebrew Cask.

**File a follow-up plan when this scope opens up.** This entry is the placeholder; per-platform manifests are not pre-written here.

### 5d. `build_reproducible` — L (multi-week, the tentpole) — already tracked as PEND-48

**Existing tombstone in `REVIEW-LATER.md`:**

> PEND-48 — Verify reproducible builds end-to-end: build the release matrix twice from a clean state, diff hashes, identify and eliminate sources of non-determinism (timestamps, sort order, embedded build env). Greenfield work — `release.yml` has zero `SOURCE_DATE_EPOCH` / reproducibility hooks today.

**No further detail needed here** — PEND-48's tombstone is the canonical entry. Cross-referenced from this roadmap so the Silver-tier blocker is visible alongside the other 13.

**Decision point before scheduling:** scope. Two viable targets:

1. **Desktop matrix only** (Linux `.deb` / `.rpm` / `.AppImage`, Windows `.msi`, macOS `.dmg`) — the easier subset; Rust toolchain pinning + `SOURCE_DATE_EPOCH` + sorted directory walks land here. Android is excluded because Gradle / AGP add their own non-determinism layer.
2. **Desktop + Android** — full release matrix. Android adds AGP build-time stamping, R8 / ProGuard ordering, the keystore-signing pipeline. Higher cost, but `installation_common` (Play Store) doesn't directly need it, so this is independent of Bucket 5c.

**Recommendation:** scope (1) first; file an `installation_common`-like follow-up if Android reproducibility ever becomes load-bearing (e.g., F-Droid inclusion, which does require it).

## Recommended order

1. **Bucket 1 form update** (~15 min) — instant +2 criteria. Net Silver score should rise to ~95-96 %.
2. **5a `assurance_case`** (~2-4 h) — pure doc; closes the only Bucket-5 criterion that doesn't have a load-bearing tail.
3. **5b `security_review`** (~4-8 h first pass; recurring S thereafter) — defines a cadence the project can sustain.
4. **5c `installation_common` — Flathub first** (~M for the first submission, then review-cycle latency).
5. **5d `build_reproducible`** (PEND-48, multi-week) — the tentpole. Schedule when there is a contiguous window; do not interleave with feature work.

Buckets 2, 3, 4 do not move from this list — they Met-or-not on external triggers, not maintainer effort.

After steps 1-5, the Silver percentage should sit in the high-90s, with only Buckets 2/3/4 holding it back from 100 %.

## Cost / Impact / Risk

- **Cost:** ~10-20 person-hours for steps 1-3 (form + doc + first review) + M-L per platform for 5c + L multi-week for PEND-48.
- **Impact:** **Medium.** Silver tier is a visible posture signal (the badge auto-updates) and a real bar for some downstream consumers (e.g., distros, Flathub reviewers, corporate procurement). It is **not** load-bearing for the current user base.
- **Risk:** **Low.** No item here changes the runtime; the engineering items (PEND-48, Flathub) touch build / packaging only. The doc items (5a, 5b) are documentation, not code.

## Status (2026-05-20)

Open question 1 resolved by maintainer: **yes, go for Silver.** Three of the four engineering items shipped in the same branch as this status update (PR #44):

- **5a `assurance_case`** — section added to [`docs/architecture/threat-model.md`](../docs/architecture/threat-model.md#assurance-case). Six top-level claims, each linked to the cited STRIDE row + CI evidence. **OpenSSF form: flip to Met, point at the new section anchor.**
- **5b `security_review`** — `docs/security/` directory with [`README.md`](../docs/security/README.md) (cadence contract) + the first review report ([`review-2026-05-20.md`](../docs/security/review-2026-05-20.md)). **OpenSSF form: flip to Met, point at the latest review.**
- **5c `installation_common` (Flathub)** — manifest scaffold at `packaging/flathub/`; see [`packaging/flathub/README.md`](../packaging/flathub/README.md) for status + 4 open questions that block the actual Flathub PR. **OpenSSF form: stays Unmet until Flathub submission merges.**
- **5d `build_reproducible`** — unchanged; tracked separately as PEND-48 multi-week tentpole.

After the maintainer flips the form rows for 5a + 5b (and Bucket 1 — see below), the Silver percentage should move from 93 % → ~95-96 %. The cap stays at ~95-96 % per Open question 1's original analysis until Buckets 2/3/4 unblock (some on external trigger, some on policy).

**Bucket 1 form-only update is still pending the maintainer logging into bestpractices.dev** (a 15-minute web form edit). Expected lift: +2 criteria.

## Open questions

1. ~~**Should the maintainer pursue Silver at all while solo?**~~ **Resolved 2026-05-20: yes.** 5a + 5b shipped locally; 5c scaffolded; 5d still PEND-48.
2. **Bucket 5c sequencing vs. PEND-36.** PEND-36 (Play Store) has its own 4 maintainer decisions still open (D1-D3). Holding the desktop package work behind PEND-36 risks blocking on the Play Store paperwork timeline. Treat the four platforms (Android / Linux / macOS / Windows) as independent.
3. **5b cadence enforcement.** Annual reviews drift without a forcing function. Options: a yearly `prek.toml` hook reading the `mtime` on the latest `docs/security/review-*.md` and warning past 12 months, or a calendar reminder. The first review's own follow-up section names a tentative 2026-11-20 mid-window check; if no minor cut by then, plan the next review around it.

## Related

- `pending/PEND-36-play-store-publishing.md` — Android side of `installation_common`.
- `pending/REVIEW-LATER.md` `PEND-48` — `build_reproducible` (5d).
- `pending/REVIEW-LATER.md` `OSSF-1..4` — Scorecard sub-checks (different scoring system from bestpractices.dev tiers; do not confuse).
- `docs/architecture/threat-model.md` — STRIDE per-boundary, foundation for the assurance case (5a) and the structured review (5b).
- `docs/architecture/ci-and-tooling.md` §13 — R12 maintainer-bypass design choice; the upstream reason `two_person_review` stays Unmet while solo.
- `SECURITY.md` — disclosure path; cited from the assurance case.
