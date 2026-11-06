# Session 3638 — a folder import ships the note a table cell's link names

A folder pick sends each note the paths of the notes its `[[Name]]` links may name (`linkedNotePaths`, #5740), so the backend can resolve them. `WIKILINK_NAME_RE` (`vault-import.ts`) ended a name only at a bare `|`, so a table cell's `[[Note\|alias]]`, the form Obsidian requires there, read as `Note\`, matched no note and shipped nothing: the backend, which #6418 taught to read `\|`, then had no vault note to resolve the link to. The name now also ends before `\|`; a backslash anywhere else in a name is kept.

- Ran: the new `mdFilesToUnits` case, shown red with the old regex; vitest over `src/lib` and `src/components/settings`; typecheck; oxlint; oxfmt; `e2e/import-export.spec.ts`.
