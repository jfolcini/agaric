# Session 1092 — /batch-issues loop: de-flake the keyboard-split e2e spec (2026-06-20)

## What happened

After #1458 moved Playwright e2e onto a static `vite preview` build, the
`validate / playwright (1)` shard began failing reliably (~5 min, not the old timeout)
on unrelated backend-only PRs (#1847, #1848). A diagnosis agent traced the root cause
and the fix was validated; shipped as a standalone CI-reliability fix.

## Shipped

PR `fix/deflake-keyboard-split-spec`:

- **e2e flake** — the failing spec is `e2e/block-keyboard-fundamentals.spec.ts`
  ("Enter splits the block at the caret"), a **pre-existing caret-timing race** (added
  in #930), NOT a #1458 regression. The test built "helloworld" by typing `"world"`,
  pressing `Home`, then typing `"hello"` — but `Home` is itself a caret-move transaction
  that must commit before the next keystroke. Under the static preview build's tighter
  timing + the 2-worker shard load, the caret sometimes hadn't collapsed to offset 0 (or
  `Home` was dropped on a focus hiccup) before `"hello"` typed, producing `"worldhello"`
  → the split asserted the wrong before-caret text and the shard failed. The dev
  server's slower HMR timing had been masking the race; #1458 surfaced it.
  - **Fix:** type the whole word `"helloworld"` in one go (no mid-stream caret move to
    race), assert `toHaveText('helloworld')` as a sync point, then drive the caret to the
    split point (offset 5) by re-pressing `ArrowLeft` from `End` while polling the DOM
    selection until it is collapsed exactly at offset 5 — so the split position never
    depends on a single keystroke winning a race. The split assertion itself is unchanged.

## Evidence / validation

- Pulled the real `playwright-report-shard-1` artifact from the failing #1848 run: the
  test's `error-context.md` showed `Expected "hello" / Received "worldhello"` — the
  race signature. `git blame` confirms the spec predates #1458; pdfjs-v6-smoke (the
  preview-middleware risk) is on shard 2, ruled out. `build:e2e` ran in 31s, ~1.9 GB peak
  — no OOM/build flake.
- Reproduced the flake locally under load (`--workers=8 --repeat-each=6` → 2-3/30 fails,
  exact CI signature). With the fix: **30/30, then 50/50** under the same load, and the
  **full shard 1/3 in CI mode passed 202/202 twice**. (Two weaker fix attempts — a
  passive offset-0 poll, then a `Home`-re-press poll — still flaked 2/30; the
  single-type-plus-driven-caret version is the one that holds.)

## Notes

- Test-only change; the split assertion is unchanged — only the deterministic caret
  setup differs. File: `e2e/block-keyboard-fundamentals.spec.ts`.
- This de-flake stops the spec from reddening unrelated PRs' `playwright (1)` shard going
  forward (the two PRs it blocked, #1847/#1848, were merged via `--admin` once the flake
  was diagnosed as benign and unrelated to their BE-only diffs).
- Branch base is current `origin/main`.
