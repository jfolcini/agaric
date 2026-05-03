# PEND-02 — Rename "CQRS hybrid model" → "event sourcing with materialized views"

## Problem

What the architecture documents and code call "CQRS hybrid model" is **not actually CQRS**. True CQRS keeps the read model entirely separate and rebuilds it asynchronously from the event log. Agaric does something different and clearer:

1. Commands append to the op log AND write the primary state (`blocks`, `block_properties`, etc.) **in the same `BEGIN IMMEDIATE` transaction.** This is *event sourcing with synchronous primary-state materialization*.
2. The materializer maintains *derived caches* (FTS, tag inheritance, agenda projection, link graphs, page_id lookup) asynchronously in the background.

So the architecture is **event sourcing + materialized views** (terminology used in databases for derived projections of source data), not CQRS. The current name confuses contributors — including AI subagents reviewing the codebase, who repeatedly trip on the mismatch between the name and what the code actually does.

## Goal

Rename the canonical phrase across active documentation and code comments. Leave historical artifacts (SESSION-LOG, MILESTONES) untouched — those record what was said at the time.

## Replacement vocabulary

| Old | New |
|---|---|
| CQRS hybrid model | event sourcing with materialized views |
| CQRS materializer | materializer (maintains materialized views from the op log) |
| CQRS replay engine | event-replay engine |
| CQRS atomicity | event-log + primary-state atomicity |
| CQRS automatic-divergence gap | replay-divergence gap |
| CQRS split | event sourcing + materialized-view split |

For the ARCHITECTURE.md §5 section header: `## 5. Materializer (event sourcing + materialized views)`.

## Files to update (active docs + code comments)

**Definitely rename:**

| File | Lines | Notes |
|---|---|---|
| `AGENTS.md` | 3, 60 | Intro paragraph + invariant #2 |
| `ARCHITECTURE.md` | 17 (TOC), 396 (section header), 409, 1886, 2420 | Section header is the most visible |
| `src-tauri/tests/AGENTS.md` | 3 | Cross-link to AGENTS.md invariants |
| `PROMPT.md` | 155 | Architectural-invariants list |
| `src-tauri/src/cache/projected_agenda.rs` | 32 | Code comment citing AGENTS.md |
| `src-tauri/src/mcp/tools_ro.rs` | 5 | File-level doc comment |
| `src-tauri/src/mcp/tools_rw.rs` | 6 | File-level doc comment |

**Leave alone (historical / tone-preserving):**

| File | Reason |
|---|---|
| `SESSION-LOG.md` | 20 mentions, all in dated session entries — historical record, do not rewrite |
| `MILESTONES.md` lines 17, 29 | Historical session-summary entries |
| `COMPARISON.md` lines 281, 453 | Marketing/comparison context — `"CQRS materializer"` is a recognizable shorthand for the audience reading this doc; revisit if/when the doc is rewritten |
| `FEATURE-MAP.md` line 705 | Quotes a historical bug class ("previous CQRS automatic-divergence gap") — preserves the historical phrasing of the closed bug |

## Approach

1. One commit per logical document so the diff is readable. Suggested order:
   - Commit A: `AGENTS.md` (requires user approval per the always-on rule).
   - Commit B: `ARCHITECTURE.md` + `src-tauri/tests/AGENTS.md`.
   - Commit C: `PROMPT.md` + the three `.rs` doc-comment touch-ups.
2. After all three land, add an entry to `REVIEW-LATER.md` if any drifted code comments are discovered later (none expected — grep says we're done).
3. The pre-commit `agents-md-count-tables` hook may need to re-run; no table-count change so it should pass unchanged.

## Sample diff (AGENTS.md)

```diff
-Local-first block-based note-taking app inspired by Org-mode and Logseq. React 19 + TipTap frontend, Rust + SQLite backend via Tauri 2. Append-only op log with CQRS materializer for offline-first sync.
+Local-first block-based note-taking app inspired by Org-mode and Logseq. React 19 + TipTap frontend, Rust + SQLite backend via Tauri 2. Event sourcing + materialized views, with offline-first sync.
```

```diff
-2. **CQRS hybrid model** — commands write both the op log and primary state atomically (single `BEGIN IMMEDIATE` transaction); materializer rebuilds derived caches (FTS, tag inheritance, page-id lookup, agenda projection, link graphs)
+2. **Event sourcing + materialized views** — commands append to the op log AND write the primary state atomically in a single `BEGIN IMMEDIATE` transaction (synchronous primary-state materialization); the materializer rebuilds derived materialized views (FTS, tag inheritance, page-id lookup, agenda projection, link graphs) asynchronously in the background
```

## Cost / Impact / Risk

| | |
|---|---|
| Cost | S (~30 min total: writing the substitutions, three small commits, code review of the doc diffs) |
| Impact | Medium on contributor onboarding (the next reviewer / AI subagent / new dev no longer trips on the misnomer); zero on runtime behavior |
| Risk | Very low — text-only, three trivial commits, no runtime change |

## Testing

- `prek run --all-files` after each commit (markdown lint, link check, etc.).
- Visually verify the rendered AGENTS.md and ARCHITECTURE.md TOCs.
- No code tests needed.

## Open questions

None. Pure rename in active docs.
