## Session 1258 — MCP documentation contracts (2026-08-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-05 |
| **Subagents** | 1 build + 2 review |
| **Items closed** | #3300 |
| **Items modified** | — |
| **Tests added** | +0 frontend / +1 backend |
| **Files touched** | 7 |

**Summary:** Corrected four MCP integration-document claims to match the implemented
Windows pipe ACL, read-only and read-write space-scoping contracts, activity-summary
field policy, and tool-registration workflow. Tightened the corresponding Rustdoc and
added exact coverage for boolean property-value summaries, then regenerated the Specta
bindings.

**Files touched (this session):**
- `docs/architecture/integrations.md`
- `docs/features/agent-access.md`
- `src-tauri/src/mcp/AGENTS.md`
- `src-tauri/src/mcp/activity.rs`
- `src-tauri/src/mcp/summarise.rs`
- `src/lib/bindings.ts`
- `docs/session-log/session-1258-mcp-doc-contracts.md` (new)

**Verification:**
- Focused MCP activity and summariser tests — 54/54 passed.
- Targeted Specta binding-freshness test — 1/1 passed.
- `cargo fmt --all --check`, Markdownlint, documentation-link and code-path checks,
  stale-claim scans, and `git diff --check` — passed.
- Independent adversarial review — approved with no findings after checking the final
  documentation claims against the pipe, tool, scope, and summary implementations.
- Independent technical review — approved with no findings.
- Canonical `just verify` — passed end-to-end: Phase A hooks and guards; 147 Vitest
  files / 4,705 tests; 178 related Rust tests; workspace doctests (7 passed, 4 ignored);
  all four SQLx cache lanes; MCP UDS smoke and release-sidecar checks; Cargo audit and
  npm signature audit.
- pre-commit hook — pending commit.
- pre-push hook — pending push.

**Process notes:** Activity success summaries intentionally expose only bounded,
field-filtered metadata: structural counts, dates, property keys, scalar number/date/
boolean values, and eight-character identifier/reference prefixes. User-authored block
content, page titles, tag display names, query strings, and text property values remain
excluded. Error summaries are a separate clipped channel and are not described as
redacted.

**Lessons learned (for future sessions):** Documentation about privacy or access scope
must enumerate the implemented fields and tool-by-tool exceptions. Broad labels such as
"privacy-safe" or "space-scoped" conceal meaningful distinctions and drift faster than
an explicit contract backed by exact tests.

**Commit plan:** single commit, then push and open a stacked PR.
