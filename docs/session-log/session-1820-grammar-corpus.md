# Session 1820 — grammar, phase 1: a corpus, fuzzing and two parser properties

This is the second half of #5160's Phase 1, "the oracle first". It pins what the three text parsers do today, so each decision in the issue lands as a visible snapshot diff. It also adds two properties that catch silent loss. The first half, the shared vectors, is session 1819 (#5163).

**A corpus of real-shaped documents.**
- 20 short documents live in `agaric-engine/tests/markdown-corpus/`: a ChatGPT and a Claude answer, Logseq pages (page properties, `id::`, `collapsed::`, `TODO`/`SCHEDULED:`, `((uuid))`), Obsidian notes (`- [ ]`, `^id`, `[[P#H]]`, `~~~`, front matter), a Notion export with relative `.md` links, a Google Docs export, a README, `*` and `1.` lists, a nested four-backtick fence, CRLF, NBSP and tab variants, and Agaric's own export and Source buffer.
- They are `.txt` files, so the markdown link and lint hooks leave them alone. `.gitattributes` and the whitespace and line-ending hook excludes keep their bytes as written: those hooks would otherwise turn the CRLF document into LF and trim the Google Docs hard breaks.
- One insta snapshot per document records what import, Source and paste each make of it.
- `CORPUS_FINDINGS` lists, per document, the #5160 findings its snapshot pins as today's behaviour: S1–S8, P1–P3 and P8. The test fails for a document without a row.
- The same files seed the `import_parse` fuzz corpus.

**Fuzzing covers all three parsers.** The `import_parse` target now also runs `parse_source_outline` and `parse_pasted_text`, the two parsers that every Save and every paste run on raw user text.

**Two properties over a shared line generator** (`line_soup`: the import alphabet plus `*`, `1.`, checkboxes, `-\t`, tab and NBSP indentation, three- and four-backtick and `~~~` fences, ULID-shaped `^words`, and all three line endings; every fourth indent is deep, so the depth clamp is reached).
- **Fixpoint:** a Source buffer parsed, rendered and parsed again reads back the same tree, content, properties and anchors. In other words, the buffer you reopen after a save shows what it stored.
- **No silent loss:** every non-whitespace character of the input lands in content, a property or an anchor, for all three parsers. The only exceptions are the syntax a line gives up to the grammar, and the property lines an import warns it dropped.
  - It replaces two assertions that could never fail.
  - It cannot see S5 (a `- ` line in a column-0 fence loses its marker), because the bullet rule consumes that `-`. The snapshots pin S5 instead.
  - When an import warns about any dropped property line, every property-shaped line is excused. A per-line accounting would close that gap, but no code path loses a second property line today.

**Also:** the `import_markdown` conformance waiver no longer claims that Playwright covers parsing. That e2e runs the mock's line splitter; the Rust tests and `e2e-tauri/import-markdown-nesting.e2e.ts` cover the real parser.

**Review.** An independent reviewer made these changes:
- **The loss property was flaky.** An import reads a tab as two spaces, so `-::\t` became an orphan property line that the allowance didn't excuse. It failed about once in 4,000 cases, and proptest's saved seed would then keep it red. The allowance now reads tabs the same way, and the property is green at 3 × 20,000 cases.
- **The Source document used ULIDs no `.rs` file declares,** which the snapshot-redaction hook would have failed in CI. It now uses the fixture ids.
- **Three findings rows were added** (S7 twice, S3 once).
- **Over-building was deleted:** a README fence that repeated another document's S5 case, a guard against orphaned snapshot files, and an exclude that matched nothing.

**Verified.**
- The mutations were made on copies, each restored and `cmp`-checked, and each turned its test red:
  - `*` read as a bullet → the corpus snapshot;
  - a dropped caret word, the orphan counter removed, or the Source reading losing its anchor → the loss property;
  - no depth clamp → the invariants test;
  - no list-marker or property-line escape → the fixpoint;
  - a missing findings row → the corpus test;
  - a wrong waiver path → the citation guard.
- `cargo nextest run --workspace`: 6512 passed. Clippy and fmt are clean.
- `prek run` on all 67 changed files: every hook passed, and no file was modified.
