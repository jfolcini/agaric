# Session 1108 — /batch-issues loop: render .md attachments inline (#1451)

`.md`/text attachments now render inline as formatted rich text (reusing the existing
`renderRichContent` parser) instead of a download-only chip. New `MarkdownAttachment` in
`AttachmentRenderer.tsx`: detects `.md`/text (MIME or extension — `.md` arriving as
`application/octet-stream` is caught by extension), lazily (viewport-gated) reads bytes via
`readAttachment`, UTF-8-decodes, renders read-only via `renderRichContent`. Header + collapse/
expand (expanded default) + download; 256 KB preview cap with a notice; load/decode error →
falls back to the shared `AttachmentFileChip`. Non-md (image/PDF/binary) attachments
unchanged.

Reviewer APPROVE (no defects): reuses the existing renderer (no reimplemented parser);
detection + no-regression correct; safety (cap + error fallback, non-fatal UTF-8 decode);
viewport-gated lazy load; a11y (aria-expanded, axe). e2e `md-attachment-render-1451.spec.ts`
3/3. 76 vitest pass; tsc + oxlint clean. Rebase-clean vs the merged #1452 (disjoint hunks in
`seed.ts` + `i18n/editor.ts`).
