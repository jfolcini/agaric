# Session 1835 — Phase 3c-1: `#` opens the tag picker, a typed `#name` becomes a tag (#5160)

D8 and N7 from #5160: typing `#` in the block editor.

**What changed.**
- **`#` opens the tag picker.** The `@` and `#` pickers come from one factory, sharing search, create and rendering.
  - It opens only where a space would make `#query` a tag. So never on a bare `#` or `###` run (headings still work), on `#42`, after a word character, `/`, `&` or `\`, or inside code, an open backtick span or an open `[[` link.
- **A typed `#project` plus a space or punctuation becomes the tag without picking.**
  - It matches an existing tag in any case, else creates one.
  - The character that ended the name stays after the chip.
  - The name is read with `scanNameTokens`, so the rule has no third copy.
- **`#[[multi word]]` makes the tag `multi word` (N7).** It used to make `[multi word` plus a stray `]`. The `[[` rule and picker no longer fire after a `#`. The hidden `#[name]` spelling is deleted; nothing typed, stored or imported used it.
- **`/` is no longer a tag boundary** in Rust `HUMAN_TAG_RE`, in TS `BARE_TAG_RE`, and in a new vector row.
  - `x.com/#install` stays text on import, paste, the buffer, the mock and typing.
  - Export brackets a tag after `/` as `#[[name]]`, which imports back as the same tag.
  - The maintainer asked for conventions over compatibility (Obsidian and Logseq need whitespace or a line start before a tag), so this ships as is.
- **Picker inserts keep the caret where the user is typing.** `resolveAndInsertPickerToken` and the create path insert with `updateSelection: false`, and the insert tracker maps with assoc -1. Text typed while a lookup or create runs lands after the chip, with the caret after that text.

**Review.** An independent reviewer found two defects and fixed both, each with a test shown red first:
- **The create path moved the caret back.** It still inserted with `updateSelection: true`, so text typed during a slow create put the next keystrokes mid-sentence.
- **The typed-tag handler dropped the terminator** when the typed text replaced a selection or an autocorrected range. The handler now replaces the matched range with the terminator in one call.

It also broke 9 of the builder's claims on copies (8 TS, 1 Rust); every mutation was caught.

**Worth knowing (follow-ups):**
- Where the picker does not open (e.g. `(#project`), Enter or a click-away leaves `#project` as text, while import reads it as a tag. By the Obsidian/Logseq convention it should be a tag.
- The boundary before `#` is still wider than whitespace: `(#tag)`, `,#tag` and `😀#tag` are tags.
- There is no e2e-tauri spec yet for the N7 typing bug.

**Verified.**
- `cargo nextest run --workspace`: 6624 passed, 13 skipped. Doc-tests: 10 passed. clippy and fmt are clean.
- vitest, the full suite: 19729 passed, 51 skipped, 1 expected fail, across 854 files. `npm run typecheck` is clean.
- Playwright, the full suite: 832 passed, 4 skipped, including `e2e/hash-tag-typing.spec.ts`.
