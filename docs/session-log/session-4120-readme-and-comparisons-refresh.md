# Session 4120 — the README and the two comparisons, rewritten against the code

The maintainer asked whether the README still reflects the app, and for it and the Logseq and Obsidian comparisons to be updated, the Logseq one renamed. The session audited the three files against `origin/main`, rewrote them, and renamed `COMPARISON.md` to `COMPARISON-LOGSEQ.md`.

## Decisions and traps

- **The comparisons were rewritten, not patched.** Both were dated audits with scorecards, star and download counts, PR numbers and a corrections log, which is what `AGENTS.md` § How we work asks to delete. Each is now one dated page: the differences that decide the choice, a feature table, where each tool is better, and what an import keeps. The old text is in git history.
- **Agaric claims were checked in code or a release artifact.** The Linux baseline came from the highest glibc symbol in the released `.deb`'s binary and the release runner, the `agaric-mcp` paths from listing the `.deb` and the macOS `.app.tar.gz`, the Windows data folder from `app_data_dir()` (roaming, as `docs/TROUBLESHOOTING.md` already said). The Windows stub path was not verified, so the README names no path for it.
- **Competitor claims were checked against their own documentation** by two research agents, each returning a URL and a quote per claim. What they could not confirm is left out and listed at the foot of each comparison: Logseq's CJK search, the platforms of its semantic search, whether its Markdown projection is in a release; whether Obsidian plugins run on mobile and whether its search indexes attachments.
- **Recently merged features changed several old rows**: query blocks take the search syntax, saved views sync, the History view badges agent edits, there is a board, a custom stylesheet, a daily snapshot and right-to-left paragraphs. The old comparisons disagreed with each other on the first.
- **`README.md#install` and `README.md#using-agaric-with-mcp-clients` are linked** from `docs/BUILD.md` and `docs/features/agent-access.md`, so both headings kept their names.
- **Merged session logs still say `COMPARISON.md`.** They are immutable and name it in prose, not as a link, so nothing breaks.
- `docs/ARCHITECTURE.md` principle 2 still called the op log "the truth"; it now states the three layers as `AGENTS.md` invariant 2 does.
- Not fixed, reported in the PR: `packaging/flathub/README.md` and the MetaInfo draft list a Google Calendar push that migration 0091 removed.

## Shipped

`README.md`, `COMPARISON-LOGSEQ.md` (renamed), `COMPARISON-OBSIDIAN.md`, the two references to the old name (`scripts/check-doc-code-paths.mjs`, `_typos.toml`), and one sentence of `docs/ARCHITECTURE.md`.

## What ran

`prek run` over the changed files, `prek run --hook-stage manual` over them, and `node scripts/check-doc-code-paths.mjs`. No test suite: the range holds no code.
