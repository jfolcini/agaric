# Session 3693 — #6032 import test gaps: Evernote and Joplin payloads, front matter, setext

Set out to close what was left of #6032 section 3: tests that read back what an import stores for TOML and JSON front matter, setext headings, and the Markdown the Evernote and Joplin converters hand the backend. Earlier passes had covered the rest; the JEX `./`-prefixed tar member was dropped, since nothing shows Joplin writes one.

The Evernote probe found a real loss. Turndown pads a list marker to four columns (`-   one`, `1.  first`), and the importer keeps spacing past a marker's one space as text (the "keep what was typed" decision in #5160), so every Evernote list item, and every list item in a Joplin rich-text note, was stored with two or three leading spaces. `createMarkdownTurndown` now writes one space after the marker, nested items indented by the marker's width. Paste walks lists itself and does not use this rule.

The new Rust tests feed the backend exactly what `enexNoteToMarkdown` and `jexNoteToMarkdown` write. They pin the shared-grammar cross-effects as they are today: a `TODO` line stays text, `#word` is a tag, `[[x]]` makes a page, and a `key:: value` paragraph becomes a property of the block above it. `docs/features/import-export.md` now says that TOML/JSON front matter and setext headings are not read. #6383's description claimed that sentence was already there; it was there only for TOML and JSON, in `docs/architecture/editor-and-content.md`.

Ran: vitest over `src/lib`, `src/editor` and `src/components/settings`; the new Rust tests, each falsified by an engine mutation (a `+++` front-matter gate, `=` and no `-` as a thematic break, no space stripped after a marker); the new e2e-tauri case, red with the Turndown rule removed.
