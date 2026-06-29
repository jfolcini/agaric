# Session 1128 — fix local-only multi-select e2e failures + add knip to CI

Follow-up to session 1127 (stacked on the clippy/knip baseline PR). Two changes.

## Local-only multi-select e2e failures → fixed

Four e2e tests failed deterministically on a local dev box but were green in CI
(`validate / playwright` shards 1–3): `batch-operations.spec.ts` (the three
Ctrl+Click multi-select cases) and `block-paste-outline.spec.ts:195`.

Root cause: the tests clicked the **center** of `[data-testid="block-static"]` to
toggle selection. Seed blocks render inline content — page links (`[[…]]`) and tag
chips — whose horizontal position depends on font metrics. On a box whose fonts
differ from CI's, the element center landed on an inner `<a>` / chip, which handles
the click itself and never reaches the block's `handleOuterClick` selection toggle —
so the second block was never added (selection count stuck at 1). Confirmed by
switching to a stable padding corner: the failing case then passes 3/3.

Fix (test-robustness only, no app change): click a stable non-interactive corner
(`position: { x: 6, y: 6 }`) for the Ctrl+Click selection in
`e2e/batch-operations.spec.ts` and the shared `ctrlSelectById` helper in
`e2e/block-paste-outline.spec.ts` + `e2e/block-dnd-parent-child.spec.ts`. Verified
the three affected specs pass 18/18 under `--repeat-each=2 --retries=0`.

## knip added to CI

The baseline sweep found `knip` had drifted **red on main** precisely because it
ran in **no CI workflow** — only the local pre-push git shim. Added a `npx knip`
step to the `lint` job in `.github/workflows/_validate.yml` (right after the
`npm-audit` pre-push step; `npm ci` there provides `node_modules`).

It invokes `npx knip` directly rather than the prek hook: the
`prek run --all-files --hook-stage pre-push knip` selector SKIPS with "no files to
check" (the hook is `pass_filenames = false` + `types`-filtered, which prek resolves
to an empty set under `--all-files`), which would be a silent false-green. The
direct call runs the hook's own `entry`. This closes the drift gap for good.
