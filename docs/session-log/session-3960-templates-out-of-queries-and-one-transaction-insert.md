# Session 3960 — templates out of query results, and /template in one transaction

Two independent items in one PR, one commit each plus the review's fixes. `Closes #6548`,
`Closes #6530`.

**#6548, last box.** The question was whether an empty Advanced Query lists template placeholder
blocks on the real backend or only on the mock. It does on both: `compile_query_ctx` had no template
guard. The predicate now carries the agenda's `NOT EXISTS` on the page's `template` property, so
rows, count, aggregates and groups all leave out template pages and their blocks. The same compiled
path serves inline query blocks, saved views, a tag page's tagged items and the MCP `query` tool,
and they follow.

- A query that asks for the `template` property still sees templates; without that exception it
  would answer "none" while such blocks exist. The walker follows polarity: a negated mention
  (`Not`, `NotExists`, `Ne`) keeps the guard on. The first build did not, and listed the
  placeholders for the user who asked to hide them.
- The spec is in `e2e/`, not `e2e-tauri/` as the issue suggested: one query is something the mock
  can show failing, and a backend-authored conformance fixture pins the mock to the backend.

**#6530, last box.** No new command. `create_blocks_batch` already ran in one transaction with the
engine rollback armed; `CreateBlockSpec` gained `parent_index` (a spec's parent is an earlier spec
of the batch) and `typed_properties` (number, date, ref and boolean values). `insertTemplateBlocks`
sends one batch, depth first. A failed insert creates nothing and shows the existing toast, so the
reload after a failure is gone.

- Shapes are refused before the first write, which made the older mid-batch engine test pass with
  the rollback disabled. A new test fails a typed property of a nested spec inside the transaction
  and is the one that goes red without `arm_engine_rollback`.
- One batch carries the whole template, so `MAX_BATCH_BLOCK_IDS` now applies to the template, not
  to each level. A larger template is refused whole.
- The validator is named `validate_spec_shapes`: a "batch" in the name enrols a function in the
  bulk-equivalence inventory, which a pure shape check does not belong in.

Checks run: `cargo check` and `cargo clippy` over the workspace with all targets, the targeted
nextest filters for both items with the bindings and conformance tests, vitest for `src/lib`,
`src/hooks` and the touched component folders, typecheck, lint, the manual-stage hooks, and the
template and Advanced Query Playwright specs. Each new behaviour was shown red by breaking the code
it covers. The full Rust suite and `e2e-tauri` ran in CI only.
