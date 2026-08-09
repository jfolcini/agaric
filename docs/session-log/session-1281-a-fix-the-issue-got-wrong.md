# Session 1281 — a fix the issue got wrong, and five it got right

**Date:** 2026-08-09
**Issues:** #3342, #3339 (done)
**PRs:** #3683

Two grouped `deep-review` issues over the same two view layers — three perf findings in
#3342, three UX findings in #3339 — shipped as one PR because five of the six touch the
Pages browser or the journal panels and the sixth is the memoization that makes one of
the others visible on screen.

All six claims were re-verified against current `main` before anything was edited. All
six were real. What did *not* survive verification was one of the prescribed **fixes**.

## The prescription that would have broken the panel

#3342's first finding is correct: `PagesTreeSection` calls the explicitly-unpaginated
`listAllPagesInSpace` on every page open and every title edit, pulls every live page row
in the space, keeps only the rows prefixed `pageTitle + '/'`, and renders `null` when
there are none. The backend's own doc comment reserves that command for markdown export
and graph rendering.

The suggested replacement was `` commands.listPagesWithMetadata({ filters: [{ type:
'PathGlob', pattern: `${pageTitle}/*` }] }) ``. Read from outside the backend that is
obviously right — `PathGlob` is on `PagesProjection::allowed_keys`, the command is
cursor-paginated, done.

`prepare_globs` is what the pattern actually goes through, and it is not a passthrough.
It splits a glob entry on **top-level commas**, brace-expands `{a,b}`, treats `[...]` as a
character class, and returns a typed `Validation` error for unbalanced brackets, nested
braces or escapes. A page title is arbitrary user text. So the prescription, shipped
literally, means:

- a page called `Notes, drafts` silently queries two unrelated globs and ORs the results;
- a page called `Notes [2026]` fails the IPC, the `.catch` logs, `pages` stays `[]`, and
  a panel that worked before this "performance fix" now never appears.

That is a correctness regression traded for a payload reduction, on titles that are not
even exotic.

What shipped instead replaces every glob-significant character with `?` (match exactly
one character). That can only ever **widen** the match — never drop a real descendant —
and the exact prefix test the component already ran over the whole-space list stays in
place as the predicate. The glob is a server-side pre-filter; `filterDescendantPages` is
still the filter. The test for it seeds a decoy row that the widened glob admits and the
exact test must reject, so the two halves are pinned independently.

Worth recording separately: the swap does **not** make the database do less work.
`compile_path_glob`'s own comment ranks `PathGlob` last precisely because it is always a
full `pages_cache.title` scan. What collapses from O(pages) to O(descendants) is the IPC
payload, the JSON parse and the React work — which is the cost the finding actually
described.

## The collapsed panel that drained 5,000 rows

`UnfinishedTasks` is collapsed by default and its rows exist only inside the expanded
branch, yet it drained the whole `list_unfinished_tasks` cursor chain on every mount,
held the top of the journal on a skeleton for the entire sequence, and batch-resolved
every distinct page id — so that a collapsed header could show an exact number.

The issue offered two fixes and preferred (b), a backend `total_count` on the first page.
We took (a) — gate the drain on expansion — and made the badge honest about it: it reads
`N+` while pages remain unloaded rather than presenting a partial count as a total. (b)
remains the better end state and is noted on the issue; it is a backend change with no
frontend consequence, so it does not block this.

Two things had to move together. The `loading` derivation shares the drain predicate; had
only the effect been gated, a collapsed panel with more pages would have sat on its
skeleton forever — the exact freeze the existing `!isError` guard was added to prevent.
And the effect had to key on the **settled page count**, not `isFetchingNextPage`: that
flag can flip true→false inside one batched commit and be missed, which stalled the chain
at two pages and was caught only because the 25-page cap test asserted a real number.

## A picker instead of a box that asked for a ULID

The Pages "Tag" facet was a free-text input placeholdered literally `Tag id`. The
primitive compiles to `tag_id = ?`, and no surface in the app shows a user a tag ULID —
so the only action available (type the tag name) produced a filter matching nothing, a
chip that *looked* right because the resolver falls back to the raw string, and an empty
list. Uncompletable by construction.

Replacing it with an id-emitting picker had one consequence the issue did not mention:
`AddFilterPopover` is shared with AdvancedQuery, whose `LeafChip` deliberately passes no
`tagResolver` — correct while the value was hand-typed, wrong the moment it became a
ULID. Without also wiring that resolver the fix would have traded an uncompletable box
for a chip reading `tag: 01J…`. `InlineValueEditor` had no remaining caller afterwards
and was removed with it.

## Two destructive actions that skipped the app's own pattern

Ctrl/Cmd+A in the Pages view means "select all", and the backend cascades the soft-delete
over each selected root's whole subtree — yet the red toolbar button fired the IPC
directly with no confirm and no Undo. Saved-view delete was smaller in blast radius and
worse in recoverability: the trash icon shares its row with the apply target, and the
store is localStorage-only with no Trash and no restore path at all.

Both now follow the pattern the rest of the app already uses. Nothing novel; the finding
was an asymmetry, and closing it is mechanical.

## The memo that could never bail

`StreamView` passed each `DaySection` the whole `DayMountWindow` object. Its identity is
re-minted every time a day joins the mounted set, and every other prop is stable — so
that one prop broke `memo(DaySectionInner)`'s shallow compare for **every** rendered day
whenever **any** day scrolled into view. On a six-month stream that is ~180 committed
re-renders per observer crossing, plus the non-memoized BlockTree bodies, during one
scroll gesture.

Two scalar props (`mounted`, `onVisible`) fix it, and no hook change was needed:
`markVisible` was already an identity-stable `useCallback`; only the object wrapping it
churned.

The test is the part worth keeping. `StreamView.test`'s `DaySection` probe was not
memoized, so it could not have observed this either way — a memo bug is invisible to a
non-memoized stand-in. It is now `memo`'d like production and counts renders per day.
Making it faithful immediately exposed a second artefact: the mocked
`useJournalBlockCreation` returned a fresh `Map` per call where the real hook returns
`useState` identity, which re-minted `entries` on every render and would have masked the
bail-out permanently.

## Verification

Every fix was reverted locally and the suite re-run to confirm the corresponding test
goes red — including the glob neutralisation (revert to the literal interpolation → the
decoy test fails) and the memo fix (pass an inline arrow for `onVisible` → the render
count for untouched days rises).

16,203 frontend tests pass; `tsc --noEmit` and `oxlint` clean. No backend change, so no
Rust suite delta.
