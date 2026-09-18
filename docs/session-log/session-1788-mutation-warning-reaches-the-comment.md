# Session 1788 — the warning reaches the sticky comment, and a correction

Three follow-ups batched off the #5098 / #5100 / #5101 sweep, plus a correction
to something this session's earlier work asserted and got wrong.

## The correction, first

#5101's PR body and session 1783 both say the auto-filed frontend survivor
issues hold findings that "were never alive". **That is wrong**, and the dates
say so: vitest went to 5 on **2026-09-16** (#5047), while the tracked findings
are dated **2026-09-07** (jex-import) and **2026-09-14** (vault-import), and
#4691 was last written by the run of 2026-09-14. The lane runs Mondays
(`17 4 * * 1`), so it has not run since the runner broke. Every mutant listed in
#4691, #4816 and #3766 was found by a working runner and is genuine.

What follows from that is the opposite of what was proposed. Closing those
issues would discard real triage — 58 survivors, 7 no-coverage, and a
hand-curated 142-entry accepted-equivalent block — and would not stick anyway:
`file-mutation-survivors.mjs` reopens a closed tracking issue rather than
duplicating it, and its finder prefers an open match to a closed one.

The exposure is the *next* run, which will be the first to write phantom data
over those lists. That is a live decision with a date on it, not something to
settle in a log.

## The sticky comment

`mutation-pr.yml` posts survivor lists on a contributor's own PR, and no page a
contributor might not open could reach them. `render-mutation-summary.mjs` now
emits the #5101 banner directly under its title, so it heads the comment before
the table. The same script also feeds `scheduled-deep-checks.yml`'s job summary
(`--reports-dir reports/mutation >> $GITHUB_STEP_SUMMARY`), so one banner covers
both surfaces. It is one constant with a delete-me pointer to `docs/BUILD.md`.

## Two citations and a paragraph

`blocks-cursor-strictness.test.ts` carried the same wrong citation #5105 fixed in
`handlers/blocks.ts`: `pagination/agenda.rs:100` is `source: Option<&str>` in
`list_agenda_range`'s signature, not the `c.deleted_at.as_deref().unwrap_or("")`
bind the sentence describes, which is at :110. The `doc-vs-code-paths` hook
validates the path and never the line, so repo-rooting alone would have left it
silently wrong — which is exactly what happened on #5105's first attempt. Its
baseline entry is pruned by hand; running `--update-baseline` rewrites six
unrelated entries' escapes as literal em-dashes.

`decodeBlocksCursor`'s doc block spent fourteen lines re-deriving per-branch
cursor reachability for a six-line change. That derivation belongs in session
1785, where it was proved. Two sentences remain: the sentinel matches the
grouped-backlink reader, the only branch either stack mints a slotless cursor
from; the other three refuse such a cursor or never mint one.

## Verified

`npx vitest run src/__tests__/check-mutation-reports.test.ts
src/lib/tauri-mock/__tests__/` — 50 files, 975 passed. `npm run typecheck`
clean. The renderer was run as a CLI and through its export; the banner appears
under the title in both. No line over 100 columns was introduced — the four that
exist in these two files all predate this change.

Nothing here changes behaviour a test can pin: two comments, one constant in a
report renderer, one baseline entry. The renderer's output was checked by
running it rather than by reading it.
