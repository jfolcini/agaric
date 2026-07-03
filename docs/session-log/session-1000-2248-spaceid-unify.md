# Session 1000 — #2248 active-space unification (groups b2 + c)

Continued the #2248 arch cleanup ("active-space parameter modeled three incompatible
ways"). Group b1 (required-active FILTERS → `SpaceScope` + `require_active`) had already
landed; this session shipped the remaining two groups as two stacked PRs.

## Shipped

- **Group b2 — required-TARGET-space commands → `SpaceId` newtype** (PR #2357).
  The four commands that INSERT *into* a space (`create_page_in_space`,
  `move_blocks_to_space`, `import_markdown`, `quick_capture_block`) took a bare
  `space_id: String` at the wire boundary. Migrated each `#[tauri::command]` wrapper to the
  canonical `SpaceId` newtype + a `validate_shape()` boundary check (the lenient
  `Deserialize` only uppercases, so a malformed id is now rejected loudly instead of binding
  a never-matching filter downstream — the #1588 rationale). These are insert *targets*, not
  scope filters, so `SpaceScope` (`{kind:'global'}` is meaningless here) is deliberately NOT
  used. The internal `_inner` helpers keep taking `String`/`&str` — not the wire boundary,
  and still driven by MCP / sync-replay / tests, so ~60 test call sites stayed untouched.
  `SpaceId` serialises transparently (`type SpaceId = string`), so FE callers are unaffected;
  only the 4 generated binding types tighten from `string` → `SpaceId`.

- **Group c — `SearchFilter.space_id: Option<String>` → `scope: SpaceScope`** (PR #2358,
  stacked on #2357; `Closes #2248`). The last incompatible representation, whose semantics
  were the footgun: `Some("")` meant "match nothing", a missing key meant "all spaces".
  Replaced with `scope: SpaceScope`, mapped to the FTS layer via `SpaceScope::as_filter_param()`
  (`Active(id)` → scoped, `Global` → unscoped) — the same group-(a) mapping the already-
  `SpaceScope` commands use. Search is genuinely global-capable at the backend (the FTS suite
  exercises unscoped search over null-`space_id` fixtures), so `require_active()` was the
  wrong target — it broke ~13 `partitioned_*` tests; `as_filter_param()` preserves them.
  `SpaceScope` gained `#[derive(Default)]` with `Global` as `#[default]` so the
  `#[serde(default)]` field maps a missing key to the prior unscoped behaviour bit-for-bit.

## The leak-safety reasoning for c (the load-bearing part)

An Explore audit mapped all six FE search call sites: every one is "search within the current
space" and coalesced `currentSpaceId ?? ''`, where `''` was the pre-bootstrap / zero-space /
`list_spaces`-failure "match nothing" sentinel — reachable even when `spaceIsReady` is true
(a workspace can be ready with a null active space). The trap was collapsing `'' → Global`,
which under the new semantics flips match-nothing into match-**everything** (a cross-space
leak). Avoided on the FE:

- `searchBlocks` / `searchBlocksPartitioned` wrappers build `scope: requireActiveScope(spaceId)`,
  which **throws** on an empty id — the FE can never emit `Global`.
- Every call site now short-circuits when the space is null instead of sending `''`:
  SearchPanel gates its query on `currentSpaceId != null`; the palette/tags effects guard
  before firing; the two `useBlockResolve` suggestion callbacks (which had **no** readiness
  guard) return empty. A null space now means "don't search", never "match everything".

The MCP `search` tool wraps its required arg as `Active(SpaceId::from_trusted(..))`, preserving
its non-ULID/empty → match-nothing pass-through contract.

## Testing

- `cargo test -- specta_tests --ignored` regenerated `bindings.ts` for both PRs (compiles clean).
- `cargo nextest run` over fts / query / toggle_filter / metadata_filter / filter_builder /
  mcp::tools_ro / space / integration + the b2 command modules — all green, including
  `proptest_search_tool_matches_search_blocks_inner` (MCP↔command parity) and the `Active("")`
  "match nothing" cases (BE-9).
- `npx tsgo -b` green; affected FE vitest files (SearchPanel, useBlockResolve, tauri,
  TagsModeBody, CommandPalette, SearchSheet, searchFilterParams) all pass.

## Follow-up

- #2358 is stacked on #2357 (base = `arch/2248-b2-spaceid-targets`). Once b2 merges, retarget
  the c PR base to `main` (stacked-PR retarget lesson) so it doesn't strand off the dead
  parent branch. #2248 auto-closes when c merges.
