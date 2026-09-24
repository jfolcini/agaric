# Session 1817 — grammar review, phase 0: stop losing text

A deep review of the grammar users write pages in (#5160, found while reviewing #5140's source mode) confirmed four ways a save, a paste or an import silently drops what was typed. This is its Phase 0: each fix is local and needs no design decision. The redesign waits on the decisions in #5160.

**1. A `^ID` that stops being trailing keeps its block.** In Edit as Markdown, typing after a block's anchor (End and type, Enter and type a line, a `key::` line with no value, a fence under it) left the bullet unanchored. The save created a new block holding the id as text and trashed the original, with its refs, history and hidden properties.
- Before pairing, an unanchored block whose text holds exactly one ` ^ID` of a block the user loaded, and that no other bullet claims, pairs with that block; the token and one space come out of the text. Two such tokens refuse the save and name both.
- Fenced code lines and inline code spans are skipped. Anchored blocks are untouched, so an unedited buffer still writes zero ops. Joining two bullets (`- foo ^A bar ^B`) keeps B, as before.
- In a merge save (#5159) the heal runs on the buffer before the merge compares it, against the anchors of the source the user loaded. A moved anchor then reads as that block's edit, so the merge's rules decide, instead of a delete that gives way and a new block holding `^A`.
- The mock heals the same way; `apply_page_source.json` and `apply_page_source_merge.json` pin it on both sides.

**2. Paste keeps a trailing `^word`.** `- press ^C` pasted as `press`. `restore_text_anchor` moved into `import.rs` and now runs at the end of `parse_pasted_text`; a ULID anchor is still dropped.

**3. Import keeps code and non-Logseq `((…))`.** Import deleted every `((…))` and squashed space runs on every line, code included: `print((a, b))` imported as `print`, and `    y  =  1` as `y = 1`, which broke Agaric's own export → import of indented code.
- A fenced code line is kept verbatim, dedented by its owner's text column: a bullet's content column, or bare text's own column. The review caught the second case (code under a heading lost two columns).
- Outside code only a Logseq uuid ref is stripped, still counted in the warning; inline code spans are skipped; one space collapses at the seam a strip opened. An Agaric `((ULID))` in a file is now kept: a live target becomes a link, a missing one an inert unresolved row.

**4. Edit as Markdown and paste keep property lines they won't store.** A reserved-key line (`repeat:: +1w`, `template:: x`) or one with no owning block was dropped with a warning worded "during import", which paste discarded. In Source mode (also paste) such a line is now content. Import keeps its filter and warning. The renderer never writes these shapes unescaped, so render → parse stays the identity.

**Not fixed here, known.** A code fence at column 0 under a bullet still loses two columns on import, and import still turns tabs in code into spaces and drops blank lines inside code: both belong to #5160's structure phase (S1). The heal re-scans content for fences, so a code line that is exactly another page block's escaped `\^ID`, with that block deleted in the same save, could pair wrongly; no realistic input has that shape, and the comment says so.

**Verified.**
- Every new test was red on the unfixed code first; 12 mutations across two runs, and 4 more for the merge ordering, each turned its targeted tests red, and every copy was restored and `cmp`-checked.
- An independent reviewer probed the heal (deleted bullets mentioned in prose, claims later in the buffer, CRLF, NBSP, forced saves, fences opening mid-block), the mock (11 shapes, all matching the backend), import code under tabs, 4 spaces and bare text, and the fuzz target's signature. It found and fixed the bare-text dedent.
- `cargo nextest run --workspace` 6508 passed after the rebase onto #5159; clippy and fmt clean; `npm run typecheck`; the mock suite 1035 passed and conformance 199 passed.
