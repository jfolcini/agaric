# PDF highlights and pinned comments as blocks

How a highlight or a pinned comment made in the PDF reader becomes a block, and how that block keeps pointing at its place in the file. The user-facing description is in [`../features/editor.md`](../features/editor.md); this note records the decisions (#6629) and where each one lives in the code.

## The decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where the block goes | A child of the block that owns the PDF, added last | The owner is known whenever the reader's tools are shown, so nothing has to be looked up, and notes gather under their paper. A page per PDF would need a PDF-to-page lookup and a page to create. |
| How it addresses its place | The page number, plus its boxes in PDF units | The bytes at an attachment id never change, so the coordinates never drift, and PDF units do not depend on the zoom. A text anchor would need fuzzy matching; the block's text already is the quote. |
| Where the address is stored | Three text properties on the block: `pdf_attachment`, `pdf_page`, `pdf_boxes` | Properties are the extension point: no table, op type, store or migration. Putting the place in the link text would put coordinates into the user's words. |
| Whether the file still carries the annotation | Yes. *Save* writes highlights and comments into the PDF, as before | The file stays complete when opened in another reader. The cost is the next row. |
| What identifies the PDF across a save | Nothing stable: each save stores the annotated copy under a new attachment id and deletes the original, so the save moves every reference to the new id first | A file at a given id stays byte-stable for sync. The alternative, keeping every original, adds a file per save and leaves links opening the old one. |
| When the block is made | On *Save*, not when the annotation is finished | Until *Save* the annotation lives only in the reader: an undone highlight or a reader closed unsaved would leave a block pointing at an annotation no file holds. pdf.js also reports annotations already in the file as added whenever its editor layer is re-enabled, so a block per report would duplicate. |
| How a click gets back to the place | A source chip on any block that has `pdf_attachment` opens the reader on `pdf_page` | An `agaric://` address for a place in a file is only needed for links from outside the app. |

## The three properties

`PDF_PLACE_KEYS` in `src-tauri/agaric-store/src/op.rs` is the list; `is_internal_property_key` includes it, and `INTERNAL_PROPERTY_KEYS` in `src/lib/block-utils.ts` mirrors it, so a user's rename or merge of a property neither takes nor lands on these keys. The header of `src/lib/pdf-highlights.ts` states each key's format. They have no property definition, as `image_width` has none.

A comment has one box, the one it is pinned in; a highlight has one for each box pdf.js drew over its passage. `pdf_boxes` is stored for a reader that draws or scrolls to the exact spot; today the chip uses only the page.

The *Edit as Markdown* buffer and the Markdown mirror's file leave the three keys out (`drop_pdf_places` in `src-tauri/src/commands/pages/markdown_export.rs`), so saving either keeps them as they are; an export writes them.

## What a save does

`PdfViewerDialog::handleSave` composes existing commands, in this order:

1. Read the new annotations from pdf.js's own serialization (`newAnnotations`). One the file already holds carries an id and is skipped, which is what makes a second save add no second block. A free-hand highlight covers no text and makes no block.
2. Store the annotated bytes as a new attachment on the owning block.
3. Create one block per new annotation under the owner, in one batch (`annotationBlockSpecs`), pointing at the new attachment.
4. Rewrite `attachment:<old id>` in the owning block's text.
5. Point every block whose `pdf_attachment` is the old id at the new one, in every space the device lists (`repointAnnotationBlocks`): a block moved to another page or space follows its file.
6. Delete the original attachment.

Steps 4 to 6 are all-or-nothing in one direction only: the original is deleted only after the links and the blocks have moved. A failure before that leaves two copies on the block and every reference still opening one of them.

The sequence is several commands, not one transaction. That is accepted because every intermediate state is a working one; making it atomic would take a new backend command.

## Undo

The new blocks and the link rewrite are undo entries of the owner's page, also when the save was made from a source chip on another page; with the owner's page closed they are not recorded. The re-point of step 5 is not undoable: undoing it would point a block at the deleted original.

## Limits

- A reference to the PDF that a user copied into another block's text is not rewritten by a save; it names the deleted original afterwards. Finding it would take a content scan.
- Deleting an annotation block leaves the annotation in the file: the two are written together and then live apart.
- An annotation the file already held when it was attached, made in another program, is not turned into a block.
