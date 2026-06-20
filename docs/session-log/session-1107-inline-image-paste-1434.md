# Session 1107 — /batch-issues loop: inline image paste → attachment (#1434)

Most of #1434 (the `image` node, `![alt](url)` parse/serialize, NodeView, at-rest render)
was already implemented on the base. The remaining gap — image **paste/drag-drop → store
as attachment → insert an inline node** + the attachment-ref resolution scheme — was built:

- `src/lib/attachment-ref.ts` (new): the `attachment:<id>` scheme (`attachmentRef`/
  `isAttachmentRef`/`parseAttachmentRef`, id validated by an anchored `^[0-9A-Za-z_-]+$`
  regex). Bytes never enter markdown — only the opaque id, so `![alt](attachment:<id>)`
  round-trips byte-for-byte through the existing serializer.
- `GatedImage.tsx`: `useResolvedAttachmentSrc` resolves `attachment:<id>` via `readAttachment`
  → `URL.createObjectURL` (revoked on unmount/src-change; error → broken-image placeholder).
  `readAttachment` is gated behind `parseAttachmentRef`, so a hostile ref never triggers a
  read. Attachment refs are trusted-local (not gated by the #1492 external-image policy).
- `EditableBlock.tsx`: image paste/drop stores bytes via the existing `addAttachmentWithBytes`
  and inserts the inline node ONLY into the actively-mounted block's editor; non-images and
  drops on unmounted blocks keep the plain block-attachment behavior. External `http(s)`
  unchanged.

Reviewer PASS (no defects): hostile-id rejection sound (security boundary = `parseAttachmentRef`,
read gated behind it); object-URL leak-free; byte-for-byte round-trip (serializer unmodified);
paste data-safe (no injection into a stale/other block); no regression to external-image
gating. 5662 vitest pass; tsc + oxlint clean; the builder ran the e2e (1/1).
