# Session 4308 — Day filters on a date-and-time key, on every surface (#6906)

This follow-up to #6905 (session 4280) covers #6906 and the two non-blocking notes agaric-reviewer left on #6905.

**The regression.** #6905 rewrote a day operand into UTC bounds for every key that any searched space declares `datetime`. So an all-spaces search for a day stopped matching the plain `YYYY-MM-DD` values of a space where the key is a `date`. The fix is a per-row rule rather than per-space scoping. A stored value in the 17-character canonical form (`length = 17`, in `value_date` or as a list item) compares against the device-local day's bounds. Every other value compares against the day as written. `filters::datetime_operand::LocalDay` builds that one `CASE` for every surface.

**#6906.** Session 4280 said the References panel's property filter and the legacy `{{query property:…}}` / `query_by_property` / `filtered_blocks_query` paths compare the stored text. That stopped being true here: they now apply the same rule, `value_date_range` included. Projection and resolver agree through the backlink parity battery. The mock and the backend-authored `property_datetime` fixture agree too.

**Note 2.** `parse_iso_date` checks the shape and then parses once. It backs `validate_date_format`, `read_datetime` and `local_day_bounds`.

**Trade.** A day `=` through `query_by_property` on a non-reserved key no longer seeks `idx_block_props_date`, because SQLite would not use the index under the `CASE`. It walks `idx_block_props_key` in id order instead. The plan test moved that shape to the walking list.

**Trap.** The builder's target directory had been hard-link-copied into another checkout, and builds there rewrote shared fingerprints. That made earlier green runs stale: the new unit tests were not even listed. Everything in the PR ran after `cargo clean -p` on every workspace member.

**What ran:**
- Rust: workspace nextest in two partitions; clippy `-D warnings`, fmt, the offline check and `ts_bindings_up_to_date`.
- Frontend: `npx vitest run src/lib/tauri-mock` and typecheck.
- e2e: `e2e/property-datetime.spec.ts`.
- Every new test was shown red first. The all-spaces test was red on the old code before any edit.
- Not run: the real-backend lane.
