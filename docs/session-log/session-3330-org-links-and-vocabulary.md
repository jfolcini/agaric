# Session 3330 — Org heading and id links, and Org's per-file vocabulary

#6032 items N4 and N7, decided by the maintainer on 2026-11-04.

N4: an Org link to a heading or id with no description (`[[*Budget]]`,
`[[id:…]]`) reached the backend as a wiki-link and created junk pages. A
`*heading` or `#custom-id` link, and an `id:` link that resolves nowhere, are
now escaped with `\` so they stay text (the editor shows them as written, and
an edited block re-saves them as escaped text). An `id:` link resolves through
a new pick-wide id map built in `vault-import.ts`: a headline whose `:ID:` is a
uuid (the id the backend keeps as the block's anchor) becomes `((U))`, its
description dropped since a block ref carries none; a file-level `:ID:` becomes
`[[<folder>/<Title>|d]]`, the title the page imports as.

N7: `#+TODO`, `#+SEQ_TODO` and `#+TYP_TODO` declare keywords. A keyword the
backend already reads (`TASK_KEYWORDS` in the engine's `import.rs`: `NOW` is
DOING, `CANCEL` is CANCELLED…) keeps that mapping; any other keyword is TODO
before the `|` and DONE after it (the last keyword is done when there is no
`|`). The importer's copy of that keyword list names its Rust source. The
first review pass caught the builder mapping a declared `NOW` to TODO, which
the backend reads as DOING. `#+FILETAGS` becomes a leading `tags::` line (page
tags); headline `:a:b:` tags become `#[[a]] #[[b]]`, the tag class including
`\p{M}` so an NFD `café` stays one tag.

Ran: full vitest, typecheck (app and e2e-tauri), lint, `prek run --all-files`
and the manual stage, the 14 Playwright specs the worktree selects. The new
e2e-tauri case runs in CI.
