# Session 1703 — three list-surface papercuts (#4965)

Three independent papercuts that share one PR's worth of files: a multi-select
that pagination wiped, a Trash filter that hid its own basis, and a hand-rolled
Load-more button.

## Prune, don't clear

`useListMultiSelect` keyed its reset on an order-sensitive NUL-joined signature
of the whole item list and cleared everything when it changed, so "Load more"
dropped every selected row and a re-sort of the same ids did too. The guard now
intersects `selected` with the live id set and drops `lastClickedId` only when
that id has left the list. That keeps #3283's invariant — `selected` stays a
subset of `items`, which is what stops `TrashView`'s `handleBatchPurge` (it
purges `Array.from(selected)` with no intersection against the rendered rows)
from hard-deleting a row the user never saw selected — while an append or a
re-sort keeps the selection the user built. Both consumers of the hook
(`PageBrowser`, `useHistorySelection`) get the same fix for free.

The two replace-the-set tests the file already had still pass: a replaced set
prunes to the empty set, which is what clearing used to do.

## The Trash filter names its basis

The filter is an in-memory pass over the loaded pages (`PAGINATION_LIMIT = 50`,
no IPC), so with 300 trashed rows a no-match on page 4's title read as "purged".
`TrashListView` now takes `hasMore` / `onLoadMore`; when the filter matches
nothing and pages remain, the empty state says "No matching deleted items ({{count}}
loaded, more available)" — the phrasing `TrashEmptyDialog` already uses for the
same caveat — and offers Load more next to Clear filter. One new key
(`trash.noMatchLoadedMessage`, plural pair), no new IPC. With no pages left the
copy is unchanged.

## One Load-more

`TrashView`'s inline `<Button className="trash-load-more">` swapped its label and
nothing else: no `aria-busy`, no spinner, no distinct busy name. It is now the
shared `LoadMoreButton`. It moved into `TrashListView` rather than staying in the
orchestrator, because the no-match empty state renders the same control and two
copies would otherwise be on screen together; keeping the branch in one component
means the condition is not duplicated across two files. `LoadMoreButton`'s
progress line stays off: `PageResponse.total_count` is deliberately `null` for
trash. The three pinned tests select the button by `/Load more/i`, which is
`LoadMoreButton`'s default label, and stay green. Nothing else referenced the
`trash-load-more` class; the two now-orphan i18n keys
(`trash.loadMoreButton`, `trash.loadingMessage`) are deleted.

## Falsification

Each new test was shown red against a `cp` copy of the production file, restored
with `cmp` silent:

* Selection clear restored (`setSelected(new Set())`): "keeps the selection when
  a page is appended" and "…when the same ids are re-sorted" →
  `expected +0 to be 2`; "drops only the ids that left the list" →
  `expected [] to deeply equal [ 'a' ]`.
* Pruning removed entirely (keep-everything mutant): "drops only the ids that
  left the list" → `expected [ 'a', 'b' ] to deeply equal [ 'a' ]`, and the two
  pre-existing replace-the-set tests went red too — that pair is what pins the
  invariant against a "keep on append, ignore membership" variant.
* Message forced back to `t('trash.noMatchMessage')`: `Unable to find
  role="region" and name "No matching deleted items (1 loaded, more available)"`.
* `LoadMoreButton` dropped from the empty state: `Unable to find an accessible
  element with the role "button" and name /Load more/i`.
* Under-list `LoadMoreButton` replaced by the old hand-rolled button: the
  aria-busy test → `Expected the element to have attribute aria-busy="true",
  Received: null`.

## Not done

`docs/features/views.md` § Trash says "Search the trash with a debounced text
input" and does not mention that the search covers only the loaded pages. That
line could carry the caveat now that the UI discloses it; it was outside this
change's file set. `docs/FEATURE-MAP.md` describes neither Trash filtering nor
list multi-select at that grain (only a one-line Views row), so it is untouched.
