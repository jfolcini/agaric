# Session 1084 — /batch-issues loop: TagFilterPanel deep composer, batch 33 (2026-06-20)

## What happened

Frontend feature from the overnight `/loop /batch-issues` run, built in worktree
`wt-batch33` and adversarially reviewed. The capstone of the tag-filter arc landed
tonight: SQL set-op resolver (#1622) → IPC (#1472) → UI (this).

## Shipped

PR `feat/tagfilter-deep-composer-1426`:

- **#1426** (FE feature, discoverability) — `TagFilterPanel` exposed only a flat single
  `mode` and hardcoded `prefixes: []`, so the backend's tag prefix search and nested
  AND/OR/NOT composition (now reachable over IPC via `queryByTagExpr`, #1472) were
  unreachable from the Tags view. Surfaced both:
  - **Prefix pills** (flat mode): a prefix-search input adds removable pills that feed
    `prefixes` into the flat `queryByTags` path (the hardcoded `[]` is gone).
  - **Nested AND/OR/NOT composer** (`src/lib/tagExpr.ts` model + `compileTagExpr`
    lowering; `src/components/filters/TagComposer.tsx`): groups with an All (And) / Any
    (Or) combinator, a per-node NOT toggle on every leaf and group, arbitrary nesting
    via Add Group, and Tag or free-text-Prefix leaves. `compileTagExpr` lowers the tree
    losslessly to a `TagExpr` (`{type,value}` wire shape), collapsing single-child
    groups and pruning empty/blank nodes so the resolver runs exactly what's on screen.
  - **Panel wiring** (`TagFilterPanel.tsx`): an Advanced/Simple toggle defaulting to
    Simple (existing users unaffected). Simple runs `queryByTags` (flat, unchanged);
    Advanced compiles to a `TagExpr` and runs `queryByTagExpr`. NOT is modeled as a
    per-node toggle (the issue's suggested approach), cleanly expressing
    `(A AND B) OR (NOT C)`.

## Review pass

Reviewer (APPROVE, no defects): walked `compileTagExpr` against every edge case — NOT on
a group wraps the WHOLE group (`Not(And([...]))`, not `And([Not...])`), single-child
collapse preserves negation, NOT-of-NOT preserved, and malformed trees (`And([])`,
`Not(undefined)`, empty-everything) are structurally impossible (empty → null, guarded by
`tagBuilderHasLeaves` before compiling). Confirmed the headline `(A AND B) OR (NOT C)`
test asserts the REAL compile output (read from the actual `query_by_tag_expr` invoke
arg, not a hand-built fixture) and would fail under an And/Or swap or misplaced NOT.
Flat-mode back-compat intact (defaults Simple → `queryByTags`, `lastTagExpr` undefined;
prefix pills feed `prefixes`, identical results when none set). Degenerate empty composer
fires no query. `axe(container)` passes for composer-open + results states; combinator is
a radiogroup, NOT toggles `aria-pressed`, controls `aria-label`ed, keyboard-navigable.
Elevation guard clean; no over-reach (exactly the 7 intended files; backend + the
`queryByTagExpr` binding untouched). 65 tests, tsc + oxlint clean.

## Notes

- **Visual / UX polish is intentionally deferred to maintainer browser review** — the
  composer is functional, accessible, and correctness-proven, but the nested-group visual
  hierarchy / indentation, NOT-button styling, and empty-state copy weren't fine-tuned.
  One design decision made without explicit guidance: NOT as a per-node toggle (not a
  third combinator) + single-child groups collapsing in the compiled tree.
- Files: `components/filters/TagComposer.tsx`, `components/filters/TagFilterPanel.tsx`,
  `lib/tagExpr.ts`, `lib/i18n/properties.ts` (+ 3 test files). No backend / binding change.
- Branch base is current `origin/main`.
