# Session 3595 — Evernote links between notes become page links

#6032 Q8, decided by the maintainer on 2026-11-05: in an ENEX import, an `evernote:///view/…` link whose text is the title of a note in the same file links that note's page. Any other stays an Evernote link, and one import warning counts them all.

- An ENEX note imports as `<file stem>/<title>`, so the link has to name that page. A bare `[[Title]]` would make a new top-level `Title` page. The rewrite writes `[[Work/Meeting|Meeting]]`, the form the Joplin importer writes. `enexPageName` is now the one place both the unit name and the link target come from.
- Titles match as page names do (`nameKey`: trimmed, case-insensitive, NFC). A Turndown rule added per file in `parseEnex` does the rewrite. `countEvernoteNoteLinks` counts the links that are left, and `ImportSection` adds one `data.importEnexNoteLinks` warning across every picked file.
- Frontend only: no Rust change.
- Ran: vitest over the ENEX, JEX, vault-import and DataTab tests, `npm run typecheck`, `npm run lint`, and Playwright `import-export.spec.ts` "Evernote links between notes". Reds seen: the rule's filter turned off (link and count cases plus the DataTab warning), every Evernote link linked (the keep and other-file cases), one warning per link (the DataTab heading), and a bare `[[Title]]` (the e2e chip title, `Meeting` for `Work/Meeting`).
