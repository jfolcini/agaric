# Playwright e2e patterns

> E2E against a browser-served build with the JS tauri mock — not the Tauri runtime. Cross-cutting test conventions: [`src/__tests__/AGENTS.md`](../src/__tests__/AGENTS.md). Specs that need the real Rust backend: [`e2e-tauri/AGENTS.md`](../e2e-tauri/AGENTS.md).

## Configuration

Authoritative values are in [`playwright.config.ts`](../playwright.config.ts).

- Test dir `e2e/`, Chromium only, base URL `http://localhost:5173`.
- Web server: `npm run build:e2e && npm run preview:e2e` — a static production build served by `vite preview`. `VITE_E2E=1` keeps the tauri mock in the bundle (`src/main.tsx` gates the import on it); a plain prod build tree-shakes it out.

```sh
npm run test:e2e                              # whole suite
npx playwright test e2e/pages-view.spec.ts    # one spec
npx playwright test -g 'edits a block'        # one test by title
npm run test:e2e:ui                           # Playwright UI mode
npm run typecheck:e2e                         # tsc for this directory only
```

`e2e/**/*.ts` belongs to [`tsconfig.e2e.json`](../tsconfig.e2e.json), so `tsc -b` covers it at `src/` strictness. A new sibling TypeScript directory must be claimed by a tsconfig project (check with `npx tsc -p <cfg> --listFiles | grep -c "/<dir>/"`); the editor type-checks files no gate does.

### One run at a time on :5173

`reuseExistingServer` is on locally, so Playwright attaches to whatever already listens on :5173: a leftover `npm run dev` or older `vite preview` means testing the wrong bundle, and a concurrent run shares or kills the first one's server. Before a run, kill the PID from `lsof -ti :5173`, never `pkill -f`, which also matches unrelated shells.

## Mock backend

`src/lib/tauri-mock/` is an in-memory backend that activates when `window.__TAURI_INTERNALS__` is absent. It seeds fixed pages and blocks and exports `SEED_IDS` and `resetMock()`. `page.reload()` re-seeds it, so a spec verifies persistence by navigating away and back (`reopenPage`), never by reloading.

## The mock is a contract, not a convenience

