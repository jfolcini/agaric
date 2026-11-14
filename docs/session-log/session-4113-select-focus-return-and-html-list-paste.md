# Session 4113 — a Select leaves focus where a click put it; a list pasted as HTML in page mode is a block per item

Two issues filed the same day, one PR, one commit each.

## #6729: the Has Tag filter's tag picker closed under the spec's click

`e2e/menus-popovers.spec.ts` failed once in CI on the click on the tag picker's `work` option: "element is not stable", then "element was detached from the DOM". The page snapshot of that run showed the picker closed and focus on the Filter category Select, which named the cause.

Radix refocuses a Select's trigger one zero-delay timer after its list unmounts (`FocusScope`'s unmount). The spec picks *Has Tag* from that Select and then opens the tag picker, a popover that closes when focus leaves it. When the click on the picker's trigger lands between the unmount and the timer, the timer takes focus back to the Select and the picker closes.

Neither guess in the issue held: the cmdk list does not re-mount its items, and the popover's placement was not involved.

- Reproduced by stretching that gap: zero-delay timers held until the picker is open, then released. Before the fix the picker closed every time, with the end state of the CI snapshot. Plain repetition never showed it.
- Fix, in the product (`src/components/ui/select.tsx`): the wrapper's `onCloseAutoFocus` leaves focus alone unless it fell to the body, which is where it is when the list unmounts with nothing else focused. Every Select gets it, so the sibling pickers that follow a Select are covered.
- A person reaches the window only when the main thread stalls for that one timer; the spec's machine-speed click reaches it more easily. It is still the product taking focus from where a click put it, so the product was fixed and the existing spec left as it was.
- New spec beside the old one holds the timers, opens the picker, releases them and picks the option.

## #6727: a list pasted as HTML in page mode landed as one block

Page mode kept ProseMirror's own paste for any HTML, which reads `<ul>` as a list inside one block. Block mode converts HTML to Document text and reads that.

- `src/editor/page-mode/page-paste.ts`: HTML from outside our editors that holds a `<ul>` or `<ol>` is converted with block mode's `htmlBodyToOutline` and `outlineToDocument` and read by page mode's existing Markdown paste (`pastedSlice`), so there is no second parser. The conversion is loaded on first use, so the paste is claimed at once and lands at the selection when it answers.
- Only HTML holding a list takes this route. Headings and paragraphs already become blocks through ProseMirror's own paste, and the specs that pin that were not touched.
- A copy from one of our editors (`data-pm-slice`), a paste into code, and HTML that reads as no blocks where it lands (one item after text, inside a list or table) keep ProseMirror's own paste.

Traps:

- A slice built by hand is closed at both ends, so the block pasted into was replaced and lost its id. ProseMirror opens a text paste's slice (`Slice.maxOpen`) before `handlePaste`; the async route does the same. The unit test that pastes into a block with an id caught it.
- A guard against `view.pasteHTML` re-entering the conversion was written, and its mutation survived: the event ProseMirror makes for it carries no clipboard. The guard was deleted.
- A commit made while Playwright's web server was building stashed the unstaged change out of the tree, and the run tested a bundle without it. Do not commit while a Playwright run is starting.

## What ran

- Red first: both new e2e specs failed on the predicted assertion before their fix (the picker's input no longer focused; one stored block holding the whole list).
- Mutations, each restored: the Select's check removed; the `data-pm-slice` check, the code check and the fallback paste removed in `page-paste.ts`.
- Playwright: the two touched spec files' new and neighbouring tests at `--repeat-each=40 --workers=6` (80 runs of the tag picker's two tests, 80 of the list paste's two), and the page-mode paste specs, `menus-popovers` and `html-paste-1439` at `--repeat-each=5`.
- The full vitest suite, `npm run typecheck`, `npm run lint`, `prek run --hook-stage manual --all-files`.

Not run: the rest of the Playwright lane and the real-backend lane (`just e2e-related` selects both whole for a change to `select.tsx`; CI's run is the check), and the Rust suites (no `src-tauri/` change).
