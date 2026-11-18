# Session 4274 — the mock's spaces take the backend's ids

Stage 2's first slice of #6529, as the maintainer decided on 2026-11-18. The mock seeded its two spaces as `SPACE_PERSONAL` and `SPACE_WORK`, which the real backend refuses as malformed ids. On the bridge that was behind 40 of the 51 failures among the search, query and history tests run there on 14 Nov, most of them through `seedSearchBlocks`.

What changed:

- `SEED_IDS.SPACE_PERSONAL` / `SEED_IDS.SPACE_WORK` (`src/lib/tauri-mock/seed.ts`) are `00000000000000000AGAR1CPER` / `00000000000000000AGAR1CWRK`, the ids the backend's first boot makes (`agaric-engine/src/spaces.rs`). The mock seeds under them.
- Every `e2e/` literal names them through the constant, so specs written in parallel copy the constant. Inside a `page.evaluate` / `addInitScript` callback the id is passed in as an argument, because the closure does not reach the browser. A babel-parser codemod made the change and flagged those callbacks.
- `e2e/bridge.ts` checks that the vault has `SEED_IDS.SPACE_PERSONAL`, rather than finding the Personal space by name, so a backend that changed the id fails at the seed step.
- Vitest files that read the mock's seed under the old id now use the constant. Files that use `'SPACE_PERSONAL'` only as an arbitrary id of their own are left alone, as is the collation-parity test, which is about that spelling.
- `e2e/AGENTS.md` § "The real backend, through the bridge" says to use the constants, and describes #6883's per-PR hook check (the maintainer approved the edit).

Ran: the full vitest suite (1129 files pass), `npm run typecheck`, and the changed `e2e/` spec files on the mock (615 passed, 8 skipped), re-run after rebasing onto `ed8f6b1`.

Shown on the real backend, with `advanced-query-happy-paths.spec.ts` (it seeds through `seedSearchBlocks`) added to `REAL_BACKEND_SPECS` for the run only, against a locally built `bridge`: on `main`, 2 of its 3 tests fail with `malformed space id 'SPACE_PERSONAL': invalid length`; with this change all 3 pass.
