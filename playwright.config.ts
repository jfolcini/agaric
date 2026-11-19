import { existsSync } from 'node:fs'

import { chromium, defineConfig, devices } from '@playwright/test'

// Parallel worktrees set `PW_PORT` so each one tests its own bundle: with the
// default port and `reuseExistingServer`, a second worktree would silently run
// against the first one's server.
const PORT = process.env['PW_PORT'] ?? '5173'
const ORIGIN = `http://localhost:${PORT}`

// A Claude cloud session ships one Chromium at this path, often older than the
// build the pinned Playwright asks for, and Playwright then refuses to launch.
const CLOUD_CHROMIUM = '/opt/pw-browsers/chromium'
const useCloudChromium = !existsSync(chromium.executablePath()) && existsSync(CLOUD_CHROMIUM)

// #6529 — with `AGARIC_E2E_BRIDGE` naming the `bridge` binary, the run is the
// `real-backend` project: these specs on the real commands (`e2e/bridge.ts`),
// minus every test tagged `@mock-only`, which drives a hook only the mock has.
// A test tagged `@real-only` asserts what only the real backend does (BM25
// ranking, a second page of results) and runs there alone.
// A spec joins the list once it passes there; the nightly `full-suite` lane of
// `scheduled-deep-checks.yml` runs it. Unset, the run is the mock's, and a
// listed test not tagged `@mock-only` runs on a mock that withholds its
// `window.__*` hooks, as the bridge does (`realBackend` in `e2e/helpers.ts`),
// so a PR that adds a hook call to a listed spec goes red before the nightly.
const REAL_BACKEND = process.env['AGARIC_E2E_BRIDGE'] !== undefined
const REAL_BACKEND_SPECS = [
  'advanced-query-board.spec.ts',
  'advanced-query-group.spec.ts',
  'advanced-query-happy-paths.spec.ts',
  'advanced-query-saved-views.spec.ts',
  'agenda-advanced.spec.ts',
  'agenda-count-after-write.spec.ts',
  'agenda-filter-builder.spec.ts',
  'agenda-projected-repeat.spec.ts',
  'agent-access.spec.ts',
  'app-health.spec.ts',
  'attachment-link-6032.spec.ts',
  'attachment-only-block-survives-blur.spec.ts',
  'attachment-paste-roundtrip.spec.ts',
  'attachments.spec.ts',
  'backend-error-language.spec.ts',
  'block-duplicate.spec.ts',
  'block-history-sheet.spec.ts',
  'block-keyboard-move.spec.ts',
  'block-line-break.spec.ts',
  'block-paste-outline.spec.ts',
  'bookmarked-pages.spec.ts',
  'capture-deep-link.spec.ts',
  'checkbox-typing.spec.ts',
  'deep-link.spec.ts',
  'delete-page-tabs.spec.ts',
  'draft-autosave.spec.ts',
  'due-date-agenda.spec.ts',
  'editor-lifecycle.spec.ts',
  'embed-edit-in-place.spec.ts',
  'embed-render-states.spec.ts',
  'embed-task-tick.spec.ts',
  'embed-typing.spec.ts',
  'enter-delete-new-user.spec.ts',
  'enter-during-pull.spec.ts',
  'graph-happy-paths.spec.ts',
  'graph-restore.spec.ts',
  'graph-view.spec.ts',
  'header-search-button.spec.ts',
  'history-advanced.spec.ts',
  'history-keyboard-controls.spec.ts',
  'history-keyboard.spec.ts',
  'history-page-scope.spec.ts',
  'history-revert.spec.ts',
  'import-export.spec.ts',
  'import-formats.spec.ts',
  'in-page-replace.spec.ts',
  'inline-image-1434.spec.ts',
  'journal-add-block-reuses-empty.spec.ts',
  'journal-delete-page.spec.ts',
  'journal-monthly.spec.ts',
  'journal-page-mode.spec.ts',
  'journal-panels.spec.ts',
  'journal-undo.spec.ts',
  'journal-week-empty-day-add-block.spec.ts',
  'keyboard-chords-page.spec.ts',
  'mcp-agents.spec.ts',
  'meeting-attachments.spec.ts',
  'mirror-adopt.spec.ts',
  'mirror-inbound.spec.ts',
  'mirror-new-file.spec.ts',
  'mirror-read-back.spec.ts',
  'mirror-settings.spec.ts',
  'mirror-spaces.spec.ts',
  'mirror-structure.spec.ts',
  'navigation-history.spec.ts',
  'nested-tags.spec.ts',
  'new-page-dialog.spec.ts',
  'page-alias-add.spec.ts',
  'page-kebab.spec.ts',
  'page-mode-batch-writes.spec.ts',
  'page-mode-block-menu.spec.ts',
  'page-mode-durability.spec.ts',
  'page-mode-gutter.spec.ts',
  'page-mode-input.spec.ts',
  'page-mode-keys.spec.ts',
  'page-mode-markdown-switch.spec.ts',
  'page-mode-paste-html-list.spec.ts',
  'page-mode-paste-names-6033.spec.ts',
  'page-mode-paste.spec.ts',
  'page-mode-slash.spec.ts',
  'page-mode-text.spec.ts',
  'page-mode-toolbar.spec.ts',
  'page-mode.spec.ts',
  'page-source-edit.spec.ts',
  'pages-browser-happy-paths.spec.ts',
  'pages-header-routes.spec.ts',
  'pages-list-local-write.spec.ts',
  'pages-reopen.spec.ts',
  'pages-view.spec.ts',
  'pdf-annotation-1452.spec.ts',
  'pdf-highlight-blocks-6629.spec.ts',
  'phone-views.spec.ts',
  'properties-system.spec.ts',
  'properties-table-and-refusals.spec.ts',
  'property-change-refresh.spec.ts',
  'property-datetime.spec.ts',
  'property-def-undo.spec.ts',
  'property-key-rename.spec.ts',
  'property-list-drawer.spec.ts',
  'property-picker.spec.ts',
  'property-ref-boolean-chips.spec.ts',
  'property-type-change.spec.ts',
  'property-types-happy-paths.spec.ts',
  'property-unfit-marks.spec.ts',
  'property-unfit-values.spec.ts',
  'query-block-text.spec.ts',
  'query-blocks.spec.ts',
  'query-hint.spec.ts',
  'query-table-cell-edit.spec.ts',
  'query-table-columns.spec.ts',
  'query-table-list-filter.spec.ts',
  'references-filters.spec.ts',
  'references-sort.spec.ts',
  'rename-invalidation.spec.ts',
  'search-filter-chips.spec.ts',
  'search-filters.spec.ts',
  'search-happy-paths.spec.ts',
  'search-help.spec.ts',
  'search-history.spec.ts',
  'search-nested-result.spec.ts',
  'search-recent-click.spec.ts',
  'search-replace.spec.ts',
  'search-results.spec.ts',
  'search-sheet-mobile.spec.ts',
  'search-shown-text-6277.spec.ts',
  'search-toggles.spec.ts',
  'search-view-mobile.spec.ts',
  'slash-command-properties.spec.ts',
  'smoke.spec.ts',
  'space-move-property-loss.spec.ts',
  'spaces-coverage.spec.ts',
  'spaces-happy-paths.spec.ts',
  'spaces-management.spec.ts',
  'spaces-move-and-title.spec.ts',
  'sync-refresh.spec.ts',
  'tag-management.spec.ts',
  'tag-name-whitespace.spec.ts',
  'tag-page-notes.spec.ts',
  'tag-page-tagged-items.spec.ts',
  'tags-and-links-happy-paths.spec.ts',
  'tags-lifecycle.spec.ts',
  'tags-query-modes.spec.ts',
  'task-repeat-toggle-race.spec.ts',
  'template-keeps-fields-6530.spec.ts',
  'templates-view.spec.ts',
  'templates.spec.ts',
  'tooltip-pointer-events.spec.ts',
  'trash-badge.spec.ts',
  'trash-bulk.spec.ts',
  'trash-deleted-time.spec.ts',
  'trash-page-cascade.spec.ts',
  'trashed-page-recents.spec.ts',
  'typed-anchor-links-6033.spec.ts',
  'unlinked-references.spec.ts',
]

