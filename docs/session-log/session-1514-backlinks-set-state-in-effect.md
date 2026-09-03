# Session 1514 — backlinks: retire three set-state-in-effect cascades

Issue #4407, one directory slice. `react/set-state-in-effect` is warn-level and new code keeps
adding sites, so each swept directory is promoted to `error` behind it. This is the
`src/components/backlinks/` slice: three findings, all resolved, rule promoted for that
directory only.

The issue is explicit that there is no mechanical fix here — `setState` inside `useEffect` is
the shape of a render cascade, and each site needs a judgement about whether the effect should
exist at all. All three turned out to be the same shape: **reset state when an identity prop
changes**, which is a render-phase concern wearing an effect's clothes.

## The three sites

`UnlinkedReferences.tsx` reset `collapsed` on `pageId`, and cleared its per-group collapse
overrides on the query identity. `LinkedReferences.tsx` reset filter, sort and source-page on
`pageId`. In each case the effect ran *after* commit, so one render escaped with the previous
page's state: the unlinked panel rendered open for a frame and issued the 20-group fetch that
being collapsed exists to avoid (#3316 item 2), the new query's groups rendered once under the
old query's overrides, and the new page was queried once through the old page's filters.

All three are now guarded render-phase adjustments comparing the previous identity, which is
what the rule's own help text prescribes and what this repo's #4407 triage already chose
(`session-1397-oxlint-react-rules.md`). The effects are deleted, not suppressed.

## What the obvious fix would have broken

Storing the identity alongside the state and deriving on mismatch — the tidier-looking form —
makes the state *remembered* rather than forgotten. Navigating A → B → A would restore A's
filters, reopen A's panel and reinstate A's collapsed groups, because these components stay
mounted across page navigation: there is no `key` on `PageEditor` or `LinkedReferences`. So
that flow is reachable, and it is a behaviour change. Comparing the *previous* identity forgets
on every change, which is what the effects did. A `key` on the components was rejected for the
same reason plus a worse one: it would also reset `expanded` and `tags` and refetch tags on
every navigation, and the header counts come from a query living inside the state being reset.

User-visible behaviour is therefore unchanged, except that two sites lose a wasted fetch and a
one-frame flash.

## A test that was pinning nothing

Falsification found a real hole. Breaking the `expandedGroups` clear left all 140 backlinks
tests green — before *and* after the change, so the site had no coverage at all and the sweep
would have been free to get it wrong. `clears per-group collapse overrides when the query
identity changes` now pins it. The other two sites were already covered: breaking their guards
reddened three existing tests.

## Verified

`npx oxlint`: **88 → 85** findings, exit 0, none in `backlinks/`. `npm run typecheck` clean.
`npx vitest run src/components/backlinks`: 6 files, 141 tests. Consumers and hooks (App,
JournalPage, PageEditor, DaySection, CollapsibleGroupList, `useBacklinkGroups`,
`useUnlinkedReferences`, `useFocusedRowEffect`, viewTransition, and the react-compiler
suppression guard): 17 files, 534 tests. All passing, `axe(container)` included.

The promotion itself was falsified rather than assumed: reintroducing the violation into
`LinkedReferences.tsx` reports it as `error`, not `warning`, and oxlint exits 1. Restored and
`cmp`-verified.

Left alone: the pre-existing `react(rule-suppression)` warning at `BacklinkGroupRenderer.tsx`
is a different rule, and the config's own comment records that `error` there is unreachable by
construction.
