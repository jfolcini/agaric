# Session 1532 — two halves that disagreed on "empty"

#4729: 47% of live content blocks in a real vault are empty (508 of 1,086), 203 of the 352 under
pages are interleaved rather than trailing, and 106 have real content after them. Nothing anywhere
deletes an empty block. Fixed in two halves — drop on blur, and a boot sweep for what is already
stored — and almost everything worth recording is about where the two halves and the spec were
wrong.

## The predicate had to be measured before it could be written

Running the naive version against the real vault first is what made the design honest. All 508
pass the obvious guards (no children, no task metadata, no properties, no inbound refs) — but 97
are the only live child of their parent, and **216 pages would have been left with zero blocks**.
A page with nothing to click into reads as data loss. With a keep-one-trailing guard, 385 delete
and 123 are held back.

That measurement also exposed the trap in the tests: since all 508 pass guards 3-7, the data will
not build those cases. Every guard needed a fixture constructed for it, and removing guard N had
to redden test N and nothing else.

## The spec was wrong three ways, and the builder found all three

**Enter at the start of a line.** `splitAtCaret` returns `before: ''`, so the source block keeps
its slot and is *deliberately* empty while its text moves to a new sibling below. Blur-dropping it
makes Enter-at-line-start a visible no-op. The spec's trap list named double-Enter, which turned
out not to be a risk at all — the pre-existing cleanup already deleted that middle block.

**A truncated page cannot answer "has children".** `load_page_subtree` caps at 10,000 and cuts by
*position*, not tree-aware, so a loaded parent's high-position children are simply absent and the
block reads childless — while `delete_block` cascades over the real descendants. The cleanup now
stands down entirely on a truncated page.

**Zoom panes need their own arm.** `useBlockZoomEmptySeed` mints an empty child under a zoomed
leaf so the pane is typable. "Not the last block of its page" does not protect it, so every
click-away while zoomed would churn a delete op plus a create op for no visible change.

## The fix introduced a data-loss race, in the fix for a data-loss risk

The Enter-at-line-start exemption was registered **after** `await edit()`. But `edit()` empties the
source optimistically *before* its await, so a click elsewhere during that round trip fired the
cleanup on an empty, unexempted source: `remove(SRC)` → then `createBelow(SRC, after)` returns
`null` because its anchor is gone → the line's text is off the page, with the trash holding an
empty block.

The guard existed. It was one await too late. Registration moved before the first await and
withdrawn on both failure branches, with a test that gates `edit_block` and moves focus mid-flight.

## The two halves disagreed about what "empty" means

The frontend uses JavaScript `.trim()`, which strips every ECMA-262 whitespace character and line
terminator. SQLite's bare `TRIM` strips **U+0020 only** — confirmed directly:
`length(trim(char(10))) = 1`.

So a block holding a lone newline or a non-breaking space was empty on blur and not-empty at boot.
Two halves of one feature, shipped together, giving opposite verdicts on the same block. Guard 2
is now `TRIM(COALESCE(content,''), ?)` bound to the exact JS whitespace set, pinned in both
directions — JS-whitespace-only content is swept, U+200B (outside that set) survives.

Nothing about either half was wrong in isolation. The bug lived in the assumption that "trim" is
one thing.

## A cleanup that could brick boot

The spec said to wire the sweep like its siblings. That put it inside the boot-fatal bootstrap
transaction: `bootstrap_spaces` propagates with `?`, `recover_and_bootstrap` logs "aborting boot",
the Tauri `setup` closure propagates, **the app refuses to start**. One leaked block whose op
append failed would have done it — for a cleanup that is load-bearing for no invariant.

The builder spotted it, followed the instruction, and reported it rather than silently deviating,
which is the right order. Review then found a second defect in the same wiring: `bootstrap_spaces`
never arms engine rollback, so a batch aborting after N in-place engine applies would leave the
Loro engine N deletes ahead of the rolled-back SQL for the rest of the session.

Now its own module, own transaction, rollback armed, errors logged and swallowed. The test uses a
`RAISE(ABORT)` trigger to fail the sweep *inside* its transaction, and has a third phase that
sweeps successfully afterwards — so phase two cannot pass by the driver never having run.

## The age floor measured the wrong clock

The floor was a creation-time ULID range: nothing younger than seven days is swept, so the block
you are typing in is safe. But a block created a month ago and emptied *yesterday on another
device* — with the caret still in it there — passed that floor. `blocks` has no `updated_at`, so
recency had to come from the op log: any op on the block within the window now holds it, on the
existing `idx_op_log_block_created`.

Creation age and edit age are different questions, and only one of them is about whether someone
is using the block right now.
