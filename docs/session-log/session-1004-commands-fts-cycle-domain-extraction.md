# Session 1004 — arch: break the commands⇄fts module cycle (#642)

Continuation of the arch focus (maintainer: "focus on arch"). Single-issue PR,
adversarially reviewed.

## Shipped

- **`refactor(domain)` #642** — the IPC `commands/` layer doubled as the domain/type
  home, so lower layers depended upward: `fts/*` imported `SearchBlockRow`/`SearchFilter`/
  `MatchOffset`/`NamedDateRange`/`SearchPropertyFilter` from `crate::commands`, while
  `commands/` imports `fts` — a module-level **commands ⇄ fts cycle**. `recurrence/compute.rs`
  also imported tx-helpers upward.

  **Fix:** new neutral `src-tauri/src/domain/` module (a true lower layer — imports neither
  `commands` nor `fts`):
  - `domain/search_types.rs` — the moved search row/filter types (+ `DateFilter`/`DateOp`
    that `SearchFilter` embeds and `fts` uses). Verbatim moves; re-exported from
    `commands::queries` so command-internal callers + tauri-specta bindings don't churn,
    while `fts/*` repoint to `crate::domain::search_types` — which is what actually breaks
    the cycle.
  - `domain/block_ops.rs` — the pure `is_valid_iso_date` / `validate_date_format`;
    `recurrence/compute.rs` now imports these from `domain`.

  **Reviewer-verified:** all 8 moved types byte-identical to `main` (every field, derive,
  serde rename, `DateOp::as_sql`) → zero wire-shape drift, `src/lib/bindings.ts` untouched.
  `grep` proofs: no `fts/*` or `recurrence/*` source imports a moved type from
  `crate::commands`; `domain/` imports neither `commands` nor `fts`. 1319 tests pass,
  `cargo check --all-targets` + clippy clean.

## Scope — partial vs the issue, deliberately

`create_block_in_tx` / `set_property_in_tx` stayed in `commands/blocks/crud.rs`: despite the
`_in_tx` names they are the **command cores** (build OpPayloads, append to op_log, call
command-local validators, use the `ancestors_cte_standard!` macro + the materializer
pages-cache path) — not pure tx+row helpers, so moving them is a high-ripple change with no
extra cycle-break benefit. `recurrence` keeps that one function-core edge (documented
`TODO(#642 follow-up)`). The headline **commands⇄fts cycle is fully broken**; the residual
tx-core extraction is carved to **#882**. PR is `Refs #642` (not Closes) with a re-scope
comment.

## Phase 9 arch status after this session

MERGED: #644 (db/op_log #870, materializer #871), #664 (#878), #751 (#879), #643 (#881),
design #743/#744/#745 (#876). This PR (#642) open. DEFERRED for maintainer: #645 (core-crate
carve-out), #644 loro/engine + commands/pages slices. Follow-ups filed: #877, #880 (fixed),
#882.
