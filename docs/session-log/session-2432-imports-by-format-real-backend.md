# Session 2432 — Folder, Evernote and Joplin imports on the real backend

These are #5740's import items, part of the #5726 sweep. They share one
app boot in `e2e-tauri/import-formats.e2e.ts`.

**The three cases:**
- **Folder import.** `note.md` references `pic.png`. After a round-trip,
  the note's page renders that image from the stored bytes.
- **`.enex`.** A one-note export becomes one page holding its body blocks.
- **`.jex`.** An inline tar with a sub-notebook becomes the pages
  `book/top` and `book/sub/deep`, titled by `pageTitleFor`.

**Picking a folder.** WebKitWebDriver can't pick a folder: Send Keys hands
the `webkitdirectory` input the directory itself, as one unreadable File.
So the spec builds the FileList the picker would, with `webkitRelativePath`
set and a `change` event. The desktop app has no native dialog: "Import
folder" clicks that same hidden input. So everything from `onChange` on is
the product path.

**Shown red on the real binary:**
- `rewrite_block_attachment_refs` not rewriting the reference;
- `parseEnex` keeping only the first paragraph;
- `pageTitleFor` dropping the notebook path.

**The Obsidian item found three product bugs, so it ships with their fix
instead:**
- `[[Name]]` between notes of an imported vault resolves to a new empty
  page, not to the vault's namespaced note.
- An imported `#tag` chip shows a raw ULID, because nothing refills the
  resolve store after an import.
- A folder import turns every non-`.md` file into a page. The folder case
  here waits only for "Imported", so it doesn't pin that behaviour.

**Unverified.** WebKitGTK's file-chooser request has no directory flag,
and neither wry nor tauri overrides it on Linux. So "Import folder" on a
Linux desktop may only offer files. This needs a check by hand.

**Ran:**
- the spec on a binary built from main;
- `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, oxlint and
  oxfmt.
