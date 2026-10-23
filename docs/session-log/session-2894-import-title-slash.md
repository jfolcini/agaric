# Session 2894 — a / in an Evernote, Joplin or Org title stays one page

#6032 item: a `/` in an Evernote or Joplin note title silently became a namespace level, so "TCP/IP" became page "IP" under "TCP". **Maintainer decision (2026-10-23): escape the `/` on import.**

**The app has no escape syntax for a title.** `/` is the namespace separator everywhere: `page-display.ts` splits on it, the export makes folders from it, and the backend's `folder_path_to_namespace_title` splits an import path on it after reading `\` as `/`. Teaching every splitter an escape was not wanted. So the importers swap the character for a look-alike that is not a separator: `/` becomes U+2215 (`∕`), and `\` becomes U+29F5 (`⧵`).

**Changes:**
- `sanitizeNoteTitleToFilename` escapes. It serves Evernote file names and the Org `#+TITLE` retitle, both titles that come from file content.
- Joplin escapes each notebook name and the note title separately, then joins them with a real `/`. The notebook chain still builds the namespace; a `/` inside one name no longer does.
- Joplin note links come from the same title, so `[label](:/id)` resolves to the escaped page.
- Left as they are:
  - Notion titles and plain folders, whose `/` comes from real folder paths;
  - the bibliography, whose title the backend builds from the citation.

**Round trip:** the export splits a title only on `/`, and neither look-alike is a reserved file-name character. So `TCP∕IP` exports as `TCP∕IP.md` and re-imports as one page.

**Shown red:** each unit test fails with its escape removed:
- the sanitizer, `TCP/IP` and `C:\Temp`;
- the Evernote file name;
- the Org retitle;
- the Joplin notebook name and note title;
- the Joplin link target.

Two real-backend cases in `import-formats.e2e.ts` (an `.enex` and a `.jex`) run first in CI.

**Suites:**
- vitest `src/lib` and `src/components/settings`;
- typecheck, the e2e-tauri typecheck and lint;
- Playwright: the import specs.
