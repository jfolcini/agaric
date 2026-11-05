# Session 3588 — an image inside a link keeps its link

#6342: a README badge, `[![CI](…/badge.svg)](…/actions)`, lost its link on the first edit of the block. The editor's parser read the image inside the link's text and dropped the link, because `consumeExternalLink` put the link mark on text nodes only, so `serialize(parse(c))` wrote back `![CI](…)`.

- Fix: the image node takes the link mark (`ImageNode.marks`). The parser puts it on an image inside a link's text, and the serializer's link grouping (`getLinkHref`, `stripLinkMark`) reads it, so the image is written inside `[…](href)` again, alone or next to text.
- Display: the static renderer wraps a linked image in the same external-link element a linked text run gets (`applyLinkMark`, shared with `applyTextMarks`). A linked image has no fold toggle, so a click on it opens the link. GatedImage's Load button stops its click and Enter/Space from bubbling, so loading a withheld external badge does not also open the link. In the editor, ProseMirror wraps the node view in the link's `<a>`, and the existing Ctrl+Click handler opens it.
- Rust: no change. The importer keeps the raw markdown, and its image/link reader already reads `[![a](x.png)](doc.pdf)`.
- The C3 known-failing row (`github-readme block 2` in `conformance/block-content.vectors.json`) dropped its `knownLoss` and now round-trips.
- Ran: vitest over `src/editor`, `src/lib/__tests__`, `src/components/RichContentRenderer` and `src/components/rendering`; `npm run typecheck`; `npm run lint`; `e2e/linked-image-6342.spec.ts` and the specs `e2e-related` picked. Each new test went red against origin/main's parser, serializer or renderer, on the assertion it was written for.
