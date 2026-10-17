# Session 2302 — Edit as Markdown gets Edit / Preview / Changes

#5685: Edit as Markdown saved with no way to see the rendered result or what
changed. The maintainer chose a three-way switch, a word-highlighted line
diff, and a Save that counts the changes and is disabled when nothing
changed.

**Diff.** jsdiff (`diff@^8.0.4`) was already in the lockfile as a dev-only
transitive dependency. Making it direct changes two lines and fetches
nothing. It caps the work on big rewrites (past 2,000 changed lines, a page
becomes one hunk; past 200 changed words, a line is marked whole), ships its
own types and splits words Unicode-aware. A hand-written LCS would have
needed its own handling of CRLF, long pages and word boundaries.

**UI.**
- **The switch** is the existing `ToggleGroup`. Going back to Edit returns
  the caret to the editor, which stays mounted.
- **Changes** (`line-diff.ts`, `PageSourceChanges.tsx`) shows removed then
  added lines. `−`/`+` gutters and hidden "Removed:"/"Added:" labels mean
  colour is never the only cue. Changed words are struck through or
  underlined, with three lines of context and longer runs folded. Word diffs
  run only while Changes is open.
- **Save** reads "Save (N changes)", N being the change runs, and is disabled
  at zero. The count needs the line diff on every edit, so that diff is
  memoised and deferred rather than lazy.
- **On phones,** Save and Cancel move under the view in Preview and Changes.

**Preview gap.** Preview (loaded on demand) reuses `renderRichContent`,
`PropertyChip`, `TaskCheckbox` and `ListMarker` through the frontend's block
reader, so `[[Name]]` and `#tag` render as chips, including names the save
would create. It is not the backend's save parser: a heading typed without a
bullet does not nest what follows it, and aliases and refused property values
are not checked. Exact parity needs a backend dry run of the save, which
stays open on #5685.

**Tests.** Seventeen mutations, each killed by the predicted assertion. Two
that first survived (the edit cap, and Save disabled on the phone toolbar)
got stronger tests. Tests and helpers that matched Save by exact name,
including the real-backend `pageSourceButton` helper, now match by pattern.

Gates: vitest (32 files, 1,092), `npm run typecheck`, oxlint, oxfmt,
`npm run build` with the bundle budget (jsdiff adds about 2.5 KB gzip to the
lazy page-editor chunk; Preview is its own 1.9 KB chunk), and the
page-source-edit and checkbox-typing Playwright specs (69/69,
`--repeat-each=3 --retries=0`).
