# Goal

Work through REVIEW-LATER.md in manageable batches. If it's empty, generate new items via code review first.

## Phase 1 — Fix REVIEW-LATER items

### 1. PLAN

Read REVIEW-LATER.md. Group 2-4 related items into a batch (same domain: e.g., all sync items, all test gaps, all Android items). Leave the rest for future batches — don't try to clear everything at once.

### 2. BUILD

Launch build subagent(s) for the batch. Each subagent prompt must include:

- Working directory path
- `. "$HOME/.cargo/env"` for Rust subagents
- Exact files to create/modify and what to implement
- What NOT to modify
- Verification command: `cd src-tauri && cargo nextest run` for Rust, `npx vitest run` for frontend
- Do NOT paste file contents, long docs, or environment tables into subagent prompts — keep them minimal

**Worktrees:** Use `git worktree add` only when ALL three conditions are met:

- Two or more subagents running in parallel
- Each touches different files with no overlap
- Each involves 3+ file changes

Otherwise work directly in the main tree. Skip worktrees for sequential work, single-file edits, or review-only subagents.

**Sizing:** Prefer fewer, larger subagents (2-5 related tasks per subagent, same domain). Each new worktree pays ~15s cold-compile overhead. Batch trivial 1-line fixes together, or apply them directly as orchestrator.

**Subagent verification scope:** Build subagents verify only their own work by running the relevant tests. Do NOT run clippy, fmt, biome, or prek inside subagents — the orchestrator runs prek once after merging.

### 3. TEST

Every new or changed code path must have tests:

- **Rust:** happy-path + error-path tests in `#[cfg(test)] mod tests`. DB tests use `test_pool()` + `TempDir` pattern. Materializer tests use `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`. Call `settle()` between materializer-triggering operations. See `src-tauri/tests/AGENTS.md` for patterns.
- **Frontend:** render + interaction + `axe(container)` a11y audit. Use `@testing-library/react` + `userEvent`. Mock Tauri IPC with `vi.mocked(invoke)`. See `src/__tests__/AGENTS.md` for patterns.

This is non-negotiable — no code ships without tests.

### 4. REVIEW

Launch a separate review subagent for each build subagent. No self-reviews — the reviewer must be a different subagent than the builder. Reviewers check:

- **Correctness:** Does the fix actually address the REVIEW-LATER item?
- **Test coverage:** Are all branches covered? Missing edge cases?
- **UX impact:** If visual changes were made, use chrome-browser MCP to take a screenshot of http://localhost:5173 and verify. Start Vite with `npm run dev` if needed.
- **Conventions:** Does the code follow patterns in AGENTS.md (architectural invariants, code style, testing conventions)?

If a reviewer makes fixes, they must run the relevant tests to verify.

### 5. MERGE

If worktrees were used, copy changed files back to the main tree. Skip this step if no worktrees were used.

### 6. COMMIT

Stage all changes. Run `prek run --all-files` — this is the single point where formatting, linting, clippy, and all 15 hooks run. If prek modifies files (e.g., biome auto-fix), re-stage the modified files and retry the commit.

### 7. LOG

Update SESSION-LOG.md with a summary of what was done (follow the existing format — phase heading, file/change table, stats).

In REVIEW-LATER.md: remove resolved items entirely — both the summary table row AND the detail section. Update the summary count at the top and the "Previously resolved" line. Never add "Resolved" sections.

---

## Phase 2 — Generate new items (only if REVIEW-LATER is empty)

### Step A: Deep review

Pick one large feature area to review. Good candidates: sync (`sync_daemon.rs`, `sync_cert.rs`, `merge.rs`), materializer (`materializer.rs`, `cache.rs`, `fts.rs`), editor (`markdown-serializer.ts`, TipTap extensions, `BlockTree.tsx`), stores (`blocks.ts`, `navigation.ts`, `undo.ts`), or any area not recently reviewed in SESSION-LOG.md.

Launch 2-3 subagents to do a thorough code review — looking for bugs, missing error handling, test gaps, performance issues, a11y problems, UX regressions.

### Step B: Cross-validate

Launch a different set of subagents to validate findings from Step A. Their specific job:

- **Hallucinated issues** — Does the problem actually exist in the code? Read the actual source.
- **Exaggerated severity** — Is this really P1/P2, or is it P3/P4? Does it cause data loss or just a minor UX hiccup?
- **False positives** — "Missing tests" when tests exist elsewhere. "Race condition" that's prevented by the single-writer pool. "Memory leak" under 500KB.

Assign each finding a verdict: **CONFIRMED** (with accurate priority), **DOWNGRADED** (with new priority), or **REJECTED** (with reason). Only confirmed findings with accurate severity survive.

### Step C: Add to REVIEW-LATER.md

Add validated findings following the existing format:

- Summary table row: `| # | Item | Tier | Impact | Cost | Risk | Phase |`
- Detail section under the appropriate tier heading with Source, Issue/Impact, Priority, Cost, Risk
- Cost key: S = <2h, M = 2-8h, L = 8h+
- Increment the item number sequentially from the highest existing number
- Update the summary count

### Step D: Return to Phase 1

Pick a manageable batch (2-4 related items) from the newly added items and execute Phase 1.

---

## Principles throughout

- Be pragmatic but rigorous. Fix what's there, don't gold-plate, don't refactor beyond the scope of the item.
- Every commit must pass `prek run --all-files`.
- Respect architectural invariants in AGENTS.md (append-only op log, CQRS split, cursor pagination, single TipTap instance, Biome only, sqlx compile-time queries, foreign keys ON, ULID uppercase normalization).
- If a Rust change touches SQL queries, run `cargo sqlx prepare -- --lib` to update the `.sqlx/` cache.
- If a Rust change touches types used in Tauri commands, run `cd src-tauri && cargo test -- specta_tests --ignored` to regenerate `src/lib/bindings.ts`.
