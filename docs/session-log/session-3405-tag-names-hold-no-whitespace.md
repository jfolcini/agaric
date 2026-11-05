# Session 3405 — A tag name holds no whitespace (#6278 I4)

Item I4 of #6278. The maintainer decided (2026-11-04) that tag names may no longer contain whitespace, that `#[[…]]` still reads, and that an imported or pasted `#[[multi word]]` naming no tag creates `multi-word` with a warning.

- Explicit name forms refuse a name holding any Unicode whitespace with the new `ValidationCode::TagNameWhitespace` (i18n `tags.nameHasWhitespace`, suggesting `-`): `create_tag_in_space_inner` (after the existing same-name lookup, so a create naming an existing spaced tag still returns it), `edit_block_in_tx` on a tag, TagList create and rename, a tag page's title, MCP `create_tag`.
- Text that reads `#[[multi word]]` resolves an existing tag of that name, else the dashed name: import, paste, Edit as Markdown, front-matter `tags:` (ENEX, Joplin, Logseq `tags::`), MCP markdown tools, the typed input rule, the `#`/`@` picker Create, the typed-left-as-text commit and the page header's tag picker. Import and paste warn; typing shows the dashed chip instead.
- Orchestrator decision: typing reads `#[[…]]` as paste does, so one reading holds everywhere. The reviewer moved the page header tag picker from refusing to offering the dashed name, since refusing closed the picker and dropped the query.
- Undo, restore, sync and op-apply stay unchecked: an existing spaced tag keeps working and exports as `#[[name]]` until renamed. No migration.
- Existing tests changed only where the decision forces them: the two `hash-tag-typing` specs and `unmount-flush` expect `multi-word`/`deep-work`; four `page_cmd_tests` imports expect the dashed tag or seed a legacy spaced tag; `validation-codes.test.ts` gains the code.
- The mock refuses and dashes the same way, pinned by `tag_name_without_whitespace` and a mock vitest; Rust `char::is_whitespace` and JS `\p{White_Space}` were compared over all code points and agree.

Suites run: full `cargo nextest run --workspace`, `conformance_fuzz`, clippy, `SQLX_OFFLINE` check, full vitest, typecheck, lint, `prek` (all and manual stage), Playwright tag/picker/paste/import specs; after merging main, the commands and MCP suites and the touched vitest dirs.
