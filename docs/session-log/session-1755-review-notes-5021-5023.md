# Session 1755 — the notes from three merged PRs, batched

Non-blocking review notes from #5021, #5022 and #5023, collected at the sweep
boundary as AGENTS.md prescribes: merge the approved PR as it stands, then act
on its notes once, across the PRs merged together. Five of the eight are here;
the other three are recorded below with why they are not.

## Two sources for one number

`run_grouped` computed `key_pos + usize::from(key_bind.is_some())` and passed it
into `fetch_group_buckets`, while `fetch_member_preview` computed the identical
expression inline as `in_start`. Same number, two derivations, one parameter
apart.

`fetch_group_buckets` now derives it from the `GroupKeySql` it already receives,
so both helpers read the slot the same way and the parameter is gone. The
comment on it names the reason, because this is precisely the divergence class
the file's own bind-order test exists to catch — the same shape as #5023's
`has_fulltext`, which was a field that had to agree with `match_sanitized`.

Falsified: drop the key's own slot from the derivation and five tests red,
`group_by_property_with_aggregates_binds_key_before_aggregates` among them —
the test #5021 added for exactly this class. Restored and `cmp`-verified.

## Three clones the owned field made redundant

`QueryCtx::space_id` was `&'a str` until #5023 made it owned. The grouped path's
three `ctx.space_id.to_string()` binds were required then and are not now; the
flat path already binds by reference. Three fewer `String` allocations per
grouped query, and the two paths now read the same.

This is the tail of a change rather than a defect in it: making the field owned
is what turned a necessary clone into a redundant one.

## Comments that outlived their subject

- `GroupKeySql`'s doc said "the four of them" agree on the key. Three statements
  consume it (`grouped_total_count`, `fetch_group_buckets`,
  `fetch_member_preview`).
- `global_aggregates`' doc still opened "for a **grouped** request" — the rename
  happened *because* it was never grouped-only, and the flat path calls it. Its
  closing line said "the group-page numbering is untouched", which is now
  whichever numbering the caller is spending.
- `SNAPSHOT_OPS_INERT` gained a ~14-line preamble in #5022 re-arguing what the
  entry's own reason string says, and the map already forces a reason per entry.
  The entry plus its string is the whole rule; the archaeology is deleted and
  the string absorbed the one clause it was missing.

## Not done, and why

- **`scripts/test-related-rust.sh` cannot map `src-tauri/tests/**`.** Real, and
  it cost a CI cycle on #5022: a change confined to the conformance harness
  selects ZERO Rust tests at push time. The mirror case cost another on #5023 —
  a Rust-only change skips vitest entirely, so a TS guard that greps `engine.rs`
  never runs. Both directions are invisible to a *range-scoped* selector. But
  neither is silent: the #3220 guard prints the unmapped files by name and says
  to run the workspace suite by hand. Mapping `src-tauri/tests/**` to
  `package(agaric)` would pull ~3000 tests into every harness push, which is a
  trade worth making deliberately rather than inside a notes batch.
- **`PROPERTY_DEF_ATTRS` placement.** The reviewer said it reads fine either
  way; nothing to fix.
- **Issue #4639's acceptance criterion is unachievable as written.** Checked,
  and it is worse than a stale count. The issue names

  ```sh
  rg -n 'expect\(clippy::too_many_lines' src-tauri --glob '*.rs'
  ```

  as authoritative and says "Done when: the grep returns nothing". It cannot:
  `commands/history.rs:2785` mentions the attribute inside a doc comment, added
  by #4746 *after* the issue was written, so the sweep can never satisfy its own
  test. The anchored form (`^[[:space:]]*#\[expect(...`) is what this session
  used and is recorded in session-1754 and #5023's body. Raised on the issue
  rather than edited into it — the acceptance criterion is the author's to set.
