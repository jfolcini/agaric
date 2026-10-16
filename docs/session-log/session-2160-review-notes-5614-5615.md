# Session 2160 — Review notes from #5614 and #5615

#5614: the `SectionGroupHeader` doc comment still justified keeping it apart
from `SectionTitle` with "chip background only makes sense at the larger
density". That PR removed the chip, so the example is gone and the sentence
stands without it.

#5615: the reviewer suggested inlining `readBaseline`, a `useCallback` with
one caller in the unmount cleanup of `useDraftAutosave`, as a direct
`rovingEditorRef.current?.originalMarkdown` read. Skipped: oxlint's
`react-hooks/exhaustive-deps` rejects a `.current` read inside an effect
cleanup, which is why the hook reads the editor through memoized readers
(`readLive` is the same shape). Inlining would trade the wrapper for a new
lint suppression.

#5616 and #5617 had no notes.
