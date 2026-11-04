# Session 3310 — a folder note's link to any note file is a page link

#6032 batch B. On a folder import, a note's Markdown link to a sibling note
became a `[[title]]` link only when the destination ended in `.md`. A link to
a `.txt`, `.markdown`, `.mdx` or `.org` note (all imported as notes since
#6078), an anchored link (`Other.md#Heading`, `Other.md#^id`, what Obsidian
writes with Wikilinks off) and a CommonMark `<Other note.md>` or titled
destination all stayed dead links with no warning.

`rewrite_relative_md_links` now reads tokens through the engine's own link
reader (`markdown_link_tokens`, shared with `detect_attachment_refs`), so the
page-link and attachment passes read `<…>` and titled destinations alike. The
fragment is split off the raw destination before percent-decoding, so
`C%23%20Notes.md` is the page `C# Notes`. The anchor is kept and
`link_import_anchors` resolves it across the folder, as for `[[Note#Heading]]`.
An escaped `\[x](O.md)` is now left as text, as the wiki-link pass already did.

Trap the reviewer caught: once `.org` is a note extension,
`[mail](mailto:jane@example.org)` read as a page link. The scheme check now
reuses the engine's `URL_SCHEME_RE`, the rule attachments use.

Caveat, documented: a link to an `.org` file names the page by its file name,
so a file whose `#+TITLE` differs is missed, as for Org-to-Org links. The docs
also now say setext headings and TOML or JSON front matter import as text.

Ran: nextest over `agaric-engine --lib` and the `import` and `markdown` filters
of the app crate, clippy `--workspace --all-targets`, `SQLX_OFFLINE` check,
`prek run --hook-stage manual --all-files`, lint. The new e2e-tauri case runs
in CI only (no tauri-driver in the container).
