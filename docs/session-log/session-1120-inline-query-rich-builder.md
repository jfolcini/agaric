# Session 1120 — rich nested builder + structured payload for inline queries (P2)

Continued the inline-query unification plan (P2). The prior session shipped the
prerequisite — a `FilterExpr` interpreter in the tauri-mock's `run_advanced_query`
(#1957). This session delivers the user-facing P2 win: inline `{{query}}` blocks
can now express the full engine vocabulary (OR / NOT / nested groups / date
ranges / contains) via the nested builder, executed through the rich engine.

## Scope decision (vs. the literal plan)

The original Stage A ("retroactively reroute every legacy `{{query}}` text block
through the rich engine") was dropped: it forces a large, error-prone rewrite of
the IPC-mocking `QueryResult`/`useQueryExecution` tests for **zero user-visible
benefit** (those blocks already work), plus real back-compat risk. The user value
(rich inline queries) comes entirely from authoring NEW queries with the nested
builder. So the design is **dual-read, back-compat-safe**:

- **Legacy text blocks** (`{{query tag:work}}`, `property:k=v`, `type:backlinks …`)
  keep the existing `parseQueryExpression` + legacy dispatch path, UNCHANGED.
- **New structured blocks** carry a versioned payload and run through the rich
  engine.

## What shipped

1. **`inline-query-spec.ts`** — the structured payload `{{query v2:<base64url(JSON)>}}`
   carrying `{ filter: FilterExpr, table }`. base64url (`A–Z a–z 0–9 - _`) is
   chosen so the payload survives the markdown serializer's escape set
   (`\ * ` ~ = [ ] #`) verbatim — raw JSON's `[` `]` would be escaped. `decode`
   returns `null` for any non-`v2:` (legacy/corrupt) payload, so legacy blocks are
   never hijacked.
2. **Execution** (`useQueryExecution`) — a `v2:` payload decodes and runs through
   `run_advanced_query` (`fetchRichInlineQuery`); everything else keeps the legacy
   dispatch. The hook's external contract is unchanged, so `QueryResult` and the
   hook-mocking tests are untouched.
3. **Authoring** (`QueryBuilderModal`) — a new **Advanced** mode reuses the
   AdvancedQuery nested `FilterGroup` builder (local builder state via the
   exported pure tree-edit fns; the modal edits one block, so it does not touch
   the per-space store). Save emits the `v2:` payload. The simple 3-type form is
   unchanged and still emits legacy text. Editing a `v2:` block opens straight
   into Advanced mode with its tree rehydrated.
4. **Rendering** (`QueryResult`) — decodes the payload for table mode and renders
   an "Advanced query · N conditions" badge (the base64 payload is opaque).

## Verification

- All existing simple-mode / legacy tests pass UNCHANGED (117 execution + 81
  QueryResult + 41 modal). New unit tests cover v2 round-trip / back-compat /
  markdown-safety, v2 routing, advanced-mode authoring, and v2 rendering.
- `e2e/query-blocks.spec.ts`: the 13 legacy cases pass unchanged (the back-compat
  oracle), plus a new case that types a `v2:` block and asserts it renders via the
  rich engine. Broad vitest sweep (4960 tests) green; `tsgo` clean.

## Follow-ups (not in this PR)

- A richer Advanced-mode pills summary (currently a single labelled badge).
- Optional: open a faithfully-translatable LEGACY block directly into the Advanced
  builder (an upgrade path) — deliberately deferred to keep legacy-edit behavior
  and its tests stable.
