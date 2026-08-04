## Session 1247 — Restore Claude workflow model selection (2026-08-04)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-04 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | #3409 |
| **Items modified** | — |
| **Tests added** | +0 frontend / +0 backend |
| **Files touched** | 3 |

**Summary:** Restored the globally failing Claude review and `@claude` workflows by
replacing the stale fixed `claude-opus-4-8[1m]` model name with Claude Code's supported
`opus[1m]` alias. The alias retains the required long context while tracking the latest
available Opus model; workflow permissions and security controls are unchanged.

**Files touched (this session):**
- `.github/workflows/claude-code-review.yml` (model alias + comment correction)
- `.github/workflows/claude.yml` (model alias + comment correction)
- `docs/session-log/session-1247-claude-model-alias.md` (new)

**Verification:**
- Reproduced PR #3408's `claude-review` failure twice: one turn, zero cost, and
  `is_error:true` in under one second.
- Both workflow files parse as YAML with the installed `yaml` package.
- `git diff --check` — passed.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full CI-equivalent checks pass.

**Process notes:** The standalone `actionlint` binary is not installed locally. The normal
repository hooks remain authoritative and validate workflow syntax, pinned actions, and
workflow security before push.

**Commit plan:** single commit, pushed.