Root rule: [AGENTS.md § Testing invariants](../AGENTS.md#testing-invariants-anti-drift). A Playwright green proves nothing about backend parity; the conformance harness does.

- [`conformance-coverage.test.ts`](../src/lib/tauri-mock/__tests__/conformance-coverage.test.ts) fails a new mutating command unless it gains a fixture in `conformance/fixtures/` or a `NO_FIXTURE_ALLOWLIST` waiver with a written reason (stale or read-only waivers also fail).
- Write the fixture (seed + ops + optional `scenarios` tags) without `expected`, then:

  ```sh
  cd src-tauri && CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'
  npx vitest run src/lib/tauri-mock src/lib/__tests__/tauri-mock.test.ts
  ```

  Red `conformance.test.ts` means the mock diverges: fix the handler under `src/lib/tauri-mock/handlers/`, never the backend. A divergence unsafe to mirror becomes a `.skip` with a `// DRIFT(#763)` comment plus an issue.
- Author handler behaviour from the Rust command, not from the issue or the existing mock, and reject what the backend rejects (out-of-range `limit`, unknown ids, refusals); a clamp turns a backend error the user hits into a green test. Then grep for tests that encode the old behaviour and run all of `src/lib`.
- Order and fold like SQLite: `BINARY` is UTF-8 byte order and `NOCASE` folds ASCII only, so mock sorts use `compareUtf8Bytes` / `compareNocase` (`src/lib/sqlite-collation.ts`), never `localeCompare`, `toLowerCase` or `<` on user text.

## Patterns

Import `test` / `expect` and helpers from `./helpers`, not `@playwright/test`:

```ts
import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

test.beforeEach(async ({ page }) => { await waitForBoot(page) })   // goto('/') + wait for the shell

test('edits a block', async ({ page }) => {
  await openPage(page, 'Getting Started')
  await (await focusBlock(page, 0)).fill('Hello, world!')
  await expect(page.getByText('Hello, world!')).toBeVisible()
})
```

- No page objects: flat tests, shared behaviour in `e2e/helpers.ts`.
- Select with `data-testid` / `data-slot`, not CSS classes.
- `installIpcRecorder` / `getInvokeCalls` / `clearInvokeCalls` assert on IPC traffic.
- `fullyParallel` is on; a spec whose tests share global state sets `test.describe.configure({ mode: 'serial' })`.
- Changing a shared control's visibility, a label, a selector or seed data, or removing a behaviour: grep `e2e/` (including `helpers.ts`), `e2e-tauri/` and `scripts/` (`android-e2e-safe-area.mjs`) in the same PR, and run the specs it hits. A spec may assert the bug itself; re-premise it rather than keep the bug.
- Mobile behaviour keys on the user agent (`src/lib/platform/index.ts`), not the viewport. A mobile spec sets the whole device (`viewport`, `userAgent`, `isMobile`, `hasTouch` from `devices['iPhone 13']`, as `mobile-editor.spec.ts` does).
- Focus on a hidden element, Escape-listener order, CSS specificity and forced-colors are invisible to the vitest DOM; reproduce them here, and assert focus with `toBeFocused()`.

## Flakes

- Reproduce before fixing ([standard 6](../src/__tests__/AGENTS.md#quality-standards)): `npx playwright test e2e/<file>.spec.ts --repeat-each=30 --workers=8 --retries=0` (local `retries: 2` hides it), under CPU load or CDP `Emulation.setCPUThrottlingRate`. The same assertion failing every time points at ordering, not a race.
- Do not build caret state from mid-stream `Home` / `End` / `ArrowLeft`: a dropped key is invisible. Type the whole string, assert it (`toHaveText`), then place the caret with `selectEditorRange`.
- `expect(promise).resolves`, `locator.evaluateAll`, `allTextContents` and `count()` read once and never retry. Use web-first matchers (`toHaveCount`, `toHaveText([...])`) or `expect.poll`.
- Assert the thing under test before any remount or navigation, which re-fetch and hide stale UI; a persistence round-trip is a separate assertion. `toContainText` passes with extra text, and a negative matcher (`toBeHidden`, `not.toBeVisible`) passes for unrelated reasons; see either go red without the fix.
- Click a block through `focusBlock` / `focusBlockById`, which hit a corner: a centre click lands on a chip or link.
- `dispatchEvent('click')` where `.click()` cannot land: an atomic inline NodeView (headless Chromium delivers no DOM `click`, see `inner-links.spec.ts`), or a button that scroll auto-load unmounts mid-click (`pages-view.spec.ts`).
- A button beside the focused editor that loses clicks moved when the editor blurred. Fix the product with `onMouseDown={(e) => e.preventDefault()}` (`AddBlockButton.tsx`), not the spec.

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

The `test` fixture from `./helpers` collects console + `pageerror` output and fails the spec in a global `afterEach` on anything not in its shared ignore list — so don't write a "no console errors" test or a hand-rolled `page.on('console', …)` listener. A spec that deliberately provokes an error asserts on `getConsoleErrors(page)` then calls `clearConsoleErrors(page)`; a benign error shared across specs goes in the ignore list in `e2e/helpers.ts`. Reference: `error-scenarios.spec.ts`.

## Horizontal-overflow assertion and the `data-overflow-clip` escape hatch

`expectNoHorizontalOverflow(page, target?, label?)` (`e2e/helpers.ts`) asserts a surface — a dialog/sheet locator, or the document when `target` is omitted — doesn't bleed past its right edge. `mobile-overflow.spec.ts` runs it across the app's views at phone widths; call it directly for a surface that renders differently on mobile.

It judges `position: absolute` children against their CSS containing block, not their DOM parent, and skips `fixed`/`sticky` descendants. Each containing-block trigger it recognises has a paired fixture in `horizontal-overflow-helper.spec.ts`; add one when you change the list.

`data-overflow-clip="intentional"` marks a container whose `overflow-x: hidden|clip` is deliberate (fixed-width panel, thumbnail); its descendants are excluded like `overflow-x: auto|scroll` regions. The walk checks computed style, so the attribute alone does nothing. Never put it on `target` itself, and a `position: static` marker doesn't cover an absolutely-positioned descendant.

## Header label selection

`<FeaturePageHeader>` renders an `<h1>` with the same text as the App-shell `<header>`'s `data-testid="header-label"` span, so `header > getByText` hits both and trips strict mode. Use `page.getByTestId('header-label')` (reference: `editor-lifecycle.spec.ts`).

## Performance runs

`perf.spec.ts`'s journey run is skipped unless `AGARIC_PERF=1`: it seeds a 500-page vault through the mock and prints per-journey frontend cost (INP, long animation frames, peak rendered blocks, React commits, main-thread time per chunk) to `test-results/perf-*`. Its other tests run on every PR: opening a 500-block page renders only the initial window (#5329), and opening Agenda, Pages, Tags or Search on 500 seeded rows renders at most 60 rows and makes exactly the view's `ipcOnOpen` IPC calls (#5366). A deliberate change to a view's open path re-measures that count from the failure message, which lists the calls. `AGARIC_PERF_CPU=4` throttles the CPU; `AGARIC_PERF_TRACE=1` saves a Chrome trace per journey. Backend query time comes from `AGARIC_OTEL=1` on the real app or the `interactive_slo` bench.

```sh
AGARIC_PERF=1 npx playwright test e2e/perf.spec.ts
AGARIC_PERF=1 AGARIC_PERF_CPU=4 npx playwright test e2e/perf.spec.ts
```
