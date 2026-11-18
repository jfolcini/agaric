# Session 4324: specs attach files through the real command

Stage 0, gap G4a of #6926 (#6529).

**Gap:** specs seeded attachments through `window.__addMockAttachment` and `window.__addMockAttachmentWithBytes`. Those hooks wrote the mock's store directly, and they are absent on the bridge. Every call was optional-chained (`?.`), so on the bridge it did nothing and the spec went on without its file. That is the real cause of `seedLinkedPdf: the PDF was not attached`. My G1 note on #6926 had flagged it as a possible divergence.

**Change:**
- `attachFile` in `e2e/helpers.ts` calls `add_attachment_with_bytes`. Both backends implement it, with the same MIME and filename checks.
- These specs now use it: `attachments`, `image-lightbox`, `md-attachment-render-1451`, `pdf-annotation-1452`, `pdf-highlight-blocks-6629`, `perf`, `phone-block-lists` and `toolbar-controls`.
- A metadata-only seed of N bytes is now N zero bytes.
- The two window hooks and `addMockAttachmentWithBytes` are gone. `addMockAttachment` stays for the unit test that needs a row with no op behind it.

**Ran:**
- The seven non-perf specs on the mock: 54 passed.
- The six attachment specs on the bridge, temporarily listed: 50 passed, 1 failed. The failure is `pdf-highlight-blocks-6629`'s "a block moved to another space": after the move, the real backend renders two `Open file report.pdf` chips, which fails a strict-mode locator. It goes to area-slice triage.
- Typecheck and `oxlint --type-aware` are clean.
