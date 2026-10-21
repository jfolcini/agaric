# Playwright e2e patterns

> E2E against a browser-served build with the JS tauri mock — not the Tauri runtime. Cross-cutting test conventions: [`src/__tests__/AGENTS.md`](../src/__tests__/AGENTS.md). Specs that need the real Rust backend: [`e2e-tauri/AGENTS.md`](../e2e-tauri/AGENTS.md).

## Configuration

Authoritative values are in [`playwright.config.ts`](../playwright.config.ts).

- Test dir `e2e/`, Chromium only, base URL `http://localhost:$PW_PORT` (default 5173).
- Web server: `VITE_E2E=1 vite build`, then `npm run preview:e2e` on `PW_PORT` — a static production build served by `vite preview`. `VITE_E2E=1` keeps the tauri mock in the bundle (`src/main.tsx` gates the import on it); a plain prod build tree-shakes it out. The build does not type-check: a type error in a spec shows in `npm run typecheck`.

```sh
npm run test:e2e                              # whole suite
npx playwright test e2e/pages-view.spec.ts    # one spec
npx playwright test -g 'edits a block'        # one test by title
npx playwright test --grep @editor            # one area (title tags)
just e2e-related                              # the specs your change can affect
npm run test:e2e:ui                           # Playwright UI mode
npm run typecheck:e2e                         # tsc for this directory only
```

`e2e/**/*.ts` belongs to [`tsconfig.e2e.json`](../tsconfig.e2e.json), so `tsc -b` covers it at `src/` strictness. A new sibling TypeScript directory must be claimed by a tsconfig project (check with `npx tsc -p <cfg> --listFiles | grep -c "/<dir>/"`); the editor type-checks files no gate does.

### One run per port

`reuseExistingServer` is on locally, so Playwright attaches to whatever already listens on its port: a leftover `npm run dev` or older `vite preview` means testing the wrong bundle, and a concurrent run shares or kills the first one's server. Give each worktree its own port (`PW_PORT=5557 npx playwright test …`). Before a run, kill the PID from `lsof -ti :$PW_PORT`, never `pkill -f`, which also matches unrelated shells.

In CI, `scripts/classify-changes.sh` picks the lanes: a diff of only `e2e/*.spec.ts` runs just those specs on one leg (`playwright_specs`), a diff of only vitest tests or `e2e-tauri/` files runs no Playwright, and any other frontend change, like the weekly full suite, runs every shard.

## Mock backend

`src/lib/tauri-mock/` is an in-memory backend that activates when `window.__TAURI_INTERNALS__` is absent. It seeds fixed pages and blocks and exports `SEED_IDS` and `resetMock()`. `page.reload()` re-seeds it, so a spec verifies persistence by navigating away and back (`reopenPage`), never by reloading.

## The mock is a contract, not a convenience

