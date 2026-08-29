# Session 1455 — a second approving review, and three claims that were mine (#4507, PR #4541)

Short entry: a new file rather than an append, because `README.md:34` forbids
editing existing logs and `session-1451` is the previous round's.

## What the second approval found

Five of its eight notes were accuracy defects in prose **this PR added**, which
is the failure mode the PR exists to fix, arriving one round later.

- **"Six runs, and the only row never in doubt is `greek para`."** Contradicted
  by the two tables ten lines above it: under the block's own "within about
  twice its `range`" rule, latin (+62% vs 20%), turkish (+23% vs 5%), greek
  (+20% vs 4%) and short heading (+50% vs 3%) are all outside doubt. I wrote a
  superlative about a table I had just finished editing, and it took a reader
  applying the block's own stated rule to the block's own printed numbers to
  catch it. Now: the rows that have ever flipped are `astral` and `english
  para`, which is what the tree supports.
- **"both runs", twice, seven lines after "Six runs".** Same block, adjacent
  paragraphs, two counts. Both were pre-existing sentences the previous round's
  edit did not sweep — the same "fixed the instance that was named, missed its
  neighbour" shape as `session-1451`'s two findings, now three for three.
- **Two JSDoc lines run to 125 and 89 columns** where the block wraps at ~80,
  left by merging sentences into existing paragraphs. Prettier does not reflow
  prose inside block comments, so nothing was going to fix them.

## Two notes were stale, and checking cost nothing

Notes 3 and 4 said the PR body claimed "16 pins" and "`english para` has failed
to clear every time", and omitted the approving round's work. All three were
true of the body the review read and false of the body at the time it posted —
the body had been rewritten in between. Verified by fetching the live body and
counting substrings rather than by remembering having fixed it, which is the
distinction that failed two rounds ago.

Worth stating plainly: a review being right five times is not evidence it is
right the sixth. Both directions need checking against the tree.

## And one where the review's own numbers were wrong

Note 8 asked for a word in the docblock about the harness's structural
thresholds being calibrated rather than derived — fair, and taken. It offered
supporting ranges: "latin 2.1-2.5x, greek para 0.98-1.04x, deltas +11% to
+66%".

Grepping every published row in the tree gives latin **2.3-2.5x** (2.5, 2.3,
2.3) and greek para **0.98-1.00x** (0.980, 1.0039, 0.9965). Neither 2.1 nor
1.04 appears anywhere; 2.1 is `short heading`'s multiplier, one row down. The
minimum delta is +9%, not +11%.

I had already pasted those figures into the comment before checking them. The
correction is not that a reviewer erred — it is that I copied numbers from
prose into a committed artifact, which is precisely the move that produced the
four earlier rounds. The comment now cites only rows that exist in this
repository, and says why the earlier runs are not cited: they exist only in
transcripts, which is the gap this file was committed to close.

## Standing

Notes 5 (the recompute check never parses `renderTable`'s output) and 6 (the
noise floor mixes in `naive`) are recorded by the reviewer as already-known;
6 is #4543. The reviewer could not run `gh` to confirm #4543 exists — it does.
