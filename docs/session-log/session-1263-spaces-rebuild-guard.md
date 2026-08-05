## Session 1263 — Spaces rebuild preservation guard (2026-08-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-05 |
| **Subagents** | 1 build + 2 review |
| **Items closed** | #3271 |
| **Items modified** | — |
| **Tests added** | +28 guard assertions; migration boundary coverage strengthened |
| **Files touched** | 7 |

**Summary:** Extended the blocks-rebuild cascade guard and migration harness to preserve
the `spaces` registry and exact `blocks.space_id` memberships alongside page aliases and
drafts. The documented recipe now snapshots owners and member mappings, empties the
registry before the rebuild, and restores owners before correlated memberships.

**Files touched (this session):**
- `scripts/check-migrations-rebuild-cascade.mjs`
- `prek.toml`
- `src-tauri/src/db/tests.rs`
- `src-tauri/migrations/AGENTS.md`
- `.github/workflows/_validate.yml`
- `scripts/verify-ci-equivalent.sh`
- `docs/session-log/session-1263-spaces-rebuild-guard.md` (new)

**Verification:**
- Guard fixture suite — 28/28 assertions passed; every shipped migration passed.
- Dedicated live guard and guard-self-test prek hooks — passed.
- Migration preservation suite (`test(/_(376|606|708)$/)`) — passed; the focused
  `_606` / `_708` subset passed 10/10.
- Workspace/all-target Clippy with warnings denied, Rust formatting, Oxlint/Oxfmt,
  Markdown lint, link targets, code-path citations, and `git diff --check` — passed.
- Independent adversarial and technical reviews — approved with no remaining findings.
- Canonical `just verify` — passed end-to-end: all repository-wide hooks; 219 Vitest
  files / 6,491 tests; 752 related Rust tests; 7 doctests passed / 4 ignored; all four
  SQLx cache lanes; MCP UDS smoke and release-sidecar checks; Cargo audit and npm
  signature audit.
- pre-commit hook — pending commit.
- pre-push hook — covered by the successful canonical verifier; transfer-only push
  planned after commit.

**Process notes:** Migration 0089 is handled as the one-time registry introduction: the
test now asserts its complete space state immediately at the 0088→0089 boundary and
again at head. Future rebuilds use a canonical trigger-registered fixture and assert the
exact registry, an unassigned owner, the member-to-owner mapping, aliases, drafts,
scratch cleanup, and foreign-key integrity. The source guard strips comments and string
literals, links snapshots to their restores, and rejects name-only, nested-source,
conditional-delete, unaliased-membership, and uncorrelated-update decoys.

**Review follow-up (CHANGES_REQUESTED on PR #3425):** the derived required-column set is
now enforced on the RESTORE projection/column list as well as the snapshot — a full
`SELECT *` snapshot paired with `INSERT INTO block_drafts (block_id, content, updated_at)`
previously passed while discarding `draft_anchor_seq`/`draft_anchor_device` for every
drafted row. The future-rebuild path also gained the "registry stays empty from its
DELETE until after the blocks rename" check that the 0089 introduction path already had.
The Rust harness seeds non-default anchor values (`4242` / `'DEV606ANCHOR'`) and asserts
them, so a column-dropping rebuild reddens the runtime test too. Both new checks were
verified against hand-built evading migrations that the pre-fix guard passed green.

**Lessons learned (for future sessions):** Preserving the registry alone is insufficient:
deleting its rows fires `ON DELETE SET NULL` into copied block memberships. Snapshot the
membership map before emptying the registry, keep the registry empty through the swap,
restore owners first, then restore memberships with an exact correlated update. Assert
state at the migration boundary so later repair work cannot mask a destructive step.

**Commit plan:** single commit, then push and open a stacked PR.
