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
// A spec joins the list once it passes there; `_validate.yml`'s `bridge-specs`
// job runs it on a PR whose diff reaches it. Unset, the run is the mock's: the
// `chromium` project skips the listed specs and `mock-only` runs their
// `@mock-only` tests.
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
  'agenda-sort-group.spec.ts',
  'agent-access.spec.ts',
  'app-chrome.spec.ts',
  'app-health-info.spec.ts',
  'app-health.spec.ts',
  'at-tag-prose-6530.spec.ts',
  'attachment-link-6032.spec.ts',
  'attachment-only-block-survives-blur.spec.ts',
  'attachment-paste-roundtrip.spec.ts',
  'attachments.spec.ts',
  'autocomplete.spec.ts',
  'backend-error-language.spec.ts',
  'batch-operations.spec.ts',
  'batch-toolbar-actions.spec.ts',
  'block-dnd-coverage.spec.ts',
  'block-dnd-multi-select.spec.ts',
  'block-dnd-parent-child.spec.ts',
  'block-dnd-touch.spec.ts',
  'block-duplicate.spec.ts',
  'block-history-sheet.spec.ts',
  'block-keyboard-fundamentals.spec.ts',
  'block-keyboard-move.spec.ts',
  'block-keyboard-select-collapse.spec.ts',
  'block-keyboard-select.spec.ts',
  'block-line-break.spec.ts',
  'block-linked-references.spec.ts',
  'block-menu-callout-type.spec.ts',
  'block-metadata-row-layout.spec.ts',
  'block-paste-outline.spec.ts',
  'block-ref-count.spec.ts',
  'block-ref-peek-keyboard.spec.ts',
  'block-ref-peek.spec.ts',
  'block-ref-picker.spec.ts',
  'block-select-cursor.spec.ts',
  'block-undo-chains-page-undo.spec.ts',
  'bookmarked-pages.spec.ts',
  'breadcrumb-navigation.spec.ts',
  'bubble-keyboard.spec.ts',
  'bubble-marks.spec.ts',
  'bug-report-dialog.spec.ts',
  'callout-picker.spec.ts',
  'callout-roundtrip.spec.ts',
  'capture-deep-link.spec.ts',
  'checkbox-typing.spec.ts',
  'chip-reveal.spec.ts',
  'click-caret.spec.ts',
  'closed-task-contrast.spec.ts',
  'code-comment-contrast.spec.ts',
  'custom-css.spec.ts',
  'date-chip-editing.spec.ts',
  'date-chip-target.spec.ts',
  'date-picker-current-date.spec.ts',
  'deep-link.spec.ts',
  'delete-page-tabs.spec.ts',
  'draft-autosave.spec.ts',
  'drop-upload.spec.ts',
  'due-date-agenda.spec.ts',
  'due-panel-keyboard-jumps.spec.ts',
  'due-panel-reschedule-touch.spec.ts',
  'editor-keyboard-chords.spec.ts',
  'editor-lifecycle.spec.ts',
  'editor-link-actions.spec.ts',
  'editor-reference-sheets.spec.ts',
  'embed-edit-in-place.spec.ts',
  'embed-render-states.spec.ts',
  'embed-task-tick.spec.ts',
  'embed-typing.spec.ts',
  'emoji-in-titles-and-tags.spec.ts',
  'emoji-picker.spec.ts',
  'enter-after-caret-key.spec.ts',
  'enter-delete-new-user.spec.ts',
  'enter-during-pull.spec.ts',
  'enter-merge-latency.spec.ts',
  'enter-split-caret.spec.ts',
  'escape-keeps-text.spec.ts',
  'escape-right-after-enter-cleans-blank.spec.ts',
  'external-image-policy.spec.ts',
  'external-link-context-menu.spec.ts',
  'external-link-open.spec.ts',
  'features-coverage.spec.ts',
  'font-size-scaling.spec.ts',
  'footnotes-6033.spec.ts',
  'formatting-toolbar-mobile.spec.ts',
  'graph-happy-paths.spec.ts',
  'graph-restore.spec.ts',
  'graph-view.spec.ts',
  'gutter-alignment.spec.ts',
  'gutter-control-clicks.spec.ts',
  'gutter-layout.spec.ts',
  'hash-tag-typing.spec.ts',
  'header-search-button.spec.ts',
  'heading-font-size.spec.ts',
  'high-contrast-chip-focus.spec.ts',
  'highlight-colours.spec.ts',
  'history-advanced.spec.ts',
  'history-keyboard-controls.spec.ts',
  'history-keyboard.spec.ts',
  'history-page-scope.spec.ts',
  'history-revert.spec.ts',
  'horizontal-overflow-helper.spec.ts',
  'html-paste-1439.spec.ts',
  'icon-button-sizes.spec.ts',
  'image-lightbox.spec.ts',
  'image-node.spec.ts',
  'image-resize.spec.ts',
  'import-export.spec.ts',
  'import-formats.spec.ts',
  'in-page-find.spec.ts',
  'in-page-replace.spec.ts',
  'infinite-journal-1415.spec.ts',
  'info-cues.spec.ts',
  'inline-image-1434.spec.ts',
  'inline-image-fold.spec.ts',
  'inner-links.spec.ts',
  'integrity-report.spec.ts',
  'journal-add-block-reuses-empty.spec.ts',
  'journal-add-block-while-editing.spec.ts',
  'journal-block-controls.spec.ts',
  'journal-date-page-from-picker.spec.ts',
  'journal-delete-page.spec.ts',
  'journal-mode-tabs.spec.ts',
  'journal-monthly.spec.ts',
  'journal-page-mode.spec.ts',
  'journal-panels.spec.ts',
  'journal-stream-page-dates.spec.ts',
  'journal-title-format.spec.ts',
  'journal-today-shortcut.spec.ts',
  'journal-undo.spec.ts',
  'journal-week-empty-day-add-block.spec.ts',
  'keyboard-chords-page.spec.ts',
  'keyboard-collisions.spec.ts',
  'keyboard-customization.spec.ts',
  'keyboard-shortcuts.spec.ts',
  'keyboard-tabs-drawers.spec.ts',
  'kind-change-undo.spec.ts',
  'language-preference.spec.ts',
  'link-chip-lifecycle.spec.ts',
  'link-labels.spec.ts',
  'link-title-edit-6530.spec.ts',
  'linked-image-6342.spec.ts',
  'list-keys-overlays-focus.spec.ts',
  'list-marker-only-lists.spec.ts',
  'list-rows-phone.spec.ts',
  'list-style-keyboard.spec.ts',
  'list-view-width.spec.ts',
  'long-url-no-loop.spec.ts',
  'markdown-links-5160.spec.ts',
  'markdown-reveal.spec.ts',
  'markdown-syntax.spec.ts',
  'math-katex.spec.ts',
  'mcp-activity-events.spec.ts',
  'mcp-agents.spec.ts',
  'md-attachment-render-1451.spec.ts',
  'meeting-attachments.spec.ts',
  'menus-popovers.spec.ts',
  'mermaid-roundtrip.spec.ts',
  'mirror-adopt.spec.ts',
  'mirror-inbound.spec.ts',
  'mirror-new-file.spec.ts',
  'mirror-read-back.spec.ts',
  'mirror-settings.spec.ts',
  'mirror-spaces.spec.ts',
  'mirror-structure.spec.ts',
  'mobile-drawer.spec.ts',
  'mobile-editor.spec.ts',
  'motion-speed.spec.ts',
  'narrow-window-tabs.spec.ts',
  'nav-active-item.spec.ts',
  'navigation-history.spec.ts',
  'nested-list-blur-1513.spec.ts',
  'nested-tags.spec.ts',
  'new-page-dialog.spec.ts',
  'observability-tracing.spec.ts',
  'obsidian-keymap.spec.ts',
  'onboarding-first-run.spec.ts',
  'ordered-list-start-edit-6530.spec.ts',
  'outgoing-links.spec.ts',
  'page-add-block-reuses-empty.spec.ts',
  'page-alias-add.spec.ts',
  'page-header-select-options.spec.ts',
  'page-kebab.spec.ts',
  'page-link-drag.spec.ts',
  'page-link-preview.spec.ts',
  'page-mode-batch-writes.spec.ts',
  'page-mode-block-menu.spec.ts',
  'page-mode-bubbles.spec.ts',
  'page-mode-durability.spec.ts',
  'page-mode-gutter.spec.ts',
  'page-mode-input.spec.ts',
  'page-mode-keys.spec.ts',
  'page-mode-look.spec.ts',
  'page-mode-markdown-switch.spec.ts',
  'page-mode-math.spec.ts',
  'page-mode-paste-html-list.spec.ts',
  'page-mode-paste-image-src.spec.ts',
  'page-mode-paste-names-6033.spec.ts',
  'page-mode-paste.spec.ts',
  'page-mode-reveal.spec.ts',
  'page-mode-slash.spec.ts',
  'page-mode-switch-seamless.spec.ts',
  'page-mode-text.spec.ts',
  'page-mode-toolbar.spec.ts',
  'page-mode-touch.spec.ts',
  'page-mode.spec.ts',
  'page-outline.spec.ts',
  'page-source-edit.spec.ts',
  'pages-bookmark-resort.spec.ts',
  'pages-browser-happy-paths.spec.ts',
  'pages-cursor-load-more.spec.ts',
  'pages-filter.spec.ts',
  'pages-header-routes.spec.ts',
  'pages-keyboard-controls.spec.ts',
  'pages-list-local-write.spec.ts',
  'pages-namespace-indent.spec.ts',
  'pages-reopen.spec.ts',
  'pages-scroll-restore.spec.ts',
  'pages-view.spec.ts',
  'pairing-sheet-phone.spec.ts',
  'palette-desktop.spec.ts',
  'paste-one-line-names-6033.spec.ts',
  'paste-spliced-5160.spec.ts',
  'paste-task-over-content-1514.spec.ts',
  'pdf-annotation-1452.spec.ts',
  'pdf-highlight-blocks-6629.spec.ts',
  'pdfjs-v6-smoke.spec.ts',
  'perf.spec.ts',
  'phone-bottom-sheets.spec.ts',
  'phone-content-edge.spec.ts',
  'phone-header-bar.spec.ts',
  'phone-keyboard-pan.spec.ts',
  'phone-toolbar.spec.ts',
  'phone-view-headers.spec.ts',
  'phone-views.spec.ts',
  'picker-happy-paths.spec.ts',
  'print-page.spec.ts',
  'properties-system.spec.ts',
  'properties-table-and-refusals.spec.ts',
  'property-change-refresh.spec.ts',
  'property-datetime.spec.ts',
  'property-def-undo.spec.ts',
  'property-key-rename.spec.ts',
  'property-list-drawer.spec.ts',
  'property-overflow-badge.spec.ts',
  'property-picker.spec.ts',
  'property-ref-boolean-chips.spec.ts',
  'property-type-change.spec.ts',
  'property-types-happy-paths.spec.ts',
  'property-unfit-marks.spec.ts',
  'property-unfit-values.spec.ts',
  'pseudo-locale.spec.ts',
  'query-block-text.spec.ts',
  'query-blocks.spec.ts',
  'query-hint.spec.ts',
  'query-table-cell-edit.spec.ts',
  'query-table-columns.spec.ts',
  'query-table-list-filter.spec.ts',
  'recent-pages-strip.spec.ts',
  'references-add-filter-click.spec.ts',
  'references-filters.spec.ts',
  'references-sort.spec.ts',
  'reload-keeps-editor.spec.ts',
  'rename-invalidation.spec.ts',
  'rtl-text.spec.ts',
  'scroll-ipc-counts.spec.ts',
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
  'selection-bubble.spec.ts',
  'settings-appearance.spec.ts',
  'settings-general.spec.ts',
  'settings-help.spec.ts',
  'settings-phone.spec.ts',
  'settings.spec.ts',
  'shortcut-labels.spec.ts',
  'sidebar-resize.spec.ts',
  'slash-command-properties.spec.ts',
  'slash-commands-coverage.spec.ts',
  'slash-commands-happy-paths.spec.ts',
  'slash-commands.spec.ts',
  'slash-marks.spec.ts',
  'slash-table-grid.spec.ts',
  'smoke.spec.ts',
  'space-move-property-loss.spec.ts',
  'spaces-coverage.spec.ts',
  'spaces-happy-paths.spec.ts',
  'spaces-management.spec.ts',
  'spaces-move-and-title.spec.ts',
  'sticky-toolbar.spec.ts',
  'suggestion-keyboard.spec.ts',
  'suggestion-popup-stability.spec.ts',
  'sync-refresh.spec.ts',
  'tab-reorder.spec.ts',
  'tab-switcher.spec.ts',
  'table-alignment-6277.spec.ts',
  'table-cell-link-backlink.spec.ts',
  'table-cell-paragraphs-6530.spec.ts',
  'table-editor-styling.spec.ts',
  'table-handles.spec.ts',
  'table-ops-toolbar.spec.ts',
  'table-view-render.spec.ts',
  'tag-chip-color.spec.ts',
  'tag-list-virtualization.spec.ts',
  'tag-management.spec.ts',
  'tag-name-whitespace.spec.ts',
  'tag-page-notes.spec.ts',
  'tag-page-tagged-items.spec.ts',
  'tag-suggested-properties.spec.ts',
  'tags-and-links-happy-paths.spec.ts',
  'tags-lifecycle.spec.ts',
  'tags-query-modes.spec.ts',
  'task-checkbox-dot.spec.ts',
  'task-checkbox-rows.spec.ts',
  'task-list-kind.spec.ts',
  'task-paste-wiring.spec.ts',
  'task-repeat-toggle-race.spec.ts',
  'template-keeps-fields-6530.spec.ts',
  'templates-view.spec.ts',
  'templates.spec.ts',
  'theme-icons.spec.ts',
  'theme-overlay.spec.ts',
  'tilde-fence-rule-6033.spec.ts',
  'token-chip-contrast.spec.ts',
  'toolbar-controls.spec.ts',
  'toolbar-icons.spec.ts',
  'toolbar-structural-inserts.spec.ts',
  'toolbar-touch-labels.spec.ts',
  'tooltip-pointer-events.spec.ts',
  'touch-gestures.spec.ts',
  'touch-menus.spec.ts',
  'trash-badge.spec.ts',
  'trash-bulk.spec.ts',
  'trash-deleted-time.spec.ts',
  'trash-keyboard-controls.spec.ts',
  'trash-load-more.spec.ts',
  'trash-page-cascade.spec.ts',
  'trashed-page-recents.spec.ts',
  'turn-into-chord.spec.ts',
  'typed-anchor-links-6033.spec.ts',
  'typed-metadata-one-leave.spec.ts',
  'undo-redo-blocks.spec.ts',
  'unlinked-references.spec.ts',
  'view-crash-panel.spec.ts',
  'view-header-width.spec.ts',
  'views-axe.spec.ts',
  'voice-note-unsupported.spec.ts',
  'voice-typing.spec.ts',
  'week-cross-day-clipboard.spec.ts',
  'weekly-reschedule-drag.spec.ts',
]

const LISTED = REAL_BACKEND_SPECS.map((spec) => `**/${spec}`)
const browser = {
  ...devices['Desktop Chrome'],
  ...(useCloudChromium ? { launchOptions: { executablePath: CLOUD_CHROMIUM } } : {}),
}

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
  projects: REAL_BACKEND
    ? [{ name: 'real-backend', testMatch: LISTED, grepInvert: /@mock-only/, use: browser }]
    : [
        { name: 'chromium', testIgnore: LISTED, grepInvert: /@real-only/, use: browser },
        { name: 'mock-only', testMatch: LISTED, grep: /@mock-only/, use: browser },
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
