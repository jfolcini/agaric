# Session 4221 — the frontend mutation-survivor tracker (#4691)

Worked the 15 no-coverage mutants and 36 survivors #4691 tracked from scheduled-deep-checks run 43718156458, no-coverage first. The Rust tracker went in its own PR.

## What shipped

- **Kills.** `vaultRestoreSpaces` gets tests for a space file that is not JSON (named by its folder, and logged), a one-letter space folder, and a top-level file named as a space folder is but for one more letter. `tokenize` gets its first `parenClose` test. `serialize` gets tests that `removeFilterAt` and `addFilter` leave the tree their own text parses to, and two canonical forms. Read aloud logs a refused `stop_speaking` and still speaks the next reading. A refused page-mode batch is logged with its count. A PDF highlight draws its place chip in page mode, though its properties are internal. `mergedTree` of a childless block keeps the positions a delete left.
- **Dead code deleted.** `assetName`'s `|| 'attachment'`: `sanitizeSegment` never returns empty, it returns `Untitled`. `withoutIndex`'s empty-children return: a parsed or added node has two children or more. `classifyWord`'s `if (tag) return tag`: a `#` word is never an unknown `key:`, so it falls through to the same null.
- **Equivalents** recorded in `mutation-accepted.tsv`, each with its reason: mostly `?.` that only TypeScript's indexed and Map types need, plus `atPath`'s option object, which nothing reads.

## Decisions and traps

- **Baseline on fresh `main`.** The clone's `origin/main` was a dozen commits behind the sweep, and `vault-import` read 84 mutants there against the tracker's 9. Fetch before measuring.
- **Edits leak into a running Stryker batch:** each module copies the tree when it starts. Run "before" baselines in a clean worktree.
- **Run Stryker batches with a long background limit.** A batch killed at the default 30 minutes leaves its modules unmeasured.
- Survivors off the tracker were left for the next sweep: two in `vault-import` that came in with commits after it, one in `inline-property-parse` it listed as resolved, and one in `page-tasks` (`unwatch`) that timed out in the baseline and survived in the after-run, so the load on this machine decides it. The load also turned page-tasks' two tracked mutants into baseline timeouts. Its kill was shown red by hand.

## What ran

- `node scripts/run-mutation.mjs` before (clean worktree at `main`) and after, on every tracked module.
- vitest over every touched test file; typecheck; oxlint.
- The `mergedTree` kill was also shown red by hand.
