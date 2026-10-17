# Session 2479 — backlink Status and Priority filters match the task columns

The #5736 e2e sweep found that the References panel's Status and Priority
filters did not work. They sent `PropertyText` on a `todo` or `priority`
property key, but those values live in `blocks.todo_state` and
`blocks.priority` (migration 0012), and `block_properties` rejects a
`priority` key (0088).
- **Status** matched only a user property literally named `todo`.
- **Priority** matched nothing.
- **Both `none` options** matched everything.

**Changed:**
- **Status and Priority** send the existing `TodoState` and `Priority`
  variants.
- **`none`** is `Not(Or(...))` over the known states or levels. The backend
  compiles `Not` as `NOT COALESCE((inner), 0)`, so a block with no status or
  priority is included. A backend test already pins that.
  - The states are locked, so for Status this equals "no status".
  - For Priority, a block holding a level later removed from the options also
    counts as `none`.
- **Pill labels** read "status = TODO" and "priority = 1". The old special
  case that labelled a `todo` user property as status is gone.
- **The duplicate check** in `BacklinkFilterBuilder` now knows the
  `TodoState`, `Priority` and `Not` variants. Its fallback compared a stamp
  that differs every time, so these duplicates slipped through.
- **The mock's `applyBacklinkFilters`** now models these filters:
  - `TodoState` and `Priority`;
  - `SourcePage`, include and exclude;
  - `PropertyIsSet` and `PropertyIsEmpty`;
  - `HasTag` and `HasTagPrefix`;
  - `And`, `Or` and `Not`.

  Before, it ignored them. A new fixture, `query_backlinks_grouped_filters`,
  pins each one, with `expected` authored by the backend.

**Spec:** `e2e/references-filters.spec.ts`, run on Getting Started's
references.
- Status = TODO narrows the list.
- A source-page exclude narrows it further.
- Priority = High narrows it to one.
- The builder's Clear all keeps the source-page exclude, which is separate
  state by design.
- The popover's Clear all restores every reference.

**Shown red:**
- **The spec:**
  - with `AddFilterRow.tsx` from `main`;
  - with only the priority builder reverted;
  - with the mock ignoring an exclude.
- **The conformance test:** the old mock, and each new mock branch forced
  wrong in turn.
- **The unit tests:**
  - the old builder;
  - the missing duplicate keys;
  - the old labels.

**Left open:**
- **The real-lane spec** that testing invariant 4 asks for, since this bug
  shipped in 0.16.0. It lands with the real-lane batch for this sweep's
  shipped bugs.
- **A non-empty `And` in the mock** is not pinned by a fixture step. No
  backlink UI sends one.

**Ran:**
- the new spec with `--repeat-each=3`;
- the other references specs;
- vitest over `src/lib` and the backlink, filter and query components;
- `npm run typecheck`, oxlint and oxfmt.
