# `docs/security/` — security review artefacts

This directory holds the structured security reviews that the
OpenSSF Best Practices Silver-tier [`security_review`](https://www.bestpractices.dev/en/criteria/2#2.security_review)
criterion asks for. They are distinct from the **continuous-coverage
tooling** (`cargo-deny`, `cargo audit`, `clippy`, `biome`, `gitleaks`,
`zizmor`, OpenSSF Scorecard, CodeQL) — those run on every PR and
score the project's posture; a review here looks at the same surface
but with a maintainer's brain attached.

## Cadence

A new review is filed at whichever of the following comes first:

- a `0.X.0` minor cut, OR
- 12 months since the previous review.

The 12-month window is the Silver criterion's hard limit. The
minor-cut trigger is the practical one — a minor bump usually means
enough churn that the diff-sweep is non-trivial.

A `prek.toml` hook can be added to warn when the latest
`review-YYYY-MM-DD.md`'s `mtime` is past the 12-month line; that
hook is filed under "consider when cadence drifts in practice" and
not pre-emptively added (per PEND-49 §5b open question 3).

## Scope of each review

1. **STRIDE walkthrough** of [`../architecture/threat-model.md`](../architecture/threat-model.md)
   trust boundaries B1–B5. Each row: is the mitigation still
   load-bearing? Has the threat changed shape? Any new sub-rows?
2. **Diff-sweep** of code added since the prior review that touches
   any of:
   - IPC boundary (`src-tauri/src/commands/`)
   - Sync transport (`src-tauri/src/sync_*`)
   - OAuth (`src-tauri/src/commands/gcal.rs`, `src-tauri/src/gcal_push/`)
   - Updater (the `tauri-plugin-updater` integration in `src-tauri/src/lib.rs`)
   - MCP exposure (`src-tauri/src/mcp/`)
3. **Findings disposition.** Each finding goes to one of:
   - fixed in the same review window (commit ref in the report),
   - filed as a GitHub issue (link in the report),
   - documented as Accepted with rationale (Accepted-row update in
     the threat model, link in the report).

## Naming

`review-YYYY-MM-DD.md`. Multiple reviews per year are fine; the date
is just an ordering key.

## What does NOT belong here

- Continuous-coverage tooling output (Scorecard reports, CodeQL
  alerts, `cargo audit` dumps). Those have their own dashboards in
  GitHub's Security tab.
- Per-CVE post-mortems for vulnerabilities reported via
  [`SECURITY.md`](../../SECURITY.md) — those become GitHub Security
  Advisories, not files here.
- Speculative threat modelling for unbuilt features — that lives in
  the [`architecture/threat-model.md`](../architecture/threat-model.md)
  "Open questions" section.

## Cross-references

- [`../architecture/threat-model.md`](../architecture/threat-model.md) —
  the document each review walks.
- [`../architecture/ci-and-tooling.md`](../architecture/ci-and-tooling.md) —
  the continuous-coverage tooling each review draws evidence from.
- [`../../SECURITY.md`](../../SECURITY.md) — the disclosure path.
- The broader Silver roadmap is tracked separately; §5b is this directory.
