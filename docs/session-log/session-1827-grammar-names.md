# Session 1827 — grammar, phase 3a: how `#tags` and `[[names]]` resolve

Phase 3a of #5160 (N1, N3, N4, N8, N10, D10, D12). The backend, the mock and the editor's `[[` picker each resolved names their own way. Paste, import and Source minted tags from `#42`, from URL fragments and from `&#39;`. An escaped `\#tag` still became a tag. `[[project plan]]` beside "Project Plan" created a twin. A vault import made two pages for any two notes that linked each other.

**The change.**
- **No junk tags.** `#42`, a `#` in a bare URL or a link destination, `&#39;` and `[#A]` stay text on every surface, and the URL is left byte for byte. A tag name needs a non-digit; `&` and `[` are no longer boundaries.
- **Escapes.** An odd run of backslashes before `#` or `[[` makes it text; an even run is literal backslashes followed by the token.
- **One resolution rule.** `[[name]]` resolves to the exact title, else a unique case-insensitive title, else a unique alias, else a new page. A tie is never guessed: the text stays and the existing "matches multiple pages" warning names it. The backend (two batched `json_each` queries), the mock and the `[[` picker share the rule, and the picker compares the full title, not the namespace leaf.
- **Vault import adopts an empty page.** A unique same-title page in the space with no blocks, such as one a link created, takes the file's blocks, in either file order. A page with content is left alone: the file becomes a new page, with a warning.
- **`#` inside a link.** `[[C# Notes]]` resolves to that title first, whether it exists or the same import creates it.
- **Export writes names that read back.** Export writes `#[[name]]` when the bare form would read back as a different tag or as text: `#C++`, `#v1.2`, `#Q&A`, `#42`, and a tag next to `[` or a letter.
- **Relative `.md` links.** On a folder import, `[text](Other%20note.md)` becomes a link to the page that file imports as.

**Decisions.**
- Case-insensitive means ASCII (SQLite NOCASE), the same fold the alias index and the mock use. Tags keep their full Unicode fold.
- The relative-link rewrite drops the link text (`[see here](Other.md)` → `[[Other]]`); 3b's stored labels are where it belongs.
- Not built: a cross-page `[[A#Heading]]` or `[[Page#^id]]` linking a block. The fallback is today's page link with the "anchors dropped" warning. It moves to 3b.

**Review.** An independent reviewer ran the full suite and probed URLs and escapes through repeated saves, the batched queries, adoption's edges, the export round trips, mock parity and the `.sqlx` cache.
- **A defect, fixed:** export judged a tag in isolation. With `[` and `&` no longer boundaries, a tag written next to `[` or a letter (`[#work]`, `#works`, two tags touching) came back as text or as a different tag after Export → Import. Export now brackets a tag whose neighbours would swallow it. A unit test and the real export → import test failed before the fix.
- **A defect, fixed:** a typed `[[FOO]]` that tied two pages by case lost its brackets. It now goes back exactly as typed.
- A Playwright spec still expected the mock's old import warning.

**Verified.**
- Every fix's test failed before its change, and each was broken again on a copy and restored with `cmp`.
- `cargo nextest run --workspace` passes 6554 tests.
- Doc-tests: 10 passed.
- clippy and fmt are clean.
- The root `.sqlx` check passes; the other three crates changed no queries.
- vitest: 19340 passed across all files.
- `typecheck`, `typecheck:e2e` and `typecheck:e2e-tauri` are clean.
- 157 Playwright tests pass across the paste, import/export, link, tag, picker and Source specs.
- `e2e-tauri/import-vault-adopts-link-target.e2e.ts` imports two linked files, in both orders, against the real backend. CI runs it.
