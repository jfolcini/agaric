# Session 4217 — a Logseq `{{query}}` becomes a query block (#6754)

Set out to make a Logseq graph import turn each simple `{{query …}}` into a live query block instead of a line of Lisp, now that `OR` and parentheses between filters exist (#6809).

**Where it lives.** The existing Logseq path in `vault-import.ts` (`mdFilesToUnits`, `load`) calls the new `src/lib/logseq-query.ts` before `graph.rewrite`, so a query kept as written is not touched by the journal-link rewrite. The Rust importer is unchanged: a query block is plain text (`{{query …}}`), and `#name` after a `:` is no tag token there.

**Decisions and traps.**

- The translator builds a search-query AST and writes it with the syntax's own `serialize`, then reads it back with `parse`; text that reads back with an invalid token or a lost filter is no translation. A tag name that opens with `"` is the real case that guard catches.
- Repeated `state:`, `priority:` and `path:` OR inside one AND run, so two such clauses of one Logseq `and` (or one beside an `or` holding one) have no equivalent and are kept. `not` negates only what has a `not-` filter, through De Morgan over `and` and `or`.
- `(page x)` is exact: a glob with no wildcard matches as a substring, so the first character is written as a one-character class (`[i]nbox`).
- `[[x]]` is a filter only when the graph makes `x` a tag (`#x`, `#[[x]]` or a `tags::` item in any file, read once on first need), and it is `under:#x`, not `tag:#x`: `tag:` matches only an attached `block_tags` row, while an import stores an inline `#x` as a reference (`block_tag_refs`), so the first CI run of the real-backend spec found the query empty. `(page-tags x)` stays `tag:#x`, since a `tags::` line does attach. The search cannot hold both in one query, so a mix is kept.
- `(between …)` stays: Logseq reads the journal day, which no filter does.
- A kept query is a fenced `logseq-query` code block opening with `Logseq query, not translated:`, since the editor does not show a fence's info string. One warning counts them, through `finalWarnings` and a counter `mdFilesToUnits` fills.

**Shipped.** The translator, its table test (each supported and unsupported form, each shown red by a mutation), an import test through `mdFilesToUnits`, `e2e-tauri/import-logseq-query.e2e.ts`, and the docs and Logseq comparison rows. Ran: targeted vitest, `npm run typecheck`, oxlint and oxfmt. Not run locally: the real-backend spec (no app binary here); CI's `e2e-tauri-gate` ran it and found the `tag:` gap above and a second, unrelated warning (`logseq/config.edn` counted as a skipped file), so the spec asserts the query warning among the list, not its count.
