# Session 3515 — CRLF and BOM transforms in the Document proptests (#6277 H1)

Set out to finish #6277 H1. #5363 slice 1 (#6328) shipped the rest of it, but left out the `\r\n` and BOM transforms of the saved text, which waited on B1 (#6327).

**Premise check.**
- `anchor_free` folds `\r\n` and a lone `\r` to `\n` before anything is read.
- The parser's `without_bom` drops a leading BOM in `parse_import` and in `source_outline`, which reads every Document text.
- The mirror has no inbound reader yet (that is H2), so the file property models that read as the existing one does: `anchor_free`, then a read by the shadow's line ids.
- No reader was missing a case, so nothing outside the tests changed.

**What shipped.** Two properties now take a transform of the saved text: none, `\r\n` for every `\n`, a leading BOM, or both (`saved_as`).
- A buffer read by its line ids is still the rendered tree.
- A mirror file without its anchors, read by the LF file's ids, still reads as the buffer does.

**Tests.**
- Reds shown: dropping `without_bom`'s strip reddens both properties at `saved = (false, true)`; dropping `anchor_free`'s CRLF fold reddens both at `saved = (true, false)`, where the anchor stays in the content.
- The shrunk seeds were not kept, since the generator covers all four transforms.
- Gates: the `markdown::source_tests::` module and the markdown nextest filters (75 passed), and clippy.
