# Session 2665 — AGENTS.md's command block lists the e2e and CI-only commands a change needs before a push

The maintainer asked, after a markup change broke a real-backend spec that no
local run had selected (#5945), for AGENTS.md to point at `just e2e-related`
and the other commands an agent should always use. The maintainer approved the
edit.

- **Build Commands** gains `just e2e-related --range origin/main...HEAD` (run
  its selections before a push), `just e2e-real e2e-tauri/<file>.e2e.ts` (one
  real-backend spec), `PW_PORT=<port>` on the Playwright line (one port per
  worktree, or `reuseExistingServer` tests another worktree's or an older
  bundle), and `prek run --hook-stage manual --all-files` (the CI-only hooks
  the lint job runs; a dynamic-SQL baseline miss reached CI tonight because
  the pre-commit stage skips them).
- **Pre-push** names what the verify does not run: WebdriverIO and the
  manual-stage hooks join Playwright on that list.
- **Running tests efficiently** keeps the area-tag rule and says once what
  `just e2e-related` does with it, instead of repeating the command.
