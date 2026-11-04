# Session 3296 — Evernote tasks and reminders import as tasks

#6032 batch C, built by the orchestrator session and handed over for review and
merge. An Evernote 10 `<task>` was lost on import and its group's
"Content not supported" placeholder came in as prose; an old-style note
reminder was dropped. Both now import as task blocks, as the maintainer decided
on 2026-11-04: `- [ ]` or `- [x]`, `dueDate` as `due_date::`, the first
`<reminder>`'s date as `scheduled_date::`, each in the task's own zone (else
the local day). A group's tasks take its placeholder's place in `sortWeight`
order; a note reminder becomes a leading task named after the note. The flag
and recurrence are dropped and documented. Note-level fields are read as direct
children only, so a note without `<created>` no longer reads a task's.

The shared HTML converter (ENEX bodies and Joplin HTML notes) now writes `<hr>`
as `---`, which the importer reads as a break (Turndown's `* * *` read as a
list item), and strike as `~~x~~` (gfm's single tilde displayed literally).
`todoBlock` and `localDate` moved to `enex-import.ts` for both formats.

Review fixed a reminder with no zone of its own falling back to the local day
instead of the task's zone, and added the cases mutation showed open: two task
groups in one note, and a reminder with a time or done time but no order.

Ran: full vitest, typecheck, lint, manual-stage prek, the 14 Playwright specs
`just e2e-related` selects, Stryker on the changed lines (the survivors left
are equivalent). The new e2e-tauri case runs in CI only.
