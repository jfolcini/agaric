# Session 3030 — Settings shows how many live blocks use each property, per space (#5841 S0)

Set out to build S0 of #5841, the per-space usage count. It is read-only and needs no op or format change, so it ships ahead of S1–S4 (definitions as ops).

**Shipped:**
- **`count_property_usage(space_id)`** on the read pool. It returns the space's own definitions and the built-ins, each with how many live blocks of that space hold a value. It is one query:
  - `json_each` for the built-in keys;
  - the covering `idx_block_props_key` for `block_properties`;
  - column-backed keys (`todo_state`, `priority`, `due_date`, `scheduled_date`) counted from their `blocks` columns, because `block_properties` rejects them.
  An unknown space returns `NotFound`.
- **Settings › Properties** shows an outline badge, "N uses", on each definition. There is no badge while the counts load or after a failed load, which only warns. Counts are fetched again after a create, a delete, or a space switch.
- **A refused delete** beside a count now says that blocks in this space still use the key, and that blocks in the Trash count too. It names the per-item purge as the way out. This is the maintainer's answer 6. The refusal itself is the existing one.

**Decisions and traps:**
- **`space` and `is_space` are not counted.** `space` would just be the space's block count. `is_space` sits on the space's own block, which carries no `space_id`, so it reads 0 everywhere. Both are locked built-ins that a user never sets as values.
- **The mock treats a space as registered** if a block names it in `space_id` or is flagged `is_space`, which stands in for the `spaces` table.
- **`CONFORMANCE_UPDATE` re-serialises every fixture.** The unrelated rewrites were restored byte for byte, so only the new `query_property_usage.json` is new.
- **The SLO probe measured about 170 ms at 100K blocks in a dev build.** It is measurement-only until a `bench-slo` dispatch gives the release number.

**Tests:**
- Rust: per space, live only, column keys, a defined key with no values, an unknown space, and the space-membership keys left out.
- A conformance query step, asserted by both stacks.
- vitest for the badge, loading, failure, refetch, space switch and refusal copy.
- An e2e describe in `properties-system.spec.ts`: set a key on blocks, trash one, navigate away and back, and see the count drop.
- Each shown red with a one-command mutation.

**Suites:**
- nextest over properties, conformance and bindings (759 tests);
- clippy with `-D warnings`, the `SQLX_OFFLINE` check, and `cargo fmt`;
- vitest over properties, the mock and i18n (1,907 tests);
- typecheck, lint and the manual-stage hooks;
- Playwright: `properties-system` and `space-move-property-loss` (21).