export default defineConfig({
  testDir: './e2e',
  // For its `@/` alias: `e2e/bridge.ts` imports the mock's seed from `src/`.
  tsconfig: './tsconfig.e2e.json',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // No retries, in CI or locally: a retry turns a flake into a green run and
  // hides it, so a flaky test must fail and get fixed.
  retries: 0,
  // #1458: hard per-test ceiling. A single test taking a full minute is
  // already pathological; 60s fails it fast instead of letting it drift toward
  // the job cap, and is generous enough for the heaviest legitimate spec.
  timeout: 60_000,
  // #1458: global ceiling BELOW the CI job cap (`_validate.yml` playwright
  // `timeout-minutes`). At the ceiling Playwright aborts itself and still runs
  // the reporter, so the per-shard report uploads BEFORE the runner kills the
  // job — making any future cascade diagnosable instead of self-obscuring.
  // Sized for one shard under CI=1 plus the `webServer` build, with a wide
  // margin. Both CI lanes run the same four-way shard (`_validate.yml`, and
  // since #4675 the weekly `full-suite-playwright` in
  // `scheduled-deep-checks.yml`). Unbounded locally.
  globalTimeout: process.env['CI'] ? 25 * 60_000 : 0,
  // File-level parallelism via `fullyParallel: true`, with
  // per-suite `test.describe.configure({ mode: 'serial' })` annotations on
  // the specs whose tests share global state (op-log, pairing mock, kebab
  // popover chains). The workers cap below is per-shard — the CI sharding
  // lives in `.github/workflows/_validate.yml`'s playwright job, so the
  // effective parallelism in CI is `shards × workers`. A CI runner has four
  // cores and one test keeps more than one busy (the renderer and its raster
  // threads), so three workers fill them and a fourth mostly adds contention.
  //
  // Locally there is no sharding, so `'50%'` on a 16-core box spawned 8
  // browser contexts against ONE server, and the contention made
  // popover/suggestion mounts miss their visibility deadline (~50% flake on
  // the heaviest specs). Cap local parallelism at 4 to keep the server
  // responsive; the suite stays comfortably parallel without thrashing.
  // (#1458: the server is now a static `vite preview` build, not dev+HMR.)
  workers: process.env['CI'] ? 3 : 4,
  // CI: one dot per test, full error and stack for each failure, plus GitHub
  // annotations. `list` printed one line per passing test (hundreds per shard).
  reporter: process.env['CI'] ? [['dot'], ['github']] : 'list',
  expect: {
    // Overlay mounts (popover/dialog/suggestion portals) can take a beat to
    // appear under parallel-context load; 8s occasionally clipped them. 15s
    // absorbs the jitter without hiding real hangs, and stays under the 60s
    // per-test ceiling so a genuinely stuck `expect` still fails fast (#1458).
    timeout: 15000,
  },
  use: {
    baseURL: ORIGIN,
    // CI keeps a failed test's trace and final screenshot in `test-results/`,
    // which `_validate.yml` uploads on failure: with no retries a flake gets one
    // run, and that run is the only evidence. A passing test's trace is
    // discarded. No screencast frames, the costly part of a trace; the DOM
    // snapshots per action show what was on the page. Off locally.
    trace: process.env['CI']
      ? { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true }
      : 'off',
    screenshot: process.env['CI'] ? 'only-on-failure' : 'off',
    // #1458: fail-fast navigation/action bounds. Against the static `vite
    // preview` build (no on-the-fly HMR transform), a `page.goto` resolves in
    // well under a second, so a 30s navigation bound only ever fires on a
    // genuinely wedged server — turning the old silent multi-minute hang into a
    // fast, attributable failure. 15s on individual actions mirrors the overlay
    // `expect.timeout` so a stuck click/fill surfaces quickly rather than
    // burning the whole per-test budget.
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    // Dismiss welcome modal by marking onboarding as done before app loads
    storageState: {
      cookies: [],
      origins: [
        {
          origin: ORIGIN,
          localStorage: [
            { name: 'agaric-onboarding-done', value: 'true' },
            // #1422: pre-dismiss the first-run mobile gesture coach-mark so its
            // overlay doesn't intercept taps in the mobile-viewport e2e specs.
            { name: 'agaric-gesture-coachmark-seen', value: 'true' },
          ],
        },
      ],
    },
  },
  projects: [
    {
      name: REAL_BACKEND ? 'real-backend' : 'chromium',
      ...(REAL_BACKEND
        ? { testMatch: REAL_BACKEND_SPECS.map((spec) => `**/${spec}`), grepInvert: /@mock-only/ }
        : { grepInvert: /@real-only/ }),
      metadata: { realBackendSpecs: REAL_BACKEND_SPECS },
      use: {
        ...devices['Desktop Chrome'],
        ...(useCloudChromium ? { launchOptions: { executablePath: CLOUD_CHROMIUM } } : {}),
      },
    },
  ],
  webServer: {
    // #1458 ROOT-CAUSE FIX: serve a static *production* build via `vite
    // preview` instead of `npm run dev` (vite dev + HMR). The dev server
    // compiled/transformed modules on demand and ran HMR; under the load of a
    // sharded CI run it stalled (transform-under-load or an outright crash),
    // every test on that shard failed navigation until the shard ran to the
    // job cap — with the failing shard VARYING run-to-run (the signature of
    // infra/dev-server flake, not a bad spec). A pre-built static bundle has
    // no on-the-fly compilation, so there is nothing to stall.
    //
    // The build runs with `VITE_E2E=1`, which keeps the tauri IPC mock in
    // the bundle (main.tsx gates the mock on `import.meta.env.VITE_E2E`); the
    // suite depends on that mock, and a plain prod build would tree-shake it
    // out. `preview:e2e` serves `dist/` with `--strictPort` so the
    // baseURL/storageState origin stay unchanged; the trailing `--port` is
    // `PW_PORT`. The build skips `tsc -b` (`build:e2e` has it): the lint job's
    // `tsc` hook already type-checks `e2e/` on every frontend change. `npx`
    // finds vite where `node_modules/.bin` is not on PATH: a bare
    // `playwright test`, or an editor's test runner.
    command: `VITE_E2E=1 npx vite build && npm run preview:e2e -- --port ${PORT}`,
    url: ORIGIN,
    // #1458: bound server readiness. The build (~30-60s) + preview boot must
    // finish well within this; 180s absorbs a cold CI build + a slow mirror
    // without letting a wedged build hang the run indefinitely. Locally,
    // `reuseExistingServer` skips the rebuild when a preview is already up.
    timeout: 180_000,
    // Local: reuse an already-running server (dev OR preview) for a fast
    // edit/run loop. CI: always start fresh (and thus always builds).
    reuseExistingServer: !process.env['CI'],
  },
})
