# Session 1604 — a Bookmarks section over state that already existed (#4713)

## What shipped

A collapsible Bookmarks section in the sidebar, listing the active space's
pinned recent pages. **No new store and no new state model** — the issue was
labelled `cost:medium`, but `recent-pages.ts` already had every behaviour it
needs.

Reused rather than rebuilt: `togglePinRecentPage` (`:531`), `applyPinFirstCap`
(`:159`) for pin-first ordering AND the `MAX_RETAINED` pin exemption,
`selectRecentPagesForSpace` (`:175`), `CollapsiblePanelHeader` (chevron,
`aria-expanded`, the shared expand/collapse labels), `EmptyState`, the
`SidebarMenu*` primitives, `usePreference`, and `getPageDisplayName(_, 'leaf')`
so a namespaced title fits a narrow column.

New: one component, one `PreferenceDefinition`
(`sidebar-bookmarks-collapsed`, device scope), four i18n keys.

## Proving the two borrowed behaviours are actually pinned

Both live in `applyPinFirstCap`, and both are easy to assert vacuously, so each
has a mutation that reddens it **and not the other**.

*Pin-first ordering.* Replacing the function with `return pages` leaves the
exemption test green and reddens the ordering test. The subtlety worth
recording: pin-first is a **stable partition**, so relative order among two
bookmarks is otherwise unobservable at this boundary. The test therefore visits
A, B, C, pins A, then visits **B again** and pins it — recency alone would put
Bravo first, and only the partition keeps Alpha there. Any simpler arrangement
would have passed with the ordering removed.

*`MAX_RETAINED` exemption.* Replacing it with `pages.slice(0, MAX_RETAINED)` —
the cap on the raw MRU, i.e. no exemption — drops the bookmark from the list
entirely: `expected [] to deeply equal [ 'Alpha' ]`.

Seven further mutations, one per remaining test, each reddening only its own:
dropping the pinned filter (5 red), the unpin action, the persisted collapse,
its `parse`, the space partition, `navigateToPage`, and deleting the section
from `AppSidebar`.

Every interaction test unmounts and re-renders before asserting and reads the
store back — durable re-queried effect, not call shape.

## A baseline bump refused

The first draft of the preference's `parse` was
`(raw) => (JSON.parse(raw) as unknown) === true`, which pushed the
`json-parse-cast` baseline from 2 to 3. Rewritten as `(raw) => raw === 'true'`,
exactly equivalent on disk because `jsonSerialize` writes the bare `true` /
`false` literal, and needing no cast. A baseline bump is permanent, ownerless
debt; the cast was avoidable.

## Scope note

`src/lib/preferences.ts` sits outside the file set this work was scoped to, but
the mandated mechanism is that registry: `prek.toml`'s `no-raw-local-storage`
hook and the module docstring both require a new preference to be declared
there. Ten lines, and the alternative would have been the banned one.
