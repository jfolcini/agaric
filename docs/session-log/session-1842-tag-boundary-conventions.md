# Session 1842 — follow-up 7a: the tag boundary follows Obsidian and Logseq; a typed `#name` is a tag on save (#5160)

The review notes on #5205 (session 1835): 99, 98 and 100. Note 101 (a typed tag inside an open `((`) is let go.

**What decides a tag.**
- **Obsidian** needs whitespace or a line start before `#`.
  - Silver (co-founder) on the forum, Jan 2021: "Hashtags require space or beginning of line right before it" (forum.obsidian.md/t/3046).
  - `(#tag)` stays text. It was reported in 2020 (/t/930), 2021 (/t/18424) and again in Aug 2025 (/t/104783), where a moderator acknowledged it and nothing changed.
  - The Obsidian Tasks plugin mirrors it with `(^|\s)#`: "Any # that has a character in front of it will be ignored".
- **Logseq**'s editor opens the `#` popup only at a line start, after a space or tab, or right after `]]` (`start-of-new-word?`, `frontend/handler/editor.cljs`).
  - Its parser, mldoc, is looser. The Angstrom inline parser takes `#` after any character, so `F#m` is a tag, which users report as unwanted (logseq discussion #11560).
  - mldoc's newer Markdown fast path needs whitespace, a line start, or one of `, ; . ! ? ' " :` before `#`.
- **Decided:** a tag starts the text or follows whitespace (Unicode `White_Space`). Both tools agree on that. Obsidian holds to it strictly and Logseq's editor does too.

**What changed.**
- **The tag boundary is whitespace (note 99).**
  - Before, anything but a letter, digit, mark, `_`, `&`, `[` or `/` began a tag, so `(#tag)`, `"#tag`, `,#tag` and `😀#tag` were tags.
  - Rust `HUMAN_TAG_RE` and TS `BARE_TAG_RE` now take `(^|\p{White_Space})` before the `#`. That is the same set in both languages, where `\s` is not.
  - Two new vector rows pin it: punctuation and an emoji are no boundary; a tab, a no-break space and an ideographic space are.
  - The escape check on a bare tag is gone on both sides, because a backslash is no boundary and the check could never fire. The even-backslash row now uses `\\#[[tag]]`, where the escape still decides. The double-backtick fence row gains spaces, so it still pins how backticks pair.
- **The `#` picker opens exactly where the tag rule allows.** Before, it used the `@` picker's prefix list. Now it opens after a tab or an ideographic space too, and not after `(`.
- **Export brackets any tag after something other than whitespace**, e.g. `(#[[work]])` and `**#[[work]]**`. `tag_reads_back_bare` already asks the regex, so this needed no code.
- **The mock follows** through `scanNameTokens`. The re-authored conformance fixtures changed only in formatting, so none is committed.
- **A `#name` that is still text when the block is saved becomes the tag (note 98).**
  - Before, `#project` was saved as text by Enter or a click-away after Escape, after moving the caret away, or after typing `#` before a word. Import, paste and Source read it as a tag.
  - The flush chain has a new branch after split, checkbox and properties:
    - The text is saved first, the same plain edit with the same dedupe and `flushSync`.
    - Each name is then looked up in the active space (any case) or created there.
    - A second edit writes `#[ULID]`, unless a newer save of the block has started.
  - Content holding a code block is never read for tags.
  - The debounced mid-typing commit waits for the flush, so `#proj` never becomes a tag while it is still being typed.
  - **Why convert on save rather than open the picker:** the picker helps only while the caret sits at the end of the name. Saving covers every way a `#name` reaches storage, which is what the convention means. Logseq also makes the page when the block is saved.
- **e2e (note 100).**
  - `e2e-tauri/hash-tag-typing.e2e.ts` types `#name ` and `#[[multi word]] ` into a journal block and navigates away and back. It then reads the two chips that the real backend's stored content renders, and checks for no stray `]`.
  - The Playwright pair `e2e/hash-tag-typing.spec.ts` already covered both forms. It gains an Escape-then-Enter case and an Escape-then-click-away case.

**Worth knowing:**
- A block that also gains a `key:: value` line or a task marker in the same edit takes that branch first. Its `#name` becomes a tag the next time the block is edited and saved.
- `**#tag**` is now text on import, paste and save, as in Obsidian. `#[[multi word]]` still needs no boundary on any surface, as in Logseq.
- On main too, the first click on another block while editing only leaves the block and mounts no editor there. The click-away case asserts the save and nothing more.

**Verified.**
- Rust, `cargo nextest run --workspace` over the markdown, import, paste, source, page-command and tag tests: 1163 passed. `conformance_fixtures_match_backend` (update mode): 1 passed.
- vitest over `src/lib`, `src/hooks`, `src/editor`, `src/stores`, `src/components/block-tree` and `src/components/editor`, plus the tag, search, filter and page-browser components and `e2e-tauri` units: 13096 + 998 passed, 1 expected fail. `npm run typecheck` and `npx tsc -p tsconfig.wdio.json` are clean.
- Playwright, 11 tag, paste, import and Source specs: 93 passed.
- Red first on the old code: 7 TS rows, 2 Rust tests and the 2 new Playwright cases.
- 10 mutations on copies, 9 TS and 1 Rust, were all caught. They covered the boundary, the picker prefixes, the code-block guard, the supersede and save gates, the branch order, case-insensitive lookup, per-name create failure and the dedupe key.
- The e2e-tauri spec typechecks but was not run here; it runs in CI.