Root rule: [AGENTS.md § Testing invariants](../AGENTS.md#testing-invariants-anti-drift). A Playwright green proves nothing about backend parity; the conformance harness does.

- [`conformance-coverage.test.ts`](../src/lib/tauri-mock/__tests__/conformance-coverage.test.ts) fails a new mutating command unless it gains a fixture in `conformance/fixtures/` or a `NO_FIXTURE_ALLOWLIST` waiver with a written reason (stale or read-only waivers also fail).
- Write the fixture (seed + ops + optional `scenarios` tags) without `expected`, then:

  ```sh
  cd src-tauri && CONFORMANCE_UPDATE=1 cargo nextest run --workspace --test command_integration -E 'test(conformance_fixtures_match_backend)'
  npx vitest run src/lib/tauri-mock src/lib/__tests__/tauri-mock.test.ts
  ```

  Red `conformance.test.ts` means the mock diverges: fix the handler under `src/lib/tauri-mock/handlers/`, never the backend. A divergence unsafe to mirror becomes a `.skip` with a `// DRIFT(#763)` comment plus an issue, unless a decision says the mock never mirrors it: #5071 keeps the markdown grammar in Rust only (`markdown_imports`, and the render steps in `QUERY_STEPS_BACKEND_ONLY`).
- Author handler behaviour from the Rust command, not from the issue or the existing mock, and reject what the backend rejects (out-of-range `limit`, unknown ids, refusals); a clamp turns a backend error the user hits into a green test. Then grep for tests that encode the old behaviour and run all of `src/lib`.
- A handler that ignores part of its input, or returns a thinner row than the backend (ids only), leaves every spec on that input unable to fail. Give the conformance step a variant per filter the UI sends, and compare every field the UI reads.
- Handlers return copies of stored rows, as the real IPC returns fresh objects: a live row mutated in place keeps the same identity, and the React Compiler keeps rendering the old one.
- Order and fold like SQLite: `BINARY` is UTF-8 byte order and `NOCASE` folds ASCII only, so mock sorts use `compareUtf8Bytes` / `compareNocase` (`src/lib/sqlite-collation.ts`), never `localeCompare`, `toLowerCase` or `<` on user text.

## Patterns

Import `test` / `expect` and helpers from `./helpers`, not `@playwright/test`:

```ts
import { expect, focusBlock, openPage, replaceEditorText, test, waitForBoot } from './helpers'

test.beforeEach(async ({ page }) => { await waitForBoot(page) })   // goto('/') + wait for the shell

test('edits a block', async ({ page }) => {
  await openPage(page, 'Getting Started')
  await focusBlock(page, 0)
  await replaceEditorText(page, 'Hello, world!')
  await expect(page.getByText('Hello, world!')).toBeVisible()
})
```

- Replace a block editor's text with `replaceEditorText`, never `locator.fill`: `fill` selects all natively, ProseMirror reads that selection only later, and the text is appended or the block never empties.

- No page objects: flat tests, shared behaviour in `e2e/helpers.ts`. Cross-test setup is a fixture on the exported `test`: a module-level `beforeEach` in a shared module binds only to the first spec file a worker loads.
- Select with `data-testid` / `data-slot`, not CSS classes.
- `installIpcRecorder` / `getInvokeCalls` / `clearInvokeCalls` assert on IPC traffic. The recorder sees only calls made after boot; counting boot IPC wraps the assignment instead (`boot-ipc-counts.spec.ts`).
- `fullyParallel` is on; a spec whose tests share global state sets `test.describe.configure({ mode: 'serial' })`.
- Changing a shared control's visibility, a label, a selector or seed data, or removing a behaviour: grep `e2e/` (including `helpers.ts`), `e2e-tauri/` and `scripts/` (`android-e2e-safe-area.mjs`) in the same PR, and run the specs it hits. A spec may assert the bug itself; re-premise it rather than keep the bug.
- Mobile behaviour keys on the user agent (`src/lib/platform/index.ts`), not the viewport. A mobile spec sets the whole device (`viewport`, `userAgent`, `isMobile`, `hasTouch` from `devices['iPhone 13']`, as `mobile-editor.spec.ts` does).
- Focus on a hidden element, Escape-listener order, CSS specificity and forced-colors are invisible to the vitest DOM; reproduce them here, and assert focus with `toBeFocused()`.

## Flakes

- Reproduce before fixing ([standard 6](../src/__tests__/AGENTS.md#quality-standards)): `npx playwright test e2e/<file>.spec.ts --repeat-each=30 --workers=8` under CPU load or CDP `Emulation.setCPUThrottlingRate`. The same assertion failing every time points at ordering, not a race. When neither reproduces it, stretch the suspect gap itself and A/B it (slow the animation, delay the page's zero-delay timers from an init script): throttling slows every task alike, so it never reorders them.
- Do not build caret state from mid-stream `Home` / `End` / `ArrowLeft`: ProseMirror reads a native caret move on the next `selectionchange`, which Chrome fires late or coalesces, so the next key or paste sees the old selection. Type the whole string, assert it (`toHaveText`), then place the caret with `selectEditorRange`, which dispatches `selectionchange` itself. On a buffer that was just focused, wait for `toBeFocused()` first, then for a timer queued after the focus (`caret` in `page-mode.spec.ts`): ProseMirror writes its selection back over the DOM's on a 20 ms timer after a focus, which a stream of keys starves until it undoes a later arrow.
- After a view change, App moves focus to the view's primary element one frame later; after a dialog or drawer closes, focus returns to the editor a task later. Assert the focus you need with `toBeFocused()` before a key chord, or the chord lands in that element.
- A week-view day mounts its tree only once scrolled into view (`useEnteredViewport` in `DaySection.tsx`), and `BlockTree` renders rows outside the scroller as placeholder `li`s (`useViewportObserver`), so a click that scrolls can detach a locator resolved earlier. Scroll the day or row's `li` into view first, and check a date-keyed spec under `page.clock` on every weekday.
- A computed style or a position read mid-animation flakes (a colour mid-fade, a graph node during the fit's ease). A spec that does not test the animation turns it off, with `page.emulateMedia({ reducedMotion: 'reduce' })` or a `transition: none` style tag (`nav-active-item.spec.ts`); one that does waits for the value to stop changing, not merely to appear.
- `expect(promise).resolves`, `locator.evaluateAll`, `allTextContents` and `count()` read once and never retry. Use web-first matchers (`toHaveCount`, `toHaveText([...])`) or `expect.poll`.
- Assert the thing under test before any remount or navigation, which re-fetch and hide stale UI; a persistence round-trip is a separate assertion. `toContainText` passes with extra text, and a negative matcher (`toBeHidden`, `not.toBeVisible`) passes for unrelated reasons; see either go red without the fix.
- Click a block through `focusBlock` / `focusBlockById`, which hit a corner: a centre click lands on a chip or link. Wait first for a lazy block (KaTeX, Mermaid) to finish rendering: its fallback has another height, so the click point goes stale and lands in the block below.
- Drive time with `page.clock`, installed before boot, never a sleep. A paused clock reaches a path a debounce hides, a relative-time label needs `fastForward`, and edits closer than `UNDO_GROUP_WINDOW_MS` merge into one undo entry.
- A toast raised twice is addressed as `[data-sonner-toast][data-front="true"]`, never `.first()` / `.last()`: sonner stacks the older toast behind, where it intercepts the click.
- `dispatchEvent('click')` where `.click()` cannot land: an atomic inline NodeView (headless Chromium delivers no DOM `click`, see `inner-links.spec.ts`), or a button that scroll auto-load unmounts mid-click (`pages-view.spec.ts`).
- A control that loses its first click moved between the press and the release. Fix the product, not the spec. A mouse press that blurs the block editor already holds its row in edit mode until the press ends (`useEditorBlur`), so a control below it needs nothing. A control whose press blurs another input that reshapes the layout (the Search input's history dropdown), or that must act on the edited block (gutter controls), keeps that focus with `onMouseDown={(e) => e.preventDefault()}`.

## Portal-scoped helpers

Radix portals mount to `document.body`; under parallel runs a vanilla `getByRole('dialog')` resolves to two elements or a stale subtree. Always use the `active*` helpers from `e2e/helpers.ts`, which scope to the newest portal via `.last()`:

| Helper | What it scopes |
|---|---|
| `activeDialog(page)` | `[data-slot="dialog-content"]` |
| `activeAlertDialog(page)` | `[data-slot="alert-dialog-content"]` |
| `activeSheet(page)` | `[data-slot="sheet-content"]` |
| `activePopover(page)` | `[data-slot="popover-content"]` |
| `activeMenu(page)` | `[role="menu"]` (block-context menu) |
| `activeRoleDialog(page)` | generic `[role="dialog"]` when no `data-slot` exists (e.g. `TemplatePicker`) |
| `activeSuggestionPopup(page)` | `[data-testid="suggestion-popup"]` (TipTap) |
| `activeSuggestionList(page)` | `[data-testid="suggestion-list"]` (its `role="listbox"` child) |

## Undo / redo e2e helpers

Ctrl+Z depends on focus:

- `blurEditors(page)` — Escape out of `contentEditable` first, or Ctrl+Z hits ProseMirror's undo instead of `useUndoShortcuts`.
- `reopenPage(page, title)` — navigate away and back to force a `BlockTree` re-fetch, proving the undo persisted.
- Wait for the `"Undone"` / `"Redone"` toast before asserting.

## Console errors are asserted automatically

The `test` from `./helpers` carries an auto fixture, `consoleErrorGate`, that collects console + `pageerror` output and fails the test at teardown on anything not in its shared ignore list — so don't write a "no console errors" test or a hand-rolled `page.on('console', …)` listener. A spec that deliberately provokes an error asserts on `getConsoleErrors(page)` then calls `clearConsoleErrors(page)`; a benign error shared across specs goes in the ignore list in `e2e/helpers.ts`. Reference: `error-scenarios.spec.ts`.

## Horizontal-overflow assertion and the `data-overflow-clip` escape hatch

`expectNoHorizontalOverflow(page, target?, label?)` (`e2e/helpers.ts`) asserts a surface — a dialog/sheet locator, or the document when `target` is omitted — doesn't bleed past its right edge. `mobile-overflow.spec.ts` runs it across the app's views at phone widths; call it directly for a surface that renders differently on mobile.

It judges `position: absolute` children against their CSS containing block, not their DOM parent, and skips `fixed`/`sticky` descendants. Each containing-block trigger it recognises has a paired fixture in `horizontal-overflow-helper.spec.ts`; add one when you change the list.

`data-overflow-clip="intentional"` marks a container whose `overflow-x: hidden|clip` is deliberate (fixed-width panel, thumbnail); its descendants are excluded like `overflow-x: auto|scroll` regions. The walk checks computed style, so the attribute alone does nothing. Never put it on `target` itself, and a `position: static` marker doesn't cover an absolutely-positioned descendant.

## Header label selection

`<FeaturePageHeader>` renders an `<h1>` with the same text as the App-shell `<header>`'s `data-testid="header-label"` span, so `header > getByText` hits both and trips strict mode. Use `page.getByTestId('header-label')` (reference: `editor-lifecycle.spec.ts`).

## Performance runs

`perf.spec.ts`'s journey run is skipped unless `AGARIC_PERF=1`: it seeds a 500-page vault through the mock and prints per-journey frontend cost (INP, long animation frames, peak rendered blocks, React commits, main-thread time per chunk) to `test-results/perf-*`. Its other tests run whenever Playwright does: opening a 500-block page renders only the initial window (#5329), and opening Agenda, Pages, Tags or Search on 500 seeded rows renders at most 60 rows and makes exactly the view's `ipcOnOpen` IPC calls (#5366); opening a page and following a link chip each make exactly their pinned set of calls (#5445). A deliberate change to a view's open path re-measures that count from the failure message, which lists the calls. `AGARIC_PERF_CPU=4` throttles the CPU; `AGARIC_PERF_TRACE=1` saves a Chrome trace per journey. Backend query time comes from `AGARIC_OTEL=1` on the real app or the `interactive_slo` bench. Time inside the page (`performance.now()` in `evaluate`), never around an `expect` or `waitFor`, whose poll backoff rounds the wait up.

```sh
AGARIC_PERF=1 npx playwright test e2e/perf.spec.ts
AGARIC_PERF=1 AGARIC_PERF_CPU=4 npx playwright test e2e/perf.spec.ts
```
