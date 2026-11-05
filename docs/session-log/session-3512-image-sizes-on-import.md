# Session 3512 — Image sizes survive import (#6033 S6)

Set out to build #6033 S6: an image's display size, written in Obsidian's or Logseq's own form, was dropped on import, so a sized figure came back at full width.

**Premise check.**
- `OBSIDIAN_EMBED_RE` threw away the `|…` suffix of `![[pic.png|300]]`, and `detect_attachment_refs` stored an empty alt.
- Logseq's `![alt](url){:height 53, :width 42}` stayed literal text after the image. Removing the new call site showed the map left in the stored content.
- Agaric's own sized image is `![alt|W](url)` or `![alt|WxH](url)`, read by `parseImageAlt` (`src/lib/image-alt-size.ts`). The new readers match that grammar.

**What shipped.**
- An Obsidian `|W` or `|WxH` embed suffix becomes the alt size. Any other suffix, such as display text, keeps the alt empty as before.
- A Logseq width map right after an image becomes the alt size: the fraction Logseq's drag can leave is dropped, and the height is kept as `|WxH`. This applies to an attached or a remote image. A map with no width, a link, inline code, an escaped image and a code block stay as written.
- A non-image `![[scan.pdf|300]]` embed is a link labelled by its file name, so the size no longer becomes its label.

**Trade.** The Logseq rewrite runs at import only (`parse_import_payload`), not in `normalize_foreign_forms`. That shared entry also serves Edit as Markdown and MCP writes, and Agaric's writer does not escape `{:width N}`: text a user typed would be rewritten on every save.

**Tests.** Two engine unit tests, two import tests in `page_cmd_tests.rs`, and a sized embed added to the real-backend Obsidian vault spec, which asserts the rendered width. Reds were shown for: the empty alt, the file-name label, the import call site, the inline-code skip, the dropped height and the escape skip. Gates: the import, attachment and image nextest filter, clippy, typecheck, and the `src/lib` vitest suite.
