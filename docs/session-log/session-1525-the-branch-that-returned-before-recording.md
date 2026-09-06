# Session 1525 — the branch that returned before recording

#4707: Back does not return to the Journal. The mechanism to do so already existed and was
correct — `goBack` routes an emptied stack to `exitViewForTab(activeTab)`, the tab's recorded
`enteredFrom`. The bug was that the origin was never recorded, and there turned out to be two
separate reasons for that, one of which the first pass missed entirely.

## Reason one: only an empty stack recorded an origin

```ts
function nextEnteredFrom(tab: Tab): View | undefined {
  if (tab.pageStack.length > 0) return tab.enteredFrom
  return currentEntryView() ?? tab.enteredFrom
}
```

Switching to a top-level view does not clear the tab's page stack — `openPage` for a date-titled
page returns early with `setNavigationView('journal')` and deliberately leaves it alone. So from
the journal every page open lands on a *non-empty* stack and keeps whatever origin was there. On
the reporting machine that was nothing at all, after months of use: `currentView: 'journal'`, a
28-entry stack, `enteredFrom` absent.

The guard against over-correcting was already in the file. `currentEntryView()` returns `undefined`
when the current view *is* `page-editor`, so deleting the emptiness check does not make an
in-editor push overwrite the stack's origin. The early return was redundant with a test the
function already performed.

## Reason two: the branch that returns before it records

The fix above was still not enough, and this is the part worth keeping. `navigateToPage` has an
early return for "the page is already on top of the stack":

```ts
const top = pageStack.at(-1)
if (top?.pageId === pageId) { setNavigationView('page-editor'); return }
```

Its own comment explains that it exists **because the user may have switched away to another view
in the meantime** — which is precisely the moment an origin needs recording. The branch returns
before reaching the push, so it never recorded one. Journal → click a link to the page your tab is
already parked on → Back went to `pages`.

That is #4707's literal acceptance criterion, still failing after the "fix", on one of the most
common paths there is. The reporting machine's own state fits it: the top entry was `Agaric`, a
page revisited constantly.

Generalisable: an early return added for a condition is a place that condition's consequences do
not get handled. This one's comment *named* the situation the fix was about and still didn't
handle it — the comment was evidence, and reading it as reassurance rather than as a lead is how
the first pass missed it.

## The test that was already guarded twice

The first pass added a test pinning "a deeper push from inside the editor keeps the stack's
original origin". Reverting the fix leaves it green — expected, since that behaviour is what the
fix preserves rather than adds. It goes red only against a plausible *wrong* implementation
(`return currentView` with no `page-editor` check).

That is a legitimate shape for a regression guard, except that the same wrong implementation
already reddens two pre-existing #4287 tests. The property was guarded twice before the test was
written. Deleted.

Also deleted: `expect(tabs[0]?.enteredFrom).toBeUndefined()` sitting two lines below the
`setState` literal that omits `enteredFrom`, with no coercion in between — an assertion restating
its own precondition.

## Move-to-top, not truncate

Revisiting a page anywhere in the stack used to push a duplicate; only the top was deduped. Hence
28 entries for 18 distinct pages, one appearing five times, climbing toward the cap of 50.

Truncating back to the existing entry looks tidier and is wrong: A→B→C→A would collapse to `[A]`,
so Back exits the editor immediately and silently discards B and C — pages visited more recently
than the first A. Move-to-top gives `[B, C, A]`: Back retraces the path actually walked, minus the
repeats. It is the Alt-Tab semantic, and it matches what Back means to a user — the last *distinct*
place they were.

Safe because every production reader of `pageStack` uses only `.at(-1)` or `.length`; the two that
look positional are not — `renamePage` matches on `pageId` (#3322) and `coerceTab`'s rehydration
is an order-preserving filter. The `#754` cap survives the change with the off-by-one intact: a
revisit filters to 49 and pushes to 50, which is not `> 50`.
