# Session 3572 — Org file links name the page by its #+TITLE

Item 1 of what was left in #6032. On a folder import, an Org `[[file:other.org][desc]]` link to an Org file of the pick whose `#+TITLE` differs from its file name linked (and created) a page named after the file, while the file imported under its `#+TITLE`.

- The fix is frontend-only, so no new IPC field and no edit to the shared `markdown.rs`. `mdFilesToUnits` already reads every Org file of the pick once for the `id:` map. That pass now also records each Org file's page title by its vault path. `orgLinks` resolves a `file:` link from the linking file's folder and writes `[[Title|desc]]`, the form a file-level `id:` link already takes.
- `OrgIdTargets` became `OrgLinkTargets` (`ids` plus a `fileTitle` resolver), so org-import does no path resolution itself.
- Not changed: a Markdown note's `[x](other.org)` link still names the page by file name (documented). A plain multi-file pick, which has no folder paths, is also unchanged.
- Ran: `vault-import.test.ts` (the new case shown red, then two mutations each red on its assertion), the full vitest suite, `npm run typecheck`, oxlint and oxfmt. The new e2e-tauri `it` in `import-notion-org.e2e.ts` was not run locally (it needs a native build); CI's real-backend lane runs it.
