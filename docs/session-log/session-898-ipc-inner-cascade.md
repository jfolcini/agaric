## Session 898 — #107: full BlockId/PageId cascade through core block helpers (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 1 build (orchestrator-verified) |
| **Items closed** | — (Refs #107; closes the deep `_inner` propagation) |
| **Items modified** | `#107` |
| **Tests added** | +0 (call-site arg types only; assertions unchanged) |
| **Files touched** | 37 |

**Summary:** Per the maintainer's "full propagation" choice for #107, converted the **core block
`_inner` helpers** and all their callers codebase-wide to the `BlockId`/`PageId` newtypes (~390 call
sites). Signatures changed: `create_block_inner`/`create_block_inner_with_space` (`parent_id`→`Option<BlockId>`),
`edit/delete/restore/purge_block_inner` (`block_id`→`BlockId`), the `*_by_ids`/`move_blocks_to_space`
batch fns (`Vec<String>`→`Vec<BlockId>`), `move_block_inner` (`block_id`/`new_parent_id`), the
`blocks/queries.rs` read helpers, `CreateBlockSpec.parent_id`, and all matching `#[tauri::command]`
wrappers (now pass the newtype straight through — no shim). Redundant in-body `.to_ascii_uppercase()`
removed from every converted helper (the newtype normalizes on construction). Callers fixed with the
compiler-driven idioms (`.into()`, drop `.into_string()`, `.map(Into::into)`, `.as_str()` for binds).

**Left `String` (out of scope / separate):** `space_id` (SpaceId concern), `tag_id`, `block_type`,
`content`/`to_text`, the lower-level `create_block_in_tx`/`create_page_in_space_inner` (converted at
the call boundary), and Serialize-only response structs (`DeleteResponse` etc.). The remaining
**command-param boundary** in `properties/history/queries/pages` is now a trivial follow-up — those
`_inner` already take `BlockId`, so converting their wrappers needs no further cascade.

**Verification:**
- `SQLX_OFFLINE=true cargo check --all-targets` — **0 errors** (peaked at 485 mid-cascade; benches incl.).
- `cargo nextest run` — **4067 passed** (1 known sync_files timing flake passed on retry; 6 skipped).
- `bindings.ts` regenerated (command params → `BlockId`/`PageId`; wire-identical = string). No `.sqlx` change (param types don't alter query text; offline build clean).
- Normalization-sensitive tests still pass uppercase ULIDs through the newtype's normalizing constructors; no assertions changed.

**Process notes:** Mechanical, `cargo check --all-targets`-driven cascade (resumable: the error count
only shrinks, so an interrupted pass is continued by the next). A prior attempt died on a transient
500 mid-cascade; this run completed. Verified all-targets (not just `--tests`) so benches compile.

**Commit plan:** single commit (checkpoint of the verified-green state), then targeted review of the
production (non-test) diff, push from main tree, PR (Refs #107).
