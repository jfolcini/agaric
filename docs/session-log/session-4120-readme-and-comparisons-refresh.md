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
- The second commit's message says the README "described a transport" the app no longer has. It did not: its sync section already named QUIC and iroh. What was wrong is listed in the PR body.
- `docs/features/views.md` still described the Agent access tab as two switches; it has one, plus the agents.

## After the maintainer read the first version

- **The timing claim went back into the README**, tied to its source. The first version removed "sub-millisecond operations" as unbacked; the maintainer pointed at the weekly SLO runs. The README now names `src-tauri/benches/interactive_slo.rs`, `FIXTURE_SIZE` and the `BUDGET_MS` constants, whose point-read budgets are what the old phrase meant.
- **The detailed matrices came back, as their own files.** `COMPARISON-LOGSEQ-MATRIX.md` and `COMPARISON-OBSIDIAN-MATRIX.md` hold the row-by-row tables of the old comparisons; the two summary pages link them. Four agents re-checked every Agaric cell against the code, and their corrections were applied by section and capability name with a small script, so a cell that had moved could not be edited by accident. Counts in cells were replaced by the constant that holds them. Scorecards, project-health figures and the corrections logs stayed out.
- **What the row audit found that the first pass had missed:** `/template` now inserts in one transaction and copies properties; the journal date format is under Settings → General; the window title carries the space's name, not a prefix; boot recovery is not four steps; the sync key file is hex, not raw bytes; the search floor drops a two-character CJK word, which the old "CJK search: Better" row hid.
- **"Formulas" was read as mathematics.** The summaries said Agaric has "no formulas" beside Obsidian's Bases; they now say "computed columns".
- **Issues.** The open issues that bear on the comparisons each gained an "Impact on the comparisons" section and had stale statements corrected (#6519, #6540, #6542, #6546, #6550, #6552, #6555, #6660, #6536, #6224, #6079; #79 by comment). The maintainer was asked about each gap with no issue, one at a time, and these were filed: #6736, #6737, #6739 to #6747, #6749 to #6753. The glibc floor was skipped: the README's stated floor is the decision.

## Shipped

`README.md`, `COMPARISON-LOGSEQ.md` (renamed), `COMPARISON-OBSIDIAN.md`, the two matrix files, the references to the old name (`scripts/check-doc-code-paths.mjs`, `_typos.toml`), and one sentence each of `docs/ARCHITECTURE.md` and `docs/features/views.md`.

## What ran

`prek run` over the changed files, `prek run --hook-stage manual` over them, and `node scripts/check-doc-code-paths.mjs`. No test suite: the range holds no code. The same again after the matrices were restored, plus `lychee` over the changed Markdown.
