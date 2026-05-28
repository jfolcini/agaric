# Context Management

Before starting work, compact your conversation context (`/compact`) to free up space. This keeps the context window lean and avoids slowdowns during long sessions.

# Goal

Work through planned tasks in manageable batches, fixing items already scoped on GitHub or in `pending/`.

**Where the work lives:**

- **GitHub issues with the [`plan` label](https://github.com/jfolcini/agaric/issues?q=is%3Aissue+is%3Aopen+label%3Aplan)** — one issue per major plan (the former `pending/PEND-NN-*.md` files, migrated 2026-05-27). The issue body is the full plan; comments are reviewer corrections + status updates. The curated recommended order lives in `pending/README.md`.
- **All other open GitHub issues** — anything in [the open issues list](https://github.com/jfolcini/agaric/issues?q=is%3Aissue+is%3Aopen) that **doesn't** carry the `plan` label: bug reports, small feature requests, UX polish, regressions, doc fixes, etc. These are typically narrower than a `plan` issue (no multi-phase scope, no Open Qs section). Treat each one as a self-contained ticket and ship it as its own PR.
- **GitHub code-scanning + security alerts** — CodeQL findings and Dependabot security alerts are first-class work items. Query them via the GitHub API (the `/security/*` UI tabs are auth-gated and not link-checkable from CI): `gh api /repos/jfolcini/agaric/code-scanning/alerts?state=open` (CodeQL) and `gh api /repos/jfolcini/agaric/dependabot/alerts?state=open` (Dependabot). CodeQL findings often surface real correctness bugs *or* false positives caused by stale code; either way the resolution is concrete (fix or dismiss-with-reason). Dependabot security alerts that can be resolved by bumping a dep are quick wins.
- **`pending/REVIEW-LATER.md`** — multi-item backlog of CR-* / OSSF-* / PERF-* / MAINT-* small tickets that don't warrant their own issue.
- **`pending/IDEAS.md`** — long-running idea backlog (not work-plan tickets).

## 1. PLAN

Pick **one** of:

- A single `plan`-labelled GitHub issue (each issue is a self-contained plan; group its internal sub-items into a 3-6 item batch), **or**
- A single non-`plan`-labelled GitHub issue (typically narrower scope; ship as its own PR), **or**
- A single open code-scanning / Dependabot security alert (resolve or dismiss-with-reason), **or**
- 3-6 related items from `pending/REVIEW-LATER.md` (same domain: e.g., all sync items, all test gaps, all Android items).

Leave the rest for future batches — don't try to clear everything at once.

**Before starting a `plan` issue:** read its body in full and verify all "Open Qs" sections have been resolved (look for answers in the issue's comments). If any Q is still open, surface it to the maintainer and stop — do not guess.

**Before starting a non-`plan` issue:** scan its comment thread for any maintainer-supplied scope clarifications or acceptance criteria before coding. If the issue body is ambiguous *and* no clarifying comment exists, surface the ambiguity to the maintainer and stop — do not guess at intent.

**Before resolving a code-scanning alert:** check whether the flagged behaviour is real or a false positive caused by surrounding context (a mocked type, a test-only stub, an unreachable branch). A real bug warrants a code fix; a false positive warrants a CodeQL `# nosemgrep` / `// codeql[js/...]: ignore — <reason>` dismissal comment OR a structural change to the surrounding code that removes the trigger entirely. Don't suppress without a comment that says *why*.

Use **docs/FEATURE-MAP.md** for feature discovery: when picking items to work on, consult the feature map to understand how the feature fits into the broader system (related commands, stores, components, database tables). This avoids blind spots during planning.

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

**Subagent verification scope:** Build subagents verify only their own work by running the relevant tests. Do NOT run clippy, fmt, biome, or prek inside subagents — prek runs automatically via the pre-commit / pre-push git hooks at commit and push time.

### Subagent prompt template

```text
**Task:** [one-line description]
**Working directory:** `/home/javier/dev/agaric`
**Setup:** `. "$HOME/.cargo/env"`  (Rust subagents only)
**Files to create/modify:**
- `path/to/file.ext` — [what to do]
**Do NOT modify:**
- AGENTS.md (root)
- Files outside this subagent's scope
**Verification:**
- Rust: `cd src-tauri && cargo nextest run`
- Frontend: `npx vitest run`
**Success criteria:**
- All tests pass
- Code follows AGENTS.md patterns
- No new compiler warnings
```

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

Stage all changes and commit normally — the **pre-commit hook** runs prek's commit-staged checks (formatting, linting, biome, fast clippy, conventional commit message, etc.). If a hook modifies files (e.g., biome auto-fix), re-stage the modified files and retry the commit.

Push when you're ready — the **pre-push hook** runs prek's heavier checks (full clippy, the `no-commit-to-branch=main` guard, any `stages = ["pre-push"]` hooks in `prek.toml`).

Do NOT run `prek run --all-files` manually. The hooks are the single source of truth for what runs and when; invoking prek by hand bypasses staging boundaries and runs checks that the hook layout deliberately defers to push-time. If a hook is failing, fix the underlying issue and let the hook re-run on the next commit/push — don't paper over it by skipping (`--no-verify`).

## 7. LOG

Update SESSION-LOG.md with a summary of what was done (follow the existing format — phase heading, file/change table, stats).

**For `plan`-labelled GitHub issues:**
- If the session fully resolves a plan, the commit message must include `Closes #NN` (GitHub auto-closes the issue when the commit lands on `main`).
- If the session resolves part of a plan, post a status comment on the issue summarizing what shipped and what remains — don't close it.
- Reviewer corrections that surface during the session belong as comments on the issue, not edits to the body.

**For REVIEW-LATER.md:** remove resolved items entirely — both the summary table row AND the detail section. Update the summary count at the top and the "Previously resolved" line. Never add "Resolved" sections.

**Keep docs/FEATURE-MAP.md in sync:** If the session added new commands, components, hooks, stores, database tables, or other user-facing features, update the relevant section of docs/FEATURE-MAP.md. Also update the deferred features list (section 22) when REVIEW-LATER items are added or resolved.

**Concurrent edits to REVIEW-LATER.md / IDEAS.md / pending/README.md:** Other agents may be editing these at the same time. Before writing, always re-read first to get the latest content. Never cache or assume stale state. If you read the file, make edits in memory, and then write — re-read immediately before writing to avoid overwriting another agent's changes. (GitHub issues don't have this race: GitHub serializes comment writes, and the issue body is rarely edited.)

### Session log entry template

Every session entry follows this shape:

```text
## Session N — <short title> (YYYY-MM-DD)

| Metadata | Value |
|----------|-------|
| **Date** | YYYY-MM-DD |
| **Subagents** | <count> build + <count> review (or "orchestrator-only") |
| **Items closed** | <ID list — issue `#NN` for plans, or REVIEW-LATER IDs (CR-*, PERF-*, etc.), or "—"> |
| **Items modified** | <ID list, or "—"> |
| **Tests added** | +N (frontend) / +M (backend) |
| **Files touched** | <count> |

**Summary:** <2-3 sentence high-level outcome>

**REVIEW-LATER impact:**
- **Top-level open count:** X → Y (<delta breakdown>)
- **Previously resolved:** A+ → B+ across S → S+1 sessions

**Files touched (this session):**
- `path/to/file.ext` (LOC delta)
- ...

**Verification:**
- `cd src-tauri && cargo nextest run` — N tests run, N passed.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:** <optional, only when worth capturing>

**Lessons learned (for future sessions):** <optional, only when applicable>

**Commit plan:** single commit / split / not pushed / pushed.

---
```

Apply this template to NEW sessions. Older sessions (590-597 included) stay as-is unless an explicit catchup pass is requested.

---

## Principles

- Be pragmatic but rigorous. Fix what's there, don't gold-plate, don't refactor beyond the scope of the item.
- Every commit must pass the prek pre-commit hook; every push must pass the prek pre-push hook. Both run automatically — never invoke `prek run --all-files` manually, and never bypass with `--no-verify`.
- Respect architectural invariants in AGENTS.md (append-only op log, event sourcing + materialized views, cursor pagination, single TipTap instance, Biome only, sqlx compile-time queries, foreign keys ON, ULID uppercase normalization).
- If a Rust change touches SQL queries, run `cargo sqlx prepare -- --tests` to update the `.sqlx/` cache.
- If a Rust change touches types used in Tauri commands, run `cd src-tauri && cargo test -- specta_tests --ignored` to regenerate `src/lib/bindings.ts`.

## Common Pitfalls

- **Serializing parallelizable work** — if 4 subagents have independent file targets, launch all 4 in one batch; don't queue them.
- **Running prek manually or inside subagents** — subagents only run their own targeted tests. Prek runs solely via the pre-commit and pre-push git hooks at commit and push time; never invoke `prek run --all-files` by hand (it bypasses the stage split and runs push-deferred checks too early).
- **Forgetting to re-read REVIEW-LATER.md before writing** — other agents may concurrently edit it. Always re-read immediately before write.
- **Starting a `plan` issue with unresolved Open Qs** — every plan issue has a section at the bottom listing maintainer decisions. If any are still open, surface them and stop. Subagents will silently guess and produce wrong scope.
- **Closing a plan issue from a partial fix** — only use `Closes #NN` when the full plan ships. Otherwise comment-update the issue and leave it open.
- **Forgetting docs/FEATURE-MAP.md updates** — new commands / components / hooks / stores / tables must be reflected in the feature map.
- **Mixing refactoring with feature work in one commit** — keep them separate so reverts stay surgical.
- **Subagent prompts that paste long doc contents inline** — keep prompts minimal; reference paths instead.
- **Kitchen-sink refactors handed to subagents** — refactors that touch >10 consumer call sites or require coordinated edits across many test fixtures (prop-drill cleanups, hook-extraction sweeps, IPC-wrapper migrations, etc.) have repeatedly stalled or silent-failed when delegated to subagents (sessions 555 / 557 / 558 → orchestrator-direct close in 559 / 560). For this class of work: either (a) run it orchestrator-direct, or (b) split it explicitly by file boundary into 3-6 narrow subagents where each owns ≤6 files and has no cross-cutting test dependency. Do not hand "refactor X across the codebase" to a single subagent.
- **Merging chained PRs out of order strands commits on orphan branches** — when PR-B is opened against PR-A's branch (chained), GitHub's "Merge pull request" on PR-B merges *into PR-A's branch*, not into `main`. If PR-A has already merged to `main` by then, PR-B's merge lands on the now-orphan PR-A branch and **never reaches main** (the merge commit exists, the PR shows MERGED, but `main` doesn't see the content). Mitigation: merge the chain bottom-up (oldest first) without skipping levels, or — if a later chained PR already shows MERGED but its content is missing from main — recover by rebasing the next-still-open chained branch onto `main` directly with `git rebase origin/main` (rebase drops the duplicate already-on-main commits and keeps the unique ones), force-push, then edit that PR's base to `main` via `gh api /repos/<owner>/<repo>/pulls/<N> -X PATCH -f base=main`. Session 843 hit this and recovered. The `gh pr edit --base` path is unreliable (GraphQL deprecation warning silently swallows the change) — use the REST PATCH instead.
