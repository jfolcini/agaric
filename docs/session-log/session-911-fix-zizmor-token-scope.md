## Session 911 — Fix zizmor github-app red on all PRs + skill CI-gate (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (unblocks #242 / #243 / #244 lint) |
| **Items modified** | — |
| **Tests added** | — (CI-config + skill-doc fix) |
| **Files touched** | 3 |

**Summary:** Fixed the `validate / lint` failure that red-lit every open PR. zizmor's `github-app` audit (High confidence) flagged `claude-code-review.yml:53` — `actions/create-github-app-token` minted a token inheriting **all** of the reviewer app's installation permissions ("excessive permissions"). Scoped it to the minimum the reviewer needs (`permission-contents: read`, `permission-pull-requests: write`); the token is already auto-scoped to this repository. This is a real least-privilege fix, not a suppression. Because the finding lives on `main`, it must merge first to clear the inherited failure on #242/#243/#244.

Also hardened the `batch-issues` skill: a new **PLAN step 1 CI gate** ("check CI on all open PRs and fix every red — including failures inherited from `main` — before starting a new batch") plus a Common Pitfall ("Dismissing a red check as 'not my diff'"). This encodes the correction from this session, where the zizmor finding was wrongly parked as "orthogonal" and silently blocked four PRs.

**Files touched (this session):**
- `.github/workflows/claude-code-review.yml` (+6 — scope the app token via `permission-*` inputs)
- `.claude/skills/batch-issues/SKILL.md` (+2 blocks — PLAN CI gate + pitfall)
- `docs/session-log/session-911-fix-zizmor-token-scope.md` (new)

**Verification:**
- pre-push hook Phase A (`prek run --all-files`, includes zizmor) — passes (the `github-app` finding is cleared by the scoping).
- Once merged to `main`: re-run lint on #242/#243/#244 → green.

**Process notes:**
- Lesson (saved to memory): an inherited-from-`main` red check is still the loop's job to fix; "not from my diff" does not make it ignorable, because it blocks merge of otherwise-green work.

**Commit plan:** single commit / pushed.
