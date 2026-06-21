# Validation — Correctness Frontend (TS/React)

## Verdict tally
- CONFIRMED: 2 (list-item round-trip; formatRepeatLabel `y`)
- CONFIRMED-BUT-RESEVERITY: 0
- EXAGGERATED: 0
- ALREADY-HANDLED: 0
- HALLUCINATED: 0
- TRIVIAL / not worth filing: 2 (expandBraces dead code; moveBlocks transient)

Both substantive findings hold up under adversarial check. The raw report was
honest and well-hedged; my main contribution is resolving the two reachability
caveats the author left open — and both resolve *in favor of the finding being
real*, not against it.

---

### [MEDIUM] List item with multiple leading paragraphs does not round-trip — CONFIRMED
- **Evidence checked**:
  - `markdown-serialize.ts:709-725` (`serializeListItem`): non-list children go
    through `serializeParagraph` with NO indentation; children joined by `\n`,
    marker prefixed only to the joined result.
  - `markdown-serialize.ts:418`: `hardBreak` serializes to a backslash hard
    break `\\\n` (backslash + newline), NOT a bare `\n`.
  - `parser.ts:374-399` (`collectListItem`): continuation lines are collected
    only when `leadingIndent(line) > 0` (line 385); an unindented continuation
    is left for the top-level dispatcher.
  - `parser.ts:469-487` (`buildListItem`): calls `parseLine(itemText)` (does
    NOT strip a trailing backslash — only `parseParagraph` does, line 513), and
    keeps only `bulletList`/`orderedList` among nested blocks.
  - `use-roving-editor.ts:459,467`: both `ListItem` (stock
    `@tiptap/extension-list-item`, no content restriction → default
    `paragraph block*`) and `HardBreak` are enabled.
- **Reachability (the author's open question) — RESOLVED as reachable.** I
  traced a `listItem > paragraph[text, hardBreak, text]` (a Shift+Enter inside a
  list item, fully supported by the enabled extensions):
  serialize → `"- foo\\\nbar"` → reparse:
  `parseBulletList` collects only `- foo\` (text becomes literal `foo\`, the
  hardBreak meaning is lost), then `bar` (leadingIndent 0) is NOT attached and
  falls through to `parseParagraph` (parser.ts:539-540) as a separate top-level
  paragraph. So the round-trip drops the hardBreak AND splits the item — exactly
  the described drift. The `#1333` hardBreak property test
  (`markdown-serializer.property.test.ts:841-871`) only covers hardBreaks in
  TOP-LEVEL paragraphs, never inside list items, so this is genuinely uncovered.
- **Severity**: MEDIUM is appropriate. Silent structural change to user content
  on blur, but a narrow trigger (Shift+Enter, or a second paragraph, inside a
  list item). No data-loss beyond the visible re-shape; not a crash.
- **Better-approach note**: The author's "indent continuation lines" fix is
  sound for the multi-paragraph case but be careful: the hardBreak sub-case is
  arguably better fixed by having `buildListItem` run the same
  trailing-backslash hardBreak join that `parseParagraph` does on the item's own
  text, OR by collecting `\`-terminated continuation lines into the item. A
  round-trip test pinning `listItem > paragraph[…hardBreak…]` should ship with
  whichever fix.

### [LOW] `formatRepeatLabel` custom-interval regex omits the yearly unit — CONFIRMED
- **Evidence checked**:
  - `repeat-utils.ts:23` lists `yearly` as a named interval; `repeat-utils.ts:27`
    custom regex is `/^(\d+)([dwm])$/` — no `y`; falls through to `return value`
    (line 38) rendering the raw token.
  - **Reachability (author's open question) — RESOLVED: `Ny` is a real,
    first-class grammar value.** Backend `recurrence/parser.rs:120` handles
    `"y" => shift_by_months(base, n*12)`, doc comment lines 142-143 list
    `+Ny`/`Ny` as supported, and an entire test module `tests_m80`
    (parser.rs:268-342, "+Ny (yearly) recurrence support") pins `+1y`, `+4y`,
    `+2y`, leap-day clamping, etc. So a user CAN enter `+2y` and the label
    formatter will show the raw `+2y` instead of "every 2 years".
- **Severity**: LOW is correct — display-only, no data corruption (the backend
  still computes the recurrence correctly; only the FE label is ugly).
- **Better-approach note**: Trivial fix — add `y` to the char class
  (`[dwmy]`) and a `repeat.everyYears` i18n key in the `unitKey` ternary. The
  author's "only if backend allows Ny" precondition is satisfied; no need to
  gate the fix.

### [LOW] `expandBraces` dead parity code — CONFIRMED but TRIVIAL (drop)
- **Evidence checked**: `glob-validate.ts:96-104` header explicitly states "no
  production caller … intentionally retained, exported, and pinned by tests …
  the contract that matters: at EXPANSION_CAP the result is truncated, never an
  error". `expandBraces` (141-161) is exported but I confirmed it's a parity
  reference. The cap logic (lines 153/157/158) is as described.
- **Verdict**: real observation, but it is *by design* dead code with a pinned
  parity contract, and the author themselves rates impact "None today". This is
  a speculative future-drift note, not a defect. Recommend the synthesizer DROP
  it (or downgrade to a one-line "parity-test could also assert ordering" nit).
  Not file-worthy.

### [LOW] `moveBlocks` consecutive-slot assumption — CONFIRMED-as-described but TRIVIAL
- **Evidence checked**: `page-blocks.ts:1072-1110`. The per-item
  `moveBlock(id, newParentId, newIndex + k)` loop and the documented "backend
  slot excludes the moved block" rationale (lines 1087-1094) match exactly. A
  full `get().load()` (line 1101) runs after the loop and on the catch path
  (1108), so the FINAL FE tree is always the authoritative backend order.
- **Verdict**: The concern is honestly scoped by the author as *transient only*
  (masked by reload), confidence low, and dependent on backend
  same-parent-reorder slot semantics that live in `move_ops.rs`
  (`move_block_inner`) — not verifiable from the FE. At worst the moved run
  lands in an order the user didn't intend, immediately corrected by reload;
  never a crash or data loss. Correctly deferred to the backend-correctness
  validator (the author flagged it as a cross-check). Not independently
  file-worthy from the FE side.

---

## Validator-added findings
None. The adjacent code (paragraph/hardBreak parsing, list nesting #1513) is
well-guarded; nothing obvious was missed next to these findings.

## Net assessment — what to file (ranked)
1. **[MEDIUM] List-item round-trip drift** — file it. Genuinely reachable via
   Shift+Enter / multi-paragraph list items, uncovered by existing tests, causes
   silent content reshaping on blur. The single substantive bug in this report.
2. **[LOW] `formatRepeatLabel` missing `y`** — file it (or fold into a "repeat
   label polish" issue). Confirmed reachable now that `+Ny` is a real grammar
   value; trivial S-effort fix; user-visible cosmetic glitch.
3. **`expandBraces`** — DROP (intentional dead code, no defect).
4. **`moveBlocks`** — DROP from the FE report; let the backend validator decide
   whether `move_block_inner` same-parent slot math actually mis-orders. FE side
   is reload-safe.
