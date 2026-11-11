# Session 3705 — the spoken-text mutants, all equivalent

The second PR of the frontend mutation sweep (#4691), for spoken-text (#6439). On `origin/main`, `node scripts/run-mutation.mjs spoken-text` showed 8 no-coverage mutants and 8 survivors. None can change what Read aloud speaks, so this PR adds no test. It records all sixteen in `mutation-accepted.tsv`, each group under a reason line.

## Why each is equivalent

- **The eight no-coverage mutants.** They are the `?? []` fallbacks on a doc, blockquote, list, list item, table, row and cell. `parse()` always gives those nodes their content, so no input reaches the fallback.
  - The fallbacks cannot be deleted either. Each `content` field is optional in `src/editor/types.ts`, and a non-null assertion is banned.
- **The horizontalRule case emptied.** It falls through to `blockquote`, which turns a node with no content into `[]`, the same as the case.
- **The footnote_ref case emptied or unmatched.** It returns `undefined`, which `join('')` renders as `''`, the same as the case's `''`. Deleting the case is no option: the switch must stay exhaustive.
- **A cell's join separator.** A table cell holds at most one paragraph (`buildTableCell`), so the separator never shows.
- **The inline `?? []` filled with a stand-in.** The stand-in string matches no inline case, so it too joins as `''`.
- **`getPageDisplayName(title, '')`.** An unknown mode gives the same `.label` as `'leaf'`, and only the label is read.

The builder's verdicts were checked against `parser.ts` (`buildTableCell`, `parseDocument`) and `page-display.ts` before they were accepted.

## Also

#6460's reviewer asked for a `# reason` line above each `mutation-accepted.tsv` entry that PR added: inline-property-parse, template-utils (two entries) and read-aloud. They're here, since this PR edits the same file.

## Counts

spoken-text, distinct tracked mutants (no coverage + survived) net of `mutation-accepted.tsv`: 8 + 8 on `origin/main`, 0 on this branch. The source is unchanged, so main's report nets to 0 against this branch's accepted file.

Suites run: `scripts/render-mutation-summary.mjs` and the filer's key matching over main's report, and `prek` on the changed files.
