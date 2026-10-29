# Session 3041 — In the Document dialect, a heading, fence or break typed under text starts its own block (#5691 G2a)

G1 (#6162) left one question open: is a heading, code fence or `---` typed directly under a paragraph part of that paragraph? The maintainer answered (#5691, comment 6481099076): it is its own block, as in CommonMark, Import and Source, and the writer escapes such lines when they really belong inside a block. This applies the answer to the Rust `Document` dialect. Every command still passes `Source`, so nothing a user sees changes yet; G2b exposes the dialect.

**Reader (Document only):**
- A heading is one line that owns nothing.
- A fence opener or a thematic break typed under text starts a block.
- `para`, `---`, `after` is three blocks, never a setext heading.
- At a bullet's content column, a fence or break starts a child block, as CommonMark reads a fence inside a list item. Source still continues the bullet there.

**Writer:**
- Such a line inside a block's text is escaped with a `\`, the escape Source already uses.
- One predicate, `needs_document_line_escape`, is shared by the writer and the reader's unescape, so the escape is injective.
- A heading with a hard break (`## Heading\` + newline, as the editor stores it) is written escaped and reads back as one block.
- Breaks are tested by their opening run, so `--- x` is escaped too. That over-escape keeps the anchored and anchor-free forms in agreement.

**`get_page_source_inner`** now reads through `get_page_buffer_as(.., Dialect::Source)`, so the read snapshot is defined once (#6162's review note). The cost is one extra `anchor_free` parse per call on a path no interactive surface uses.

**Open for the maintainer, before G3:** text typed directly under a closing fence, with no blank line, stays in the code block (2 blocks, where CommonMark, Import and Source read 3).
- This follows D1's letter, and it carries the fence-plus-text blocks a Logseq import makes.
- Its cost: a `[[link]]` or `#tag` typed there is not created until a blank line separates it.
- G1's row 5 and the vectors pin this reading, so G2b's TypeScript reader must not "fix" it on its own.

**Proofs:**
- G1's three proptests, with generators that now produce heading, fence and break lines; 79% of generated forests hit a new shape.
- Table rows for each reading, plus typed rows the proptests cannot see, because the writer escapes every such line.
- The review added four rows, each killing a mutant nothing else catches, including the first non-ASCII text through the new slice.
- Every rule shown red alone.
- **Differentials** against the base build were byte-identical:
  - Import, Source, paste, by-ids, Clipboard, Agent, Export and subtree output, over 20,000 typed buffers, 4,000 pages and 30,000 bullet cases;
  - by contrast, Document output differed for 12,901 of the buffers, which shows the harness can see a change.
- **Suites:**
  - the full workspace nextest (7,204);
  - conformance (97);
  - clippy, the `SQLX_OFFLINE` check, and fmt.
