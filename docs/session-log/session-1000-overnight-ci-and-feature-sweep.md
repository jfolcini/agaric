# Session 1000 — overnight CI-flake fix + advanced-query / editor / mobile feature sweep

Long autonomous `/loop /batch-issues` run (2026-06-17 evening → 2026-06-18 ~03:00 CET).
Maintainer steer for the night: big refactors first, **auto-merge own greens**, ask
questions upfront, parallelize aggressively. Builder + adversarial reviewer per item,
worktree-isolated, pipelined against CI.

## PR-review reconciliation (start of night)

- **#1459** (nested AND/OR/NOT filter groups, #1280): fixed the bot's CHANGES_REQUESTED —
  the empty-group placeholder hard-coded "matches everything" regardless of combinator,
  but the engine treats empty `And` as TRUE and empty `Or` as FALSE. Split into
  `emptyGroupAnd`/`emptyGroupOr`, branch on `node.op`. Later hit a DCO failure from a
  maintainer "Update branch" merge commit (unsigned) → rebased onto main to linearize.

## CI integrity — the #1458 "Playwright cascade" (root-caused + fixed)

The intermittent CI red was **slow-mirror apt**, not tests. `npx playwright install-deps`
(and the lint/cargo/mcp `apt-get` steps) crawl to ~12 min on a slow Ubuntu mirror; the
prior retry was *self-defeating* (`timeout` SIGTERMs npx but orphans its `apt-get` child,
which keeps the dpkg lock so retries die instantly). True root cause: the runner's
`unattended-upgrades`/`apt-daily` hold the dpkg lock at boot.

- **#1461** (merged): reusable `.github/actions/prepare-apt` composite — stop background
  apt jobs, wait ≤180s for the dpkg lock, repair half-finished dpkg state, bound mirror
  stalls — wired before every apt step; lock-aware retry on the Playwright deps step.
- **#1465** (merged): raised the playwright job cap 20→30 (the cap is a *job* cap covering
  setup+tests; a 12-min apt left an ~9-min shard no room). Also folded in a markdown
  property-test flake fix (the `parse … valid block-level children` allow-list omitted
  `bulletList`/`blockquote`/`horizontalRule`, reddening vitest on `* a`/`> q`/`---`).
- **#1475** (merged): raised lint + mcp-tests caps 20→30 (same slow-apt cause; cargo-tests
  was already 35).
- Filed **#1464** — cache `/var/cache/apt/archives` so deps stop re-downloading ~33 MB
  each run (the real cost reduction; the cap bumps just absorb the variance).

## Features shipped (all merged)

- **#1447** advanced-query grouped headers → titles/labels (Tag/Page ULIDs via the shared
  `batchResolve`; BlockType/Priority codes → labels; `"none"` → "(none)").
- **#1424** `::` property-key picker ordered by usage (`GROUP BY … ORDER BY COUNT(*) DESC`).
- **#1445** Copy block/page reference (`((ULID))` / `[[ULID]]`) in the block context menu.
- **#1442** dynamic template variables (`{{date}}`/`{{date:FMT}}`/`{{time}}`/`{{title}}`/
  `{{cursor}}`) on `/template` insert; runs on the canonical markdown so marks survive.
- **#1448** configurable **display-only** journal date format (canonical content stays ISO;
  lookup/range/index/validation/parse untouched; default `locale` = no visible change).
- **#1423** distinguish inherited vs direct tag chips (additive `list_inherited_tags_for_block`,
  direct-wins dedupe, non-color affordance).
- **#1426** TagFilterPanel prefix pills + single-level All/Any/None composer (compiling
  losslessly to the flat `query_by_tags` IPC). Review caught that a *deep* nested composer
  would silently flatten/mislead — there is no nested-`TagExpr` IPC → filed **#1472**.
- **#1422** first-run mobile gesture coach-mark + Settings › Help "Touch gestures" card.
  Review caught an eager desktop chunk-load; a follow-up e2e fix seeded
  `agaric-gesture-coachmark-seen` in the Playwright storageState (the overlay was
  intercepting taps in the mobile-viewport specs — caught by CI, fixed + verified locally).
- **#1429** per-page local graph ("focus on this page") — pure client-side N-hop BFS over
  the already-loaded global graph (no extra IPC), reusing `useGraphSimulation`.
- **docs #1419/#1420/#1421** (one PR): corrected COMPARISON.md — global graph & built-in
  PDF reader DO ship (only per-page-local-graph / PDF-annotation absent), dropped brittle
  counts per the no-counts convention, fixed backlink-predicate count / crash-recovery
  description / `/schedule` id / spaces visual identity.

## In flight / open at session pause

- **#1479** (#1455) relational query predicates — `links-to` / `linked-from` /
  `has-parent-matching` EXISTS subqueries in the advanced-query engine. Engine + SQL +
  tests only (builder-UI chips deferred → **#1478**). Adversarial review SHIP: per-leaf
  proof of `b.`→`p{n}.` alias-retarget safety, bind-ordering/pagination verified, full Rust
  suite 4362 pass, dynamic-SQL guard clean. CI running.
- **#1470** (#1441) autolink bare URLs / `<url>` on markdown import — **HELD FOR MAINTAINER**:
  CodeQL flags 13 `js/regex/missing-regexp-anchor` in the new *test files*. Analysis (posted
  on the PR) concludes false-positive: the scheme matcher `^https?://` is a correctly-anchored
  *prefix* matcher, the autolink is not a trust boundary, and there is no `new RegExp(url)`
  sink. Awaiting a dismiss-vs-`paths-ignore` decision.

## Method notes / lessons

- **Mobile/overlay changes need e2e, not just unit tests** — #1422's coach-mark passed all
  vitest but broke `mobile-editor.spec.ts` (overlay intercepted taps); CI caught it, fixed by
  pre-seeding the dismissed flag in the Playwright storageState. Run the relevant
  `playwright` spec for any overlay/mobile work.
- **Rust worktrees need full seeding** — `.env` + a migrated `dev.db` (pre-push Phase E
  `sqlx prepare --check` needs `DATABASE_URL`) AND a prebuilt `agaric-mcp` binary
  (`prepare-external-bins.mjs`, Phase F) before pushing, or the push fails masked.
- **Adversarial review earned its cost**: caught the TagFilterPanel flatten-lie (#1426),
  the eager desktop chunk-load (#1422), the markdown autolink closing-markup swallow
  (#1441, via continuation-as-review after the builder died mid-verify), and exhaustively
  proved the #1455 alias-rewrite safe.
- Out-of-scope findings filed as issues, never deferred in comments: **#1464, #1472, #1478**.
- #645 (Tauri-free `agaric-core` crate) audited and re-scoped to a `plan` epic — the core
  cluster (op/op_log/hash/ulid/loro) reaches into error/db/space/materializer and carries
  sqlx, so it needs a boundary-design pass, not a mechanical move.
