# Context Management

Before starting work, compact your conversation context (`/compact`) to free up space. This keeps the context window lean and avoids slowdowns during long sessions.

# Goal

Work through REVIEW-LATER.md in manageable batches, fixing items that are already listed there.

## 1. PLAN

Read REVIEW-LATER.md. Group 3-6 related items into a batch (same domain: e.g., all sync items, all test gaps, all Android items). Leave the rest for future batches — don't try to clear everything at once.

Use **FEATURE-MAP.md** for feature discovery: when picking items to work on, consult the feature map to understand how the feature fits into the broader system (related commands, stores, components, database tables). This avoids blind spots during planning.

## 2. BUILD (parallel by default — up to 6 subagents)

Split the batch into **parallel subagents by domain/file-boundary** — e.g., one Rust subagent, one frontend subagent, or one per non-overlapping feature. Launch them all as background subagents simultaneously. Don't wait for one to finish before launching the next. **Target 5-6 concurrent subagents** whenever the batch has enough independent work to fill them. If a batch only yields 2-3 natural splits, look for further subdivisions (e.g., split a large Rust subagent into two by module, or split frontend work into component vs. store changes).

Each subagent prompt must include:

- Working directory path
- `. "$HOME/.cargo/env"` for Rust subagents
- Exact files to create/modify and what to implement
- What NOT to modify
- Verification command: `cd src-tauri && cargo nextest run` for Rust, `npx vitest run` for frontend
- Do NOT paste file contents, long docs, or environment tables into subagent prompts — keep them minimal

**While subagents build:** The orchestrator should not idle. Apply trivial 1-line fixes directly, update documentation, or pre-read source files for the next batch.

**Worktrees:** Use `git worktree add` only when parallel subagents touch **overlapping directories** and need independent git state. If subagents touch non-overlapping files, they can safely work in the main tree without worktrees. Skip worktrees for sequential work, single-file edits, or review-only subagents.

**Sizing:** Prefer 5-6 focused parallel subagents grouped by domain over fewer sequential ones — you can safely run up to 6 subagents simultaneously. Split work so each subagent touches non-overlapping files. Each worktree pays ~15s cold-compile overhead, but that's recouped if the parallel wall-clock time is shorter. Batch trivial 1-line fixes together and apply them as orchestrator (in parallel with subagent work). Don't serialize work that can be parallelized — launch all build subagents at once.

**Subagent verification scope:** Build subagents verify only their own work by running the relevant tests. Do NOT run clippy, fmt, biome, or prek inside subagents — the orchestrator runs prek once after merging.

## 3. TEST

Every new or changed code path must have tests:

- **Rust:** happy-path + error-path tests in `#[cfg(test)] mod tests`. DB tests use `test_pool()` + `TempDir` pattern. Materializer tests use `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`. Call `settle()` between materializer-triggering operations. See `src-tauri/tests/AGENTS.md` for patterns.
- **Frontend:** render + interaction + `axe(container)` a11y audit. Use `@testing-library/react` + `userEvent`. Mock Tauri IPC with `vi.mocked(invoke)`. See `src/__tests__/AGENTS.md` for patterns.

This is non-negotiable — no code ships without tests.

## 4. REVIEW (pipelined with BUILD)

**Don't wait for all builds to finish.** As each build subagent completes, immediately launch its review subagent while remaining builds continue. If multiple builds finish close together, launch all their review subagents in parallel. You can have build and review subagents running simultaneously — e.g., 3 builds still running + 3 reviews already launched is fine (up to 6 total active subagents).

No self-reviews — the reviewer must be a different subagent than the builder.

**Launch two review dimensions in parallel** when a change has both code and user-facing impact:

- **Technical reviewer** checks:
  - **Correctness:** Does the fix actually address the REVIEW-LATER item?
  - **Test coverage:** Are all branches covered? Missing edge cases?
  - **Conventions:** Does the code follow patterns in AGENTS.md (architectural invariants, code style, testing conventions)?
  - **Architectural stability:** Does the change stay within existing abstractions? See AGENTS.md "Architectural Stability" section.

- **UX reviewer** checks:
  - **Discoverability:** Can the user find and use this feature without documentation?
  - **Consistency:** Does the interaction pattern match existing similar features?
  - **Mobile parity:** Does the feature work on touch devices?
  - **Visual coherence:** If visual changes were made, use chrome-browser MCP to take a screenshot of http://localhost:5173 and verify. Start Vite with `npm run dev` if needed.
  - **Edge cases:** Empty states, long values, truncation, keyboard navigation.

For backend-only changes, the UX reviewer is unnecessary. For frontend changes with no user-facing impact (e.g., test-only), skip the UX reviewer too.

If a reviewer makes fixes, they must run the relevant tests to verify.

## 5. MERGE

If worktrees were used, copy changed files back to the main tree. Skip this step if no worktrees were used.

## 6. COMMIT

Stage all changes. Run `prek run --all-files` — this is the single point where formatting, linting, clippy, and all 15 hooks run. If prek modifies files (e.g., biome auto-fix), re-stage the modified files and retry the commit.

## 7. LOG

Update SESSION-LOG.md with a summary of what was done (follow the existing format — phase heading, file/change table, stats).

In REVIEW-LATER.md: remove resolved items entirely — both the summary table row AND the detail section. Update the summary count at the top and the "Previously resolved" line. Never add "Resolved" sections.

**Keep FEATURE-MAP.md in sync:** If the session added new commands, components, hooks, stores, database tables, or other user-facing features, update the relevant section of FEATURE-MAP.md. Also update the deferred features list (section 22) when REVIEW-LATER items are added or resolved.

**Concurrent edits to REVIEW-LATER.md:** Other agents may be working on REVIEW-LATER.md at the same time (resolving items, adding new ones, updating counts). Before writing to the file, always re-read it first to get the latest content. Never cache or assume stale state. If you read the file, make edits in memory, and then write — re-read immediately before writing to avoid overwriting another agent's changes.

---

## Principles

- Be pragmatic but rigorous. Fix what's there, don't gold-plate, don't refactor beyond the scope of the item.
- Every commit must pass `prek run --all-files`.
- Respect architectural invariants in AGENTS.md (append-only op log, CQRS split, cursor pagination, single TipTap instance, Biome only, sqlx compile-time queries, foreign keys ON, ULID uppercase normalization).
- If a Rust change touches SQL queries, run `cargo sqlx prepare -- --lib` to update the `.sqlx/` cache.
- If a Rust change touches types used in Tauri commands, run `cd src-tauri && cargo test -- specta_tests --ignored` to regenerate `src/lib/bindings.ts`.
