## Session 1259 — Query NULL parity (2026-08-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-05 |
| **Subagents** | 1 build + 2 review |
| **Items closed** | #3263 |
| **Items modified** | — |
| **Tests added** | +4 frontend / +4 backend |
| **Files touched** | 9 |

**Summary:** Aligned the composed property-query `neq` predicates with the canonical
cross-typed NULL semantics, and made the batched first-child lookup use the canonical
NULL-last position sentinel. Mirrored both behaviors in the Tauri mock and added exact
behavioral and source-level drift regressions.

**Files touched (this session):**
- `src-tauri/src/commands/blocks/queries.rs`
- `src-tauri/src/commands/queries.rs`
- `src-tauri/src/commands/tests/block_cmd_tests.rs`
- `src-tauri/src/commands/tests/query_cmd_tests.rs`
- `src-tauri/src/pagination_app_tests.rs`
- `src/lib/__tests__/tauri-mock.test.ts`
- `src/lib/tauri-mock/handlers/blocks.ts`
- `src/lib/tauri-mock/handlers/shared.ts`
- `docs/session-log/session-1259-query-null-parity.md` (new)

**Verification:**
- Focused Rust regressions — 4/4 passed; related builder selection — 19/19 passed.
- Focused Tauri mock suite — 274/274 passed.
- `cargo clippy -p agaric --tests -- -D warnings`, `cargo fmt --all --check`,
  `npx tsc -b --pretty false`, targeted OXC, and `git diff --check` — passed.
- Independent adversarial review — approved with no findings after rerunning focused
  Rust, mock, Clippy, formatting, lint, and diff checks.
- Independent technical review — approved with no findings.
- Canonical `just verify` — passed end-to-end: all repository-wide hooks; 147 Vitest
  files / 4,705 tests; 232 related Rust tests; workspace doctests (7 passed, 4 ignored);
  all four SQLx cache lanes; MCP UDS smoke and release-sidecar checks; Cargo audit and
  npm signature audit.
- pre-commit hook — pending commit.
- pre-push hook — pending push.

**Process notes:** A non-reserved property row exists even when its queried typed column
is NULL, because the value can live in a sibling typed column; under `neq`, that row is
unequal and must survive. A missing property key still fails the enclosing `EXISTS`.
Reserved native columns deliberately retain their separate `IS NOT NULL` gate. The mock
tracks which storage source produced the candidate values so it preserves this boundary.

**Lessons learned (for future sessions):** Mirroring a SQL NULL fix by changing only a
comparison helper can erase routing distinctions the database expresses structurally.
Regression fixtures need equal, different, sibling-typed, missing-key, and reserved-null
controls to distinguish the intended semantics from an overly broad always-true fix.

**Commit plan:** single commit, then push and open a stacked PR.
