# Session 1989 — the frontend never defaults or widens a space (#5415, frontend slice)

Maintainer decision (2026-10-09): a space is never optional or defaulted, and
nothing widens past the one given; search is the only call that may cover
several or all spaces, and only as an explicit choice.

What shipped (frontend only; the backend and MCP slice follows):

- `toSpaceScope` is gone; callers use `requireActiveScope` and fail closed
  while no space is known, then refetch when it hydrates (effects key on
  `currentSpaceId`). No production `{ kind: 'global' }` remains.
- Title, breadcrumb and link resolution (Done, Unfinished, Agenda, Due,
  tag filter, advanced query, trash breadcrumbs, backlinks, embeds, block
  refs) resolve in the active space; a cross-space target renders broken,
  as cross-space links already do.
- Creates (tags, blocks, seeds, saved queries) refuse with the existing error
  path when there is no space; `ipc-helpers.createBlock` requires a space.
- No `spaceId ?? ''` reaches a space-required command (agenda filters,
  Due panel, batch counts, calendar).
- Deep links resolve the target's own space and switch to it before
  navigating; an unresolved target logs and stays.
- History's "All spaces" toggle is removed: it was the last all-spaces
  producer outside search.
- The mock errors on a missing or global scope only for the ten commands the
  backend already requires an active space for.
- Three seed/indicator hooks that read the space once in an effect now
  subscribe, so a space arriving after mount re-runs them.

Leftover found from an interrupted builder: a `console.error('WHO-CALLED')`
debug stub in `SearchPanel.test.tsx`, removed.

Verified: falsified on copies (dependency missing from an effect, History
dispatching a global scope, a global literal in `space-scope.ts`, deep links
not switching space, hooks reading `getState` instead of subscribing), all
red, restored and `cmp`-checked. Full vitest in two halves green apart from
the known `UnlinkedReferences` debounce flake (passes alone 7/7); Playwright
160 passed across trash, history, spaces, templates, import, deep links,
agenda, search, tags and journal specs; typecheck, oxlint, oxfmt and knip
clean.

For the backend slice: drop `Global` from `SpaceScope` and the serde
defaults, then make the mock throw on an omitted scope and update the
conformance fixtures that still omit it.
