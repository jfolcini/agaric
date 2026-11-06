# Session 3647 — `<% recording %>` in `/template` and the Templates view

The last piece of #5364 slice 2 (S5b). The palette's *New meeting* and the remembered template shipped in #6414; this adds the template side of the recording placeholder.

## The change

- **`insertTemplateBlocks` (`template-utils.ts`)** leaves out a block reading `<% recording %>`, and its children take its place. `/meeting` turns that block into the recording block (`is_recording_placeholder` in `meeting_attachments.rs`); a plain `/template` insert has no recording, so the block used to land as literal text.
  - The match is the Rust one: the whole block, trimmed, any case, spaces inside the delimiters allowed. A block that only mentions the token is copied.
- **The Templates view** lists `<% recording %>` with the variables, with an i18n description.
- **Docs:** `docs/features/editor.md`, in the `/meeting` entry.

## Tests

All added; no existing test changed.

- **`template-utils.test.ts`:**
  - The placeholder is dropped and its child lands in its place, in one batch. Red on main: the placeholder was copied (`NEW1, NEW2, NEW1, NEW3`).
  - A block that only mentions the token is copied. Unanchoring the match reds it.
  - Dropping the children's promotion reds the first test.
- **`TemplatesView.test.tsx`:** lists the token. Removing the entry reds it.
- **`e2e/templates.spec.ts`:** a `<% recording %>` block is added to the seeded template and inserted with `/template` on *Getting Started*. The page's blocks are re-queried after navigating away and back; they hold `## Attendees` and no placeholder. Red on main: the placeholder was among them.
