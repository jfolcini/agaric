# Session 1994 — page open sends fewer IPCs and navigates in fewer rounds

Set out to cut the duplicated and closed-panel IPCs on page open and the
serial waits before navigation (#5445). Three builders took disjoint slices in
separate worktrees; the slices were combined and reviewed as one.

Shipped: the page header reads properties through one shared
`usePageProperties` query, refetched only for the page's own block or by
`invalidatePropertyCaches()`, which sync, undo, MCP and import already call;
the Done panel keeps its expanded state. The unlinked panel reads aliases at
"Link it" and loads its count once it nears the viewport; tags load when "Add
filter" opens. A link click runs its two lookups in parallel and a same-page
link skips the reload; search and tag result clicks navigate at once when the
parent's title is already resolved.

Traps: filtering the header on the event's `block_id` alone would have hidden
sync and undo changes, which bump the counter without an event. The editor
reuses the property table across pages and cached pages arrive in the same
render as the switch, so draft rows leaked onto a revisited page until the
copy remembered its page id; a `null` fetch then looped until the comparison
used the value as given.

Not done: the tag picker's tag list (the header needs it at open to name the
page's tags) and the forced backlink-title refetch (the only refresh of a
block-ref title after its text changes). Suites run: full vitest, targeted
reruns after review, typecheck, lint, three Playwright specs.
