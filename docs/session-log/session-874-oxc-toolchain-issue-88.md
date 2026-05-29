## Session 874 — Adopt the OXC toolchain (Biome → oxlint + oxfmt) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 verification + 1 mechanical-migration (+ 1 lint-triage that stalled; redone orchestrator-direct) |
| **Items closed** | `#88` |
| **Items modified** | filed `#188` (oxlint warning burndown) |
| **Tests added** | — (toolchain change; no behaviour change) |
| **Files touched** | ~850 (mostly the `oxfmt --write` reformat sweep) |

**Summary:** Replaced Biome with the OXC toolchain (`oxlint` for linting, `oxfmt` for formatting) per #88. Removed `biome.json` + the `@biomejs/biome` dep; added `.oxlintrc.json` / `.oxfmtrc.json` and `oxlint`/`oxfmt` devDeps; migrated 329 `biome-ignore` directives to `oxlint-disable-next-line` via a one-shot codemod (then deleted it); ran `oxfmt --write` across the tree; rewired the `prek.toml` lint/format hooks, `dependabot.yml` group, and the active-toolchain prose in 9 docs/config files. To preserve lint-policy parity (Biome was not erroring on these), 17 oxlint rules with pre-existing violations were set to `warn` rather than `error`; #188 tracks ratcheting them back.

**Files touched (this session):** highlights —
- `biome.json` (deleted), `package.json` / `package-lock.json` (deps + scripts), `.oxlintrc.json` + `.oxfmtrc.json` (new)
- `prek.toml` (biome-check hook → oxlint + oxfmt hooks)
- `.github/dependabot.yml`, `.github/workflows/codeql.yml`, `AGENTS.md`, `CONTRIBUTING.md`, `.editorconfig`, `docs/architecture/{ci-and-tooling,tooling}.md`, `docs/BUILD.md`, `README.md`, `.claude/hooks/session-start.sh`
- ~806 `src/**` files reformatted by `oxfmt --write`; 329 directive rewrites; 2 codemod-edge-case repairs (`AgendaFilterBuilder.tsx` multi-line JSX comment, `App.tsx` directive prefix) + `scripts/bump-version.sh` biome→oxfmt call

**Verification:**
- `npx oxlint` — exit 0 (260 former errors now warnings; 0 errors).
- `npx oxfmt --check .` — exit 0 (markdown excluded from format scope to avoid an OOM on the 3 MB session-log archive).
- `npx vitest run` — 10921 passed, 0 failed.
- `tsc --noEmit` — 0 errors.
- pre-commit + pre-push hooks — frontend checks pass; Rust hooks skip (no Rust touched).

**Process notes:** The `oxfmt --check .` invocation OOM'd on the 3 MB markdown session-log archive until `**/*.md` + `docs/**` were added to `.oxfmtrc.json` ignorePatterns. The lint-triage subagent stalled (watchdog 600 s) trying to enumerate rule identifiers from a large oxlint run; redone orchestrator-direct using `oxlint --format=json` aggregation. ~33 inline code comments across 25 src files still say "biome" in prose (non-functional) — left for a follow-up sweep, not worth bloating the migration diff.

**Lessons learned:** `oxfmt` walks everything under `.` by default — exclude large generated/markdown trees explicitly or it OOMs. `oxlint --format=json` is the reliable way to enumerate rule×severity; the default text format does not repeat the rule token uniformly, so grep-counting undercounts.

**Commit plan:** single commit / pushed.
