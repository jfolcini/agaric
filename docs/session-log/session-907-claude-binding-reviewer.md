## Session 907 — Claude as a binding PR reviewer (approve, incl. Dependabot) (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | none (single-thread config change) |
| **Items closed** | — |
| **Items modified** | — |
| **Tests added** | 0 (CI-config change; no app code touched) |
| **Files touched** | 2 (`.github/workflows/claude-code-review.yml`, this log) + 1 live ruleset edit (not a file) |

**Goal:** make the existing Claude Code Review workflow *binding* — submit an actual
GitHub **Approve** review that satisfies the `main` ruleset's required review — and have
it cover Dependabot PRs, not just human ones.

**Why a separate identity is unavoidable:** GitHub blocks any account/bot from approving
its own PR, and approvals made with the default `GITHUB_TOKEN` (`github-actions[bot]`) do
not count toward required reviews. Our human PRs are authored by `@jfolcini`, so the
approver must be a *distinct* identity → a dedicated **reviewer GitHub App**.

**Workflow change (`claude-code-review.yml`):**
- Job `permissions.pull-requests` `read` → `write` (submit the review verdict).
- New step `Generate reviewer app token` (`actions/create-github-app-token@v3.2.0`,
  pinned `bcd2ba4…`), gated on `env.HAS_REVIEWER_APP` (mapped from `secrets.REVIEWER_APP_ID`
  presence, because `secrets` can't be read from a step `if:`). No-op until the app exists.
- `claude-code-action` now receives `github_token: ${{ steps.app-token.outputs.token || github.token }}`
  so the verdict is attributed to the app (graceful fallback to the default token —
  review still runs, approval just won't count — before the app is configured).
- Prompt extended: after `/code-review`, cast a verdict — `gh pr review --approve` when no
  blocking (high-severity correctness/security) issues, else `--request-changes`.
  `claude_args: --allowed-tools "Bash(gh pr review:*)"`. `dismiss_stale_reviews_on_push`
  in the ruleset means it re-reviews and re-approves on every push.
- `allowed_bots: 'dependabot[bot]'` was already present.

**Ruleset change (live, via `gh api` — not a file in this repo):** `main` ruleset
`pull_request` rule `require_code_owner_review` `true` → `false`. Required because a GitHub
App's bot cannot be a CODEOWNERS owner, so the app's approval can satisfy the required
review only with the code-owner gate off. Everything else preserved
(`required_approving_review_count: 1`, `require_last_push_approval: true`,
`required_review_thread_resolution: true`, `required_signatures`, `validate-all`/`dco`
status checks, linear history). `branch-protection-assert.yml` asserts only the *set of
rule types* (not their parameters), so it still passes.

**OpenSSF Scorecard impact (assessed — this repo cares about the badge):**
- *Branch-Protection*: `scorecard.yml` runs with the default `GITHUB_TOKEN` and supplies no
  privileged `repo_token` PAT, so Scorecard cannot read ruleset/branch-protection detail
  today — the check is already inconclusive and the admin-bypass actor already caps it.
  Turning off code-owner review therefore has **no measured score impact now**; it would
  cost a small amount *only if* a privileged PAT is later added to the Scorecard run.
- *Token-Permissions*: top-level stays `contents: read`; the new write is job-scoped
  (`pull-requests: write`), which Scorecard tolerates → **no impact**.
- *Pinned-Dependencies*: the new action is hash-pinned with a version comment → **compliant**.
- *Dangerous-Workflow*: trigger stays `pull_request` (not `pull_request_target`); the only
  `github.event` interpolation is the PR *number* (an integer) inside a `with:` input, not a
  `run:` shell step → **no script-injection finding**.

**Security trade-off recorded:** disabling code-owner review removes the human gate on the
extra-scrutiny paths CODEOWNERS deliberately flags (`src-tauri/migrations/`,
`.github/workflows/`, `deny.toml`, `.nsprc`, …). Alternative that preserves it (and the
latent Scorecard point): keep `require_code_owner_review` and add a *machine-user account*
(not an app — apps can't be CODEOWNERS) to CODEOWNERS, approving via that user's PAT. Not
taken here in favour of the app's short-lived tokens.

**Manual follow-up required before approval goes binding (cannot be automated):**
1. Create + install a `agaric-reviewer` GitHub App (PRs: write, Contents: read), generate a
   private key, note the App ID.
2. Repo Actions secrets: `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`.
3. **Dependabot** secret store (separate — this is why review run `26664148150` on PR #239
   failed): `CLAUDE_CODE_OAUTH_TOKEN`, `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`.

**Verification:** `claude-code-review.yml` parses (`yaml.safe_load` OK); ruleset PUT
confirmed (`require_code_owner_review: false`, count 1, last-push-approval true). No app
code touched, so no test suite run.
