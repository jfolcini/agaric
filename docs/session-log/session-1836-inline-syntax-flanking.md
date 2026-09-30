# Session 1836 — Phase 3c-2: inline marks follow CommonMark flanking; typed and pasted links (#5160)

N9, N11, N12 and note 75 from #5160: the editor's inline parse and escapes. The maintainer asked for conventions over compatibility, so CommonMark decides.

**What changed.**
- **Marks open and close only where CommonMark's flanking rule allows** (N9 E22).
  - `*`, `**`, `~~` and `==` share one rule (`runFlank` / `flankClass`), so `5 * 3 = 15 and 2 * 4 = 8` stays text.
  - The serializer fits each mark boundary inward until its delimiter run reads back, replacing the italic-only #4156 defuse.
- **An unclosed delimiter is literal text in place.** Only its own mark comes off what follows, so the tags, links, block refs and math after it are kept.
  - This is the CommonMark rule. The first build flattened the rest of the line to text, which lost atoms in old notes.
- **Typing and pasting follow the same rule.**
  - `withFlankingShortcuts` wraps TipTap's bold, italic, strike and highlight input and paste rules, so typed arithmetic no longer italicises.
  - `*word*`, `**word**`, `_word_`, `~~word~~` and `==word==` still format.
- **Other inline syntax (N9):**
  - `$$x$$` mid-line is inline math (E19).
  - A link or image title is dropped from the destination, and `<…>` is stripped (E20).
  - Any ASCII punctuation can be escaped, so `\(x\)` survives edits (E21).
- **Links (N11).** A typed `[t](url)` becomes a link (`markdownLinks`). One pasted line is read with the inline parser at the caret.
- **Escapes only where they would parse (N12).** `x = 5, y ~ 3, a | b` is written as is.
- **Search indexes a space-flanked `==` or `~~` as text,** so `a == b and c == d` is found as written.

**Review.** An independent reviewer found one blocking defect and fixed it.
- **The defect:** old notes stored a mark boundary at a space (`**the **#[tag]`). Under flanking the mark stays open, and the first build then flattened everything after it into text. On the next edit, the tag, link URL or math was lost: 24 of 72 old-serializer shapes lost an atom.
- **The fix:** the CommonMark unclosed-delimiter rule. 0 of 72 lose anything now, and one-line paste keeps links, code and math.
- **What still changes for old notes:** a mark whose edge touches whitespace or punctuation (`**word **next`) now reads as literal stars. The maintainer accepted that.
- **Also:** the reviewer added the typed-flanking rule on the maintainer's request, and broke 11 builder claims plus its own on copies. Every mutation was caught.

**Worth knowing:**
- Typed emphasis still needs whitespace or a line start before the opener, so a typed `un*believ*able` stays literal although the parser reads it as emphasis.
- `a====b` still collapses to `ab`; this predates the phase.

**Verified.**
- vitest, the full suite: 19788 passed, 51 skipped, 1 expected fail. `npm run typecheck`, `oxlint --type-aware`, oxfmt, knip and import cycles are clean.
- Playwright, the full suite: 833 passed, 4 skipped, 1 unrelated flake that passed on retry.
- `SWEEP_RUNS=5000` on both markdown property files: 131/131.
- FTS, strip and search nextest: 454 passed, with the new strip test red first. clippy and fmt are clean.
