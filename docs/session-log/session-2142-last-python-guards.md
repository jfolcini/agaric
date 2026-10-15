# Session 2142 — two more Python scripts go; check-baseline-paths stays

#5579's last step, after the audit's maintainer calls.

Deleted:

- `scripts/mcp_smoke.py`, a manual MCP smoke run by nobody
  automatically, with its README section and its line in
  `src-tauri/src/mcp/AGENTS.md`. `uv` stays: zizmor's fallback install and
  code-review-graph still use it.
- `scripts/check-migration-mock-contract.py`, its two hooks and its
  baseline `src-tauri/migrations-mock-ack-baseline.txt`. AGENTS.md's
  testing invariant 3 (a migration touching a table the mock reads updates
  the mock in the same PR) stays the rule; the hook-specific instructions
  in `src-tauri/migrations/AGENTS.md` are gone. Five shipped migrations
  (0106, 0107, 0111, 0113, 0114) still name the script in comments; they
  are immutable, so they stay.

Kept: `scripts/check-baseline-paths.py`. Its deletion depended on every
set it covers being checked by its own guard. On a scratch copy, one
entry naming a missing file was added to each set and the owning guard
run:

| Set | Owner fails on a dangling entry |
| --- | --- |
| bulk-equivalence, content-regex and doc-code-paths baselines | yes |
| `dynamic-sql-baseline.txt` | yes |
| `unsafe-allowlist.txt` | yes |
| `check-ipc-error-path.mjs` `NO_TEST_ALLOWLIST` | yes |
| `check-raw-tx.mjs` `ALLOWLIST_GLOBS` exact paths | no |
| `check-raw-invoke.mjs` `EXEMPT_FILES` and `EXEMPT_DIR_PREFIXES` | no |
| `check-raw-local-storage.mjs` `EXEMPT_FILES` | no |

Four sets would protect nothing silently if an entry rotted, so the guard
stays. Its entry for the deleted mock baseline is removed.

Ran: `prek run --all-files`, `check-hook-budget.mjs` (120/140),
`npm run typecheck`, `oxfmt` and `oxlint` on the changed mock file.
