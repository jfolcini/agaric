# Session 3265 — the PR mutation lane reads mutation-accepted.tsv

The diff-scoped mutation comment (`mutation-pr.yml`) listed every survivor
Stryker reported, including mutants already proven equivalent in
`mutation-accepted.tsv`. Only the weekly filer subtracted that file. So a PR
touching `vault-import` (#6267) re-reported, as a test gap, the null guard the
same PR had just recorded as unkillable. The maintainer asked for the PR lane
to read the file.

`render-mutation-summary.mjs`, which renders both the PR comment and the weekly
step summary, now leaves an accepted mutant (survivor or no-coverage) out of
the counts, the covered score and the survivor list, and says how many it
left out. An unreadable file subtracts nothing and says so: the renderer
must never fail, and the weekly filer already fails its lane on a bad entry.
The fingerprint and the parser moved unchanged into
`scripts/lib/mutation-accepted.mjs`. The renderer could not import the filer,
whose top-level area derivation globs the whole Rust workspace at load.

`scripts/render-mutation-summary.test.mjs` is new and runs in `lint`'s
`node --test` list. Its first and third tests went red against the old
renderer, and the first went red again with only survivors subtracted. Rendering the
page-lists builder's real scoped report with its TSV left out all 6 recorded
survivors.

The entry-point guard's self-test runs a copy of the filer from a path
with a space in it. It now copies `lib/mutation-accepted.mjs` beside the
filer, because the copy could not load without it. That hook's `files`
pattern now includes the module too.

Ran: `node --test scripts/render-mutation-summary.test.mjs`,
`prek run --hook-stage manual --all-files`,
`node scripts/file-mutation-survivors.mjs --self-test`, oxlint and oxfmt on
the scripts.
