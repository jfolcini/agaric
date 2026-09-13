# Session 1747 — pin the #1556 window-cap resume rank

`be_a10_post_filter_max_windows_bound_stops_without_hanging` asserted that the
window-cap truncation path hands back `next_cursor.is_some()`. It never looked
at what was in the cursor, and never followed it. So the branch's whole reason
for existing — *resume past the ceiling so the caller can page further* — was
unpinned, and a cursor carrying a wrong rank passed the test.

## The gap, demonstrated rather than argued

`post_filtered_page_from_scan`'s `truncated_by_window_cap` arm builds
`Cursor::for_id_and_rank(cursor_id, cursor_rank)`. Replacing `cursor_rank` with
`0.0` and running the **whole crate** against the old test:

```
Summary [ 52.643s] 1443 tests run: 1443 passed, 3 skipped
```

1443 of 1443 green with the resume rank zeroed. Not a hypothesis about a
coverage hole — the hole, measured.

This is the half-covered-pair shape `AGENTS.md` names: `has_more` and
`next_cursor` are a symmetric pair, and the test pinned the existence of one
while leaving the value that makes it useful open.

## What now pins it

The fixture already builds 1050 rows with the lone `"Cat"` survivor at index
1040, past the 1000-candidate ceiling (`POST_FILTER_WINDOW` 100 ×
`POST_FILTER_MAX_WINDOWS` 10), so the first page legitimately returns nothing.
The extension follows the returned cursor and requires the second page to reach
the row the first page could not:

- `resumed.items.len() == 1`
- `resumed.items[0].id == pt_block_id(1040)`
- `!resumed.has_more` — the resumed scan covers the remaining ~50 rows and
  genuinely exhausts

Asserting reachability rather than the cursor's internals is deliberate. It pins
the property #1556 actually cares about and the existing comment already claims,
and it stays true if the cursor encoding ever changes.

## Falsification

Against a copy (`cp` to the scratchpad, mutate, run, restore, confirm no diff vs
`HEAD`):

| mutant | result |
|---|---|
| `truncated_by_window_cap` cursor built with rank `0.0` | **killed** — `left: 0, right: 1`, "resuming past the window cap must reach the lone survivor (#1556)" |

The kill message is the point: the zeroed rank sent the resumed scan back to the
start, it hit the same ceiling, and returned an empty page — precisely the
"caller pages forever" failure the branch exists to prevent.

`post_filter.rs` was confirmed byte-identical to `HEAD` afterwards, so no stub
survived the run (#4287, #4018, #4204).

## Verification

- `cargo nextest run -p agaric-store`: `1443 tests run: 1443 passed, 3 skipped`
- `cargo clippy -p agaric-store --all-targets -- -D warnings`: clean

Scoped to `-p agaric-store` on purpose. `AGENTS.md` is right that `-p` does not
compile dependents and so proves nothing about consumers — but this change is
test-only code inside that crate's own `#[cfg(test)]` module, with no signature
touched, so there is no consumer to break. The full workspace run is CI's.

Builds used `CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0`. That is not
cosmetic here: `src-tauri/target` was deleted earlier in this session to recover
an exhausted disk allowance, and a full-debug workspace target had been ~23G
against ~18G free. Dropping debug info brought the whole agaric-store tree to
6.4G, which is what made falsifying this affordable at all rather than deferring
it again.
