# Session 3315 — Evernote tags are page tags, and a note sits under its file name

#6032 items N3 and N10, decided by the maintainer on 2026-11-04. An ENEX note
wrote its tags as a body line of `#tag` tokens, so they tagged one tags-only
block, not the page: tag filters found the note through that block and tag
inheritance never reached its tasks. They are now front matter `tags:`, the YAML
sequence `jexNoteToMarkdown` writes, which the backend reads item by item as
page tags, so `C++`, `Q&A`, `v1.2` and `2024` stay whole and the `#[[…]]`
bracketing rule is gone with the token line.

An ENEX file carries no notebook, so two files' "Meeting" notes imported as
`Meeting` and a duplicate. A note is now titled `<file stem>/<title>`, as a
Joplin note is by its notebook path; the stem gets the same look-alike escaping
a title does, and `.ENEX` in any case is stripped.

Existing tests that pinned the old shape moved with the decision, expected
values only: the ENEX tag and reminder outputs, `enexNotesToUnits`'s names, the
DataTab filenames, and the three e2e-tauri ENEX cases' titles (`export/…`). The
`#[[…]]` bracketing test was deleted with its rule.

Ran: full vitest, typecheck (app and e2e-tauri), lint, manual-stage prek, the
44 Playwright specs `just e2e-related` selects. The e2e-tauri cases run in CI.
