# Session 1464 — the review's numbers needed checking too (COMPARISON.md, PR #4547)

## What happened

An approving review of the COMPARISON.md re-audit raised eight internal-consistency
defects. All eight were real. Two of them, when checked against the tree rather
than accepted, turned out to be **wrong in the same direction as the document** —
the reviewer had caught that a number was off without landing on the right one.

That is the whole lesson of this entry: a review that finds a real defect has not
thereby established the correct value. Both were one command away.

## Seeded built-in properties: doc said 18, review said 19, tree says 20

The document listed 18 keys. The review noted `is_space` (`src-tauri/migrations/0035_spaces.sql:7`) was
missing and called it 19.

Extracting every `INSERT OR IGNORE INTO property_definitions` across the migrations
gives **20**: the same statement in `0035_spaces.sql` seeds `space` *and* `is_space`,
and only the second was noticed. Both are internal markers, which is presumably why
the list omitted them — but they are seeded rows like the other eighteen, so the
count is 20 and the qualifier belongs in the prose, not in a silent omission.

## The commit census: doc said 75 (summing to 74), review said 74, tree says 76

The document read "Of the 75 commits ... 40 `fix`, 12 `docs`, 7 `refactor`, 7 `ci`,
6 `test`, 1 `perf`, 1 `feat`". The review correctly observed that those figures sum
to 74, not 75, and inferred one unaccounted commit.

Recounting: there are **76** commits reachable from `main` in this checkout, and the
breakdown is 40 / **13** / 7 / 7 / 6 / 1 `chore` / 1 / 1. So the document was wrong
twice — it undercounted `docs` by one *and* dropped the `chore` bucket entirely —
and the total was wrong by two, not one. The reviewer's arithmetic on the stated
figures was right; the stated figures were not the data.

Worth noting why this was checkable at all: the audit's appendix says the checkout is
shallow and reconstructs history from session logs instead of `git log`. It still is
shallow — but `git log` works fine *within* the window, and the census was always a
one-liner. The caveat about reconstructing "what shipped since the last review"
got applied to a question it did not cover.

The line now states the count, gives the recount command, and says the window is the
clone's depth rather than a date range — so the next reader gets a number they can
reproduce and a warning that its absolute value moves between checkouts.

## The inheritance finding got stronger, not weaker

The document twice said `block_tag_inherited` is "read by no query surface" and that
"every caller passes `null`". The review flagged both as stronger than the code.
Correct, and the precise version is a better finding:

- `src-tauri/agaric-store/src/tag_query/resolve.rs:35,123` and `src-tauri/src/commands/queries.rs:1382,1408` **do** branch on
  `include_inherited`. The read path exists and is maintained.
- `src/lib/tauri/queries.ts:240` passes `params.tagFilters.includeInherited ?? false`
  — `false`, not `null` — and the commands default `None` to `false`
  (`src-tauri/src/commands/tags.rs:549,599`). Only tests pass anything else.

"No query surface reads it" invites the reply "here is the line that reads it", and
the point survives that reply badly. "The read path is complete, maintained across
five propagation paths, and unreachable from any production caller" does not.

## I applied the freeze rule one step too early

I left four wrong numbers in `session-1460` — the linking figure, the inheritance
claim, `75` commits and `596/283` axe — on the grounds that
`docs/session-log/README.md:34` routes reviewer corrections to the PR rather than into
the log.

The next review pointed out what the rule actually says: *"Never rename or edit
**existing** files."* `session-1460` is **added by this PR**. It is not an existing
file; it has never landed. Correcting a draft before it is published is not rewriting
the record, it is declining to publish a known-wrong one — and a session log is
precisely what the next audit reads, which is the failure mode Part 5 exists to stop.

All four are now corrected in `session-1460` itself.

This is worth recording as a judgment error rather than a rule ambiguity. Having broken
that rule four times in the previous PR, I over-corrected into applying it to files it
does not cover, and the over-application was itself costly: two of the four wrong
numbers were disclosed nowhere at all, so a later reader would have picked up `75` and
`596/283` as fact. The same reasoning means my call on `session-1455` in #4541 was also
wrong — that log was new in its own PR and its `0.98-1.00x` band could have been fixed
before merging. It is merged now and genuinely frozen, which is what #4536 is about.

A rule that names a class ("existing files") does not extend to the adjacent class just
because the adjacent class is where I last got burned.

## Left standing

The Block CRUD row dropped 10→9 with no annotation. Logseq's score in that row moved
10→9 as well, so the honest reading is a rescale with relative standing unchanged, and
that is what the change column now says. If the audit had a capability reason for it,
it did not record one, and inventing one after the fact would be worse than naming the
arithmetic.
