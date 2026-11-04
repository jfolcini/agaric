# Session 3412 — review notes from #6299 and #6307

The non-blocking notes from #6277 G1 (#6299) and G2 (#6307), batched.

- `docs/features/import-export.md` now says a pick of the whole *Export all spaces* ZIP restores no definitions or titles: each space's `.agaric/space.json` sits in that space's folder, and a folder import goes into one space, so it is read only when that folder is picked.
- `dropTitleLine`'s mutation survivor (`-1` → `+1` for "no front matter") is killed by a page with no front matter whose `# Title` line sits at byte 6 (`- abc\n# Six\n\n…`), which must stay as written; the new row went red with the mutant applied.

Kept as is: the reviewer read `dropTitleLine`'s front-matter branch as unreachable, and today it is, since `render_page_markdown` writes `# {title}` before the front matter. #6277 A1, approved, moves front matter to byte 0, and the branch is what keeps the title line dropped then; its three cases stay.

#6299 had no notes beyond its mutation report, whose survivors are all in code `main` brought in (#6286, #6288).

Ran: vitest over `src/lib/__tests__/export-graph.test.ts`.
