# Session 3338 — the ZIP carries what a file cannot

#6277 G2 (decision 8). A restore of the ZIP export stored every number, date, select and ref property value as text, because the space's property definitions never left the database; titled `a:b` as `a_b`, because `titleToZipPath` sanitises a segment and nothing recorded the original, while its links still said `[[a:b]]`; and imported `export-report.txt` as a page, `.txt` being a note extension.

The export now writes `.agaric/space.json`: the space's non-built-in definitions (all pages of `list_property_defs`) and the title of each file whose path does not read back as that title (`pathTitle`, the TS twin of `folder_path_to_namespace_title`), when some path does: the import titles a page only from a path, so `a\b` or `Q1 / Q2` keeps its sanitised name rather than coming back as another namespace. It is written only when it has content; "Export all spaces" writes one per space folder. The report moves to `.agaric/export-report.txt`, and each file drops its leading `# Title` line (only at byte 0 or right after closing front matter, so A1's reordering keeps working). A folder import reads `.agaric/space.json` first, creates the definitions the space lacks before any page imports, titles the recorded files from it, and makes no page of a file under `.agaric/`; a note under any other dot-named folder still imports, since the export files a `.NET` page as `.NET.md`.

`listAllPropertyDefs` moved unchanged from `src/stores/inline-property-commit.ts` to `src/lib/property-save-utils.ts`, since `src/lib` may not import from stores.

Expectations changed by the decision: the report path in `export-graph.test.ts` and `e2e-tauri/export-roundtrip.e2e.ts` (whose absence check would otherwise pass vacuously), one exact ZIP listing that now includes `.agaric/`, and `e2e/import-export.spec.ts`'s title-line check.

Every new vitest case went red before the fix and against a one-line mutation of the line it covers. `e2e-tauri/import-export-folder.e2e.ts` gains a number property and an `a:b` page: after the restore the definition is `number` in Work, the page holds 42 as a number, `a:b` keeps its title and no `export-report` page exists.

Review found the first cut skipping every dot-named folder, which dropped a restored `.NET` page without a warning; it now skips `.agaric/` only.

Ran: vitest over `src/lib` and `src/components/settings` plus the store, hook and filter suites; `npm run typecheck` and `typecheck:e2e-tauri`; oxlint and oxfmt on touched files; the 14 Playwright specs `just e2e-related` picks; `just e2e-real` on `import-export-folder` and `export-roundtrip`, and `import-export-folder` red with the space file's restore cut out.
