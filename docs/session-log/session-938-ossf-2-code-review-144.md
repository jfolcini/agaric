## Session 938 — OSSF-2: document Scorecard `Code-Review` = 0 (solo-maintainer ruleset) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator only (config/docs investigation) |
| **Items closed** | none (#144 stays open as tracking item — see below) |
| **Items modified** | #144 (investigation + disposition) |
| **Files touched** | 3 docs + 1 session log |
| **Tests added** | n/a (docs-only) |

**Issue:** #144 — OSSF Scorecard `Code-Review` check reports 0 for this solo-maintainer repo. Investigate and make the appropriate config/docs change; if the score genuinely can't improve for a solo maintainer, document the rationale (as #145/#314 did for OSSF-3).

**Investigation:**
- Confirmed the live `main` ruleset against the docs via `gh api repos/jfolcini/agaric/rulesets/16192713`: rule-type set matches the documented six; `bypass_actors` = a single Admin `RepositoryRole` with `bypass_mode: always`.
- Scorecard's `Code-Review` pillar is independent of `Branch-Protection`: it walks recent default-branch commits for per-commit review evidence (approving PR review, `Reviewed-by:` trailer, bot merge). Because the solo maintainer pushes **directly** to `main` under the admin bypass, every recent changeset is "0/N reviewed" and the check floors at 0. This is the same design decision as the `Branch-Protection` "applies to administrators" sub-check (the admin bypass), viewed through a different pillar.
- There is **no Scorecard per-check waiver knob** (unlike `cargo deny` / `cargo audit` per-advisory ignores used for OSSF-3 `Vulnerabilities`). The only way to lift `Code-Review` is to route the maintainer's commits through reviewed PRs — i.e. abolish the solo-development workflow. So the honest disposition is to document the 0 and its cause, not chase it.
- **Drift found and corrected:** `ci-and-tooling.md` §13 claimed the `pull_request` rule "requires code-owner review (CODEOWNERS file at repo root drives the routing)", but the live `require_code_owner_review` is `false` (a code-owner-review gate would deadlock a solo maintainer — GitHub forbids self-approval). Updated the prose to match the live config and the architectural reason.

**Changes (config/docs only — no app source; off-limits `db.rs`/`migrations/` untouched):**
- `docs/architecture/ci-and-tooling.md` — corrected the `require_code_owner_review` drift in two places; added a new sub-section *"Scorecard `Code-Review` = 0 is structural, not a gap (OSSF-2, #144)"* explaining how the pillar scores, why the bypass floors it, that it auto-recovers when a second reviewed-PR contributor lands, and the shared revisit trigger (first external maintainer).
- `SECURITY.md` — added OpenSSF Scorecard to "Existing automated coverage" and a transparency sub-section documenting both `Code-Review` = 0 (OSSF-2/#144) and `Vulnerabilities` = 0 (OSSF-3/#145) as deliberate solo-maintainer consequences, not in-scope findings, with links to the canonical rationale files.
- `docs/session-log/session-938-ossf-2-code-review-144.md` — this log.

**Disposition:** #144 stays **open** as the tracking item (mirrors #145 after #314): the 0 is structural and only changes when the first external maintainer onboards. PR refs #144 (does NOT auto-close).

**Verification:**
- Live ruleset/bypass re-read via `gh api` matches documented shape.
- `git grep` confirms no remaining "requires code-owner review" / `require_code_owner_review: true` claims.
- Pre-push hooks (markdown/lint checks) run at push time.
