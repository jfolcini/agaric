// ---------------------------------------------------------------------------
// Shared helpers for the real-backend WebdriverIO round-trip specs (#3085).
//
// These drive the REAL Agaric binary in a WebKitWebView via tauri-driver — the
// genuine Rust backend over real Tauri IPC, NOT the JS mock the Playwright
// `e2e/` suite uses. The specs that import these helpers target exactly the
// bug class the #3082 umbrella wants dead: mock-vs-real drift and "durable
// state vanishes after navigation/reload". Factoring the app-ready wait, the
// view navigation, and the block-create flow here keeps the weekly job's
// failure output legible (one named helper per interaction).
//
// `browser`, `$`, and `expect` are provided as GLOBALS by @wdio/globals at
// runtime (typed via `@wdio/globals/types` in tsconfig.wdio.json), exactly as
// the pioneering `smoke.e2e.ts` relies on them — so no imports are needed and
// this file stays a drop-in peer of that proven spec.
//
// Selector policy (all statically validated against component source):
//   - `[data-slot="sidebar"]`               ui/sidebar.tsx (the nav shell)
//   - `.//button[@aria-label="<Label>" or .//span[normalize-space(.)="<Label>"]]`
//     scoped to the sidebar. AppSidebar.tsx renderNavItem renders each nav
//     destination as `<SidebarMenuButton><icon/><span>{label}</span>`, i.e. a
//     `<button>` (ui/sidebar.tsx SidebarMenuButton: `Comp = 'button'`) whose only
//     label `<span>` holds the i18n nav label (Journal / Tags / Pages). Settings
//     is an icon-only footer button named by its `aria-label` (#5332).
//
//     WHY XPATH, NOT `aria/<Label>` (the #155 first-live-run defect): WDIO's
//     accessible-name selector matches document-wide and does NOT reliably
//     restrict to the parent element's subtree even when chained off
//     `sidebar.$(...)`. The Journal VIEW renders an `<h1>` whose text is ALSO
//     `t('sidebar.journal')` -> "Journal" (JournalPage.tsx:193 passes it as the
//     FeaturePageHeader `title`; feature-page-header.tsx:91 emits
//     `<h1 data-slot="feature-page-header-title">{title}</h1>`), so the nav
//     button and the page heading share the accessible name "Journal". A bare
//     `aria/Journal` could therefore resolve the heading (or the like-named
//     QuickAccessBar chip) instead of the nav button — the click no-ops and
//     `aria-current="page"` never appears. XPath's leading `.` IS honoured by
//     WDIO relative to the sidebar root, so this only ever matches the nav
//     button. (The nav label spans contain no child elements, so
//     `normalize-space(.)` equals the exact label text.)
//   - `aria-current="page"`                 AppSidebar.tsx renderNavItem sets
//     it on the active nav button (spread onto the DOM <button> by
//     SidebarMenuButton `{...props}`). This is a VIEW-AGNOSTIC readiness
//     signal: after a nav click the target button flips to `page`, proving the
//     view actually switched — no per-view anchor or timing race required.
//   - `button*=Add block`                   JournalPage "Add block" action
//     (`agenda.day.addBlock`), the same selector smoke.e2e.ts committed to.
//   - `#journal-tab-weekly`                 JournalControls week tab
//     (`journalTabId('weekly')`); `section[id="journal-<date>"]` is a
//     DaySection, and "No blocks for" (`agenda.day.empty`) marks a day with
//     no page.
//   - `#new-page-name`                      the New page dialog's title field
//     (NewPageDialog.tsx), opened by the sidebar's "New Page" button
//     (`openNewPageDialog`); Enter in it creates the page.
//   - `[data-testid="block-editor"]`        the roving TipTap editor box.
//   - `[data-testid="block-static"]`        a committed (non-focused) block row
//     (StaticBlock; carries `data-block-id`).
//   - `[data-testid="image-rendered"]`      GatedImage.tsx's `<img>`, whose
//     `src` is a `blob:` URL of `read_attachment`'s bytes for an
//     `attachment:<id>` ref.
//   - Settings › Sync & devices, for the sync specs: `#settings-tab-sync`,
//     `[data-testid="settings-panel-sync"]`, "Pair new device",
//     `[data-testid="pairing-qr-code"]` (its SVG is decoded in sync-peer.ts),
//     `.pairing-passphrase`, the "Cancel pairing" button of the close guard's
//     `[role="alertdialog"]`, `.device-peer-item`, "Edit address for …",
//     "Address (host:port)", "Save", "Sync now with device …", "Unpair device …"
//     and the "Yes, unpair" button of its `[role="alertdialog"]`,
//     `[data-testid="device-no-peers"]`, and the toasts "Device paired
//     successfully" and "Address updated". Its outline reads
//     `[data-testid="sortable-block"]` rows, their `li[aria-level]`, and the
//     `[data-testid="property-chip"]` inside a row. sync-refresh.e2e.ts pairs
//     through the same settings and then reads: the sidebar's
//     `button[aria-label="Sync"]` and its `aria-disabled` while a sync runs
//     (AppSidebar.tsx), `[data-testid="due-panel"]`, `.done-panel`,
//     `[data-testid="unfinished-tasks"]` and its `button[aria-expanded]`
//     header, `.page-browser-item-title`, `[aria-label="Page title"]`, the
//     `[role="tablist"][aria-label="Editor tabs"]` of TabBar.tsx and its
//     `[role="tab"]` buttons (Ctrl+T opens one), `[aria-label="Search blocks"]`,
//     `[data-testid="search-results-count"]` reading "No results",
//     `[data-testid="search-result-row-<id>"]`, `#journal-tab-daily` /
//     `#journal-tab-weekly`, and a DaySection's "Open <date> in editor".
//   - `[data-testid="suggestion-item"]`     an item of the open `/` / `[[` /
//     `#` / `::` picker (SuggestionList.tsx), `aria-selected` on the one Enter
//     picks; the create item's id is `suggestion-__create__`.
//   - A Settings tab (`openSettingsTab`): `#settings-tab-<id>` and its
//     `[data-testid="settings-panel-<id>"]` (pages/SettingsView.tsx).
//   - Settings › Data › "Open edit history" (`openEditHistory`):
//     `#settings-tab-data`, `[data-testid="settings-panel-data"]`, and the
//     History view's `[role="grid"][aria-label="History entries"]`.
//   - Settings › Data's markdown import (`importMarkdownPage`):
//     `[data-testid="import-file-input"]` and `[data-testid="import-result"]`
//     (ImportSection.tsx), whose summary reads `Imported “<title>”: N blocks`.
//   - Repeating tasks (`taskRows`, `occurrenceIn`, `cycleTaskTo`,
//     `pickRepeatCommand`): a `[data-testid="sortable-block"]` row per
//     occurrence, its `[data-testid="task-marker"]` checkbox named
//     `Task: <STATE>. Click to cycle.` (`block.taskCycle`), and the slash
//     menu's `REPEAT …` items (slash-commands.ts).
//   - A property chip's accessible name, `<Key>: <value>`
//     (`property.selectValue`, PropertyChip.tsx), the slash item
//     "LOCATION Office — Office" (slash-commands.ts) and its toast "Set
//     location to Office" (`blockTree.setLocationMessage`).
//   - The SpaceSwitcher (`switchToSpace`, `switcherLabel`): the Radix
//     `Select` trigger `[aria-label="Switch space"]` (layout/SpaceSwitcher.tsx)
//     and its `[role="option"]` items, one per space plus "Manage spaces…".
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { type Socket, createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Boot of a real WebKitWebView + first live-backend IPC round-trip is slower
// than a headless-chrome mock, so keep every wait generous and never race.
export const APP_READY_TIMEOUT = 60_000
// Runs 30061419172 / 30059678579 measured MARGINAL timeouts on the shared CI
// runner: failed durable-read asserts had their element in the DOM by the
// time the afterTest diagnostics captured it seconds later. This is a weekly
// non-blocking lane — generous waits cost nothing when green, so every
// interaction gets the full boot-scale budget.
export const NAV_TIMEOUT = 60_000
export const ACTION_TIMEOUT = 60_000

/** Primary nav destinations addressable by their sidebar label. */
export type NavLabel = 'Journal' | 'Tags' | 'Pages' | 'Search' | 'Settings'

/**
 * Resolve a primary sidebar nav `<button>` by its exact visible label, using a
 * genuinely subtree-scoped XPath (leading `.` — honoured by WDIO relative to
 * the sidebar root). Matches ONLY the nav button whose label `<span>` is exactly
 * `label` (AppSidebar.tsx renderNavItem), never the like-named Journal `<h1>`
 * heading or a QuickAccessBar chip. See the selector-policy header for the full
 * rationale behind not using `aria/<label>` here.
 */
function sidebarNavButton(label: NavLabel | 'New Page') {
  const sidebar = $('[data-slot="sidebar"]')
  return sidebar.$(`.//button[@aria-label="${label}" or .//span[normalize-space(.)="${label}"]]`)
}

/**
 * Wait until the app has booted against the real backend: the desktop sidebar
 * has mounted (BootGate resolved) and the Journal nav is displayed. The default
 * 1024px window is above the md breakpoint, so the sidebar is visible.
 */
export async function waitForAppReady(): Promise<void> {
  const sidebar = $('[data-slot="sidebar"]')
  await sidebar.waitForExist({ timeout: APP_READY_TIMEOUT })
  await dismissWelcomeModalIfPresent()
  const journalNav = sidebarNavButton('Journal')
  await journalNav.waitForDisplayed({ timeout: NAV_TIMEOUT })
  // Focus-gated behaviour (the empty-block cleanup) is a silent no-op in an
  // unfocused window, so a lane without focus must fail here, not pass those
  // specs vacuously (#5457).
  await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
    timeout: NAV_TIMEOUT,
    timeoutMsg: 'document.hasFocus() is false: run the lane under a window manager (#5457)',
  })
}

/**
 * First-boot only: the onboarding dialog (WelcomeModal.tsx,
 * `data-testid="welcome-modal"`, shown while `!isOnboardingDone()`) is a modal
 * Radix Dialog — it aria-hides the whole app root and intercepts pointer
 * events, which broke every block-create flow in live run 30052635297 (the
 * two specs that passed only did so because a stray overlay click dismissed
 * it). Dismiss it deterministically via its "Get Started" button
 * (welcome.getStarted, common.ts:291), which also persists the onboarding
 * flag so it cannot re-open mid-session.
 */
export async function dismissWelcomeModalIfPresent(): Promise<void> {
  const modal = $('[data-testid="welcome-modal"]')
  const appeared = await modal.waitForExist({ timeout: 5_000 }).then(
    () => true,
    () => false,
  )
  if (!appeared) return
  const getStarted = modal.$('button*=Get Started')
  await getStarted.waitForClickable({ timeout: NAV_TIMEOUT })
  await getStarted.click()
  await modal.waitForExist({ reverse: true, timeout: NAV_TIMEOUT })
}

/**
 * Click a primary sidebar nav destination and wait for the view to actually
 * switch. Readiness is confirmed by the clicked button gaining
 * `aria-current="page"` (AppSidebar.tsx renderNavItem), which is set only once
 * `currentView === item.id` — a robust, view-agnostic signal that survives the
 * async reprojection the real backend performs on every view change.
 *
 * Idempotent: if the target is ALREADY the active view (the button already
 * reports `aria-current="page"` — e.g. the default boot view is Journal), the
 * click is skipped. This avoids a spurious no-op click on an already-active
 * destination and makes an early `navigateTo('Journal')` cheap.
 *
 * The nav is re-queried inside the sidebar on each call so the helper needs no
 * caller-passed element; the sidebar `[data-slot="sidebar"]` node is stable
 * (React keys the nav buttons by id, so `aria-current` updates in place).
 */
export async function navigateTo(label: NavLabel): Promise<void> {
  const nav = sidebarNavButton(label)
  await nav.waitForDisplayed({ timeout: NAV_TIMEOUT })
  // Tolerate the target already being active — skip the click if so.
  if ((await nav.getAttribute('aria-current')) === 'page') return
  await nav.waitForClickable({ timeout: NAV_TIMEOUT })
  await nav.click()
  await browser.waitUntil(async () => (await nav.getAttribute('aria-current')) === 'page', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `sidebar nav "${label}" never became the active view (aria-current="page")`,
  })
}

/**
 * Suffix unique to this WDIO WORKER PROCESS.
 *
 * WDIO forks a worker — and `wdio.conf.ts` therefore starts a fresh session,
 * `tauri-driver`, app boot and sandbox vault — PER SPEC FILE, so each spec file
 * gets its own module instance and its own value here. That is more uniqueness
 * than `runScopedMarker` needs, not less: the pid disambiguates spec files
 * within a run and the timestamp disambiguates runs, so no two markers collide
 * either way. (The same per-spec-file forking is why every spec now starts from
 * a virgin vault, which is what `typeInputVerified` and `openJournalBlockEditor`
 * are defending against.)
 */
const RUN_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}`

/**
 * Scope a marker to this run (#3334).
 *
 * `blockStaticByMarker` matches by SUBSTRING, so a fixed marker cannot tell
 * "the block this spec just created" apart from "an identical block a previous
 * run left behind". With a per-run vault that leftover can no longer exist —
 * but the two mechanisms fail independently, and the cost of a suffix is a
 * dozen extra keystrokes. Belt and braces on an assertion whose whole job is to
 * distinguish "durably persisted" from "looks persisted".
 *
 * The dedupe pass is load-bearing, not cosmetic: `typeMarkerVerified` documents
 * that WebKit coalesces adjacent duplicate keystrokes, so a marker containing
 * `mm` or `88` could never be typed back intact. Collapsing runs of repeated
 * characters keeps every generated marker typeable. (It is a no-op on the fixed
 * prefixes, none of which contain a repeated character.)
 */
export function runScopedMarker(base: string): string {
  return `${base}-${RUN_ID}`.replace(/(.)\1+/g, '$1')
}

/** `d` as the local `YYYY-MM-DD` the journal names a day by. */
export function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Locate a committed block row by a substring of its text. A non-focused block
 * renders as StaticBlock (`data-testid="block-static"`); `*=` matches its text.
 * Returned lazily (chainable) so callers can `waitForDisplayed` /
 * `getAttribute('data-block-id')` / assert on it as needed.
 */
export function blockStaticByMarker(marker: string) {
  return $(`[data-testid="block-static"]*=${marker}`)
}

/**
 * Open the Journal daily view's block editor and return the focused
 * contenteditable, tolerating BOTH first-block CTAs.
 *
 * On a vault that ALREADY has a journal page for the day, DaySection renders the
 * `AddBlockButton` ("Add block" — `action.addBlock`, DaySection.tsx:509-512). On
 * a VIRGIN vault where today's page does not exist yet, `entry.pageId` is null
 * and DaySection instead renders the empty-state CTA labelled "Add your first
 * block" (`journal.addFirstBlock`, DaySection.tsx:470-501). Both buttons call
 * the SAME `onAddBlock(dateStr)` -> `handleAddBlock` handler
 * (useJournalBlockCreation.ts), which creates the page if needed and seeds +
 * focuses a first block (template path or BlockTree's `autoCreateFirstBlock`),
 * so BOTH paths end with a mounted, focused roving editor. A `button*=Add block`
 * selector matches only the first label ("Add your first block" does not contain
 * the substring "Add block"), which is why the virgin-vault first session
 * (#3078 / session-949) timed out. The XPath union below matches either CTA.
 */
export async function openJournalBlockEditor(): Promise<void> {
  const addBlock = $(
    './/button[contains(normalize-space(.), "Add block") or ' +
      'contains(normalize-space(.), "Add your first block")]',
  )
  // First boot on a virgin vault renders the Journal shell quickly but the day
  // section (and its CTA) only after today's page auto-creates behind the
  // calendar-dates load + boot-time index rebuilds — observed >30s under CI
  // load (run 30059678579: shell testids present, no day-section content at
  // 30s). Give the FIRST interactive element the full boot budget.
  await addBlock.waitForClickable({ timeout: APP_READY_TIMEOUT })
  await addBlock.click()

  // The virgin-vault empty-state path ("Add your first block") seeds the first
  // block but can settle it straight to a StaticBlock without the roving
  // editor ever mounting focused (observed live in run 30057838392: block-tree
  // + block-static present, no block-editor). If the editor doesn't appear,
  // click the (empty) static block to enter edit mode instead of timing out.
  const editorSelector = '[data-testid="block-editor"] [contenteditable="true"]'
  const appeared = await $(editorSelector)
    .waitForDisplayed({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    )
  if (!appeared) {
    // `getElements()` resolves the lazy `$$` chain ONCE, into a plain array.
    // Reading `.length` off the chainable and then indexing it re-queries the
    // DOM on each access, so the index could address a different (shorter)
    // list than the one that was counted; a single snapshot cannot go stale
    // between the two reads. The empty case is the `undefined` case, so the
    // count check and the index check are the same check.
    const statics = await $$('[data-testid="block-static"]').getElements()
    const lastStatic = statics.at(-1)
    // The fallback fails closed on anything but the empty seed block: clicking
    // a static that already holds text would hand `typeMarkerVerified` a
    // non-empty editor, which its retry clears. "Empty" is the `.block-placeholder`
    // span `StaticBlock` renders in place of content, NOT empty text: that span
    // holds the visible "Type / for commands..." hint, so a text check reads the
    // seed block as non-empty and the fallback never fires (run 35750968153).
    if (lastStatic !== undefined && (await lastStatic.$('.block-placeholder').isExisting())) {
      await lastStatic.click()
      await $(editorSelector).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    } else {
      // 10 s is the virgin-vault fast path, not a verdict: the CTA can simply
      // be slow under CI load. Keep waiting, then say exactly what was seen.
      const seen = lastStatic === undefined ? 'absent' : JSON.stringify(await lastStatic.getText())
      await $(editorSelector).waitForDisplayed({
        timeout: ACTION_TIMEOUT,
        timeoutMsg:
          'openJournalBlockEditor: Add-block CTA clicked but no block editor appeared; last ' +
          `block-static is ${seen}, not the empty virgin-vault seed block, so the ` +
          'click-the-last-static fallback does not apply',
      })
    }
  }
  await $(editorSelector).click()
}

/**
 * Type `text` into the focused block editor and VERIFY it landed intact,
 * retrying up to `MAX_TYPE_ATTEMPTS` times.
 *
 * Keystrokes sent through WebKitGTK's driver can be lost (see
 * `distinctKeyChunks`), and a block with mangled text still commits, so a
 * `*=${marker}` substring assertion could never match. This read-back-and-retype
 * loop makes the typed text an asserted invariant rather than a best-effort
 * stream: after typing we compare the editor's text to `text`, and on mismatch
 * select-all + delete and retype. It throws (with both strings) rather than
 * committing corrupt text.
 *
 * The roving editor must already be open and focused (call
 * `openJournalBlockEditor` first). The editor element is re-resolved on every
 * attempt so a mid-type ProseMirror re-render can't leave us holding a stale
 * handle. Does NOT commit — the caller presses Enter/Escape after this resolves.
 */
export async function typeMarkerVerified(text: string): Promise<void> {
  await typeVerified(
    '[data-testid="block-editor"] [contenteditable="true"]',
    text,
    (selector) => $(selector).getText(),
    'block editor',
  )
}

/**
 * `typeMarkerVerified` for a plain `<input>` (#3334).
 *
 * Same dropped-keystroke hazard, same retry-and-verify loop; the only
 * difference is that an input's content is read with `getValue()` rather than
 * `getText()`. Split out because the tag spec types a run-scoped name into the
 * TagList form and then asserts on `[data-testid="tag-item-<name>"]` — an
 * EXACT-match selector, which a single dropped character turns into a
 * guaranteed, and thoroughly misleading, timeout.
 */
export async function typeInputVerified(selector: string, text: string): Promise<void> {
  await typeVerified(selector, text, (sel) => $(sel).getValue(), 'input')
}

/**
 * Click `selector` to focus it, unless it already has focus. A block editor
 * that Enter just moved into still shifts while the rows above it settle (a
 * pasted image's static render resolving its bytes, the attachment badge), and
 * a click at a centre WebDriver computed before the shift lands on what moved
 * there: the formatting toolbar's "Set due date" opened the date picker, which
 * took the rest of the keystrokes and covered the sidebar. The click waits
 * for nothing to cover the box: a menu that opened it (the page kebab's "Add
 * alias") still covers it while it animates out, and that click is refused.
 */
async function focusForTyping(selector: string): Promise<void> {
  const focused = await browser.execute(
    (sel: string) => document.activeElement === document.querySelector(sel),
    selector,
  )
  if (focused) return
  await $(selector).waitForClickable({ timeout: ACTION_TIMEOUT })
  await $(selector).click()
}

/**
 * Split `text` into runs in which no character repeats, each to go out as its
 * own `browser.keys` call. That call presses every key down before it releases
 * any, and WebKitGTK's driver loses a key pressed again while it is still held:
 * an adjacent repeat (`[[` arrives as `[`) and every space after the first
 * (`zap of ink` arrives as `zap ofink`).
 */
export function distinctKeyChunks(text: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  for (const ch of text) {
    if (chunk.includes(ch)) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk !== '') chunks.push(chunk)
  return chunks
}

/**
 * Shared implementation behind `typeMarkerVerified` / `typeInputVerified`;
 * called directly for any other text box, such as the page title.
 *
 * `readBack` is what makes the typed text an asserted invariant rather than a
 * best-effort stream, and is the only thing that differs between a
 * contenteditable and an `<input>`. `clear` undoes a mangled attempt before
 * the retry; by default it empties the whole box.
 */
export async function typeVerified(
  selector: string,
  text: string,
  readBack: (selector: string) => Promise<string>,
  what: string,
  clear: (selector: string) => Promise<void> = async () => {
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
  },
): Promise<void> {
  const MAX_TYPE_ATTEMPTS = 3
  // A read-back unchanged this long has settled: the keys are all dispatched
  // before `browser.keys` resolves, so a wrong text that stops moving is final.
  const READ_BACK_SETTLED_MS = 400
  const editorSelector = selector
  let lastSeen = ''
  for (let attempt = 1; attempt <= MAX_TYPE_ATTEMPTS; attempt++) {
    await $(editorSelector).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await focusForTyping(editorSelector)
    // A retry types one key at a time, in case the drop was not the driver's.
    const chunks = attempt === 1 ? distinctKeyChunks(text) : Array.from(text)
    for (const chunk of chunks) {
      await browser.keys(Array.from(chunk))
      await browser.pause(40)
    }
    // Poll briefly: ProseMirror applies the transaction and re-renders text
    // asynchronously, so read back under a short waitUntil rather than once.
    let previous: string | undefined
    let changedAt = Date.now()
    try {
      await browser.waitUntil(
        async () => {
          lastSeen = (await readBack(editorSelector)).trim()
          if (lastSeen !== previous) {
            previous = lastSeen
            changedAt = Date.now()
          }
          return lastSeen === text || Date.now() - changedAt >= READ_BACK_SETTLED_MS
        },
        { timeout: 3_000, interval: 200 },
      )
    } catch {
      // Still changing after the budget: `lastSeen` decides, as for a settled read.
    }
    if (lastSeen === text) return
    if (attempt < MAX_TYPE_ATTEMPTS) {
      await focusForTyping(editorSelector)
      await clear(editorSelector)
    }
  }
  throw new Error(
    `${what} text never matched the expected value after ${MAX_TYPE_ATTEMPTS} attempts — ` +
      `keystrokes were dropped by the live WebKit editor. ` +
      `expected=${JSON.stringify(text)} lastSeen=${JSON.stringify(lastSeen)}`,
  )
}

/**
 * Create a block in the Journal daily view carrying a unique marker, and wait
 * for it to commit and render as a StaticBlock. Mounts the roving TipTap editor
 * via the first-block CTA (either "Add block" or the virgin-vault "Add your
 * first block" — see `openJournalBlockEditor`), types the marker with
 * read-back verification (`typeMarkerVerified` — retries dropped keystrokes),
 * then Enter flushes the create op through the live backend and moves the roving
 * editor to a fresh sibling; Escape blurs out of that new editor. The final
 * `waitForDisplayed` proves the real backend accepted the op and the frontend
 * reprojected it.
 *
 * Assumes the Journal view is active (call `navigateTo('Journal')` first if a
 * prior step moved away).
 */
export async function addBlockWithMarker(marker: string): Promise<void> {
  await openJournalBlockEditor()
  await typeMarkerVerified(marker)
  await browser.keys(['Enter'])
  await browser.keys(['Escape'])

  const committed = blockStaticByMarker(marker)
  await committed.waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

/**
 * Every committed block row whose text contains `marker`, resolved ONCE into a
 * plain array (see the `getElements()` note in `openJournalBlockEditor`). For
 * a spec that seeds N marked rows and must assert on all N, not just the
 * first match `blockStaticByMarker` returns.
 */
export function blockStaticsByMarker(marker: string) {
  return $$(`[data-testid="block-static"]*=${marker}`).getElements()
}

/**
 * Click `element` while holding Control: the block-selection toggle (the
 * Playwright twin is `ctrlSelectById` in `e2e/block-paste-outline.spec.ts`).
 * One W3C action chain — the key source presses Control a tick before the
 * pointer moves and releases it a tick after the button comes up, so the click
 * carries `ctrlKey`. The click lands 6 px in from the top-left corner, clear of
 * inline chips and the text a centred click could start a drag on.
 */
export async function ctrlClick(element: ReturnType<typeof $>): Promise<void> {
  const target = await element.getElement()
  const { width, height } = await target.getSize()
  await browser.actions([
    browser.action('key').down('\uE009').pause(0).pause(0).pause(0).up('\uE009'),
    browser
      .action('pointer')
      .pause(0)
      .move({ origin: target, x: Math.round(6 - width / 2), y: Math.round(6 - height / 2) })
      .down()
      .up(),
  ])
}

/**
 * Open `element`'s context menu by sending it the `contextmenu` event a
 * right-click sends. A WebDriver right-click is not that: WebKitWebDriver
 * releases the right button as the left one (`mouseup` and `click` with
 * `button` 0), so on a static block it also focuses the block, and the editor
 * that mounts takes focus a moment later, closing any popover opened since
 * (the property drawer's "Add property" picker, #5881).
 */
export async function openContextMenu(element: ReturnType<typeof $>): Promise<void> {
  await element.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await browser.execute(
    (target: HTMLElement) => {
      const { left, top, width, height } = target.getBoundingClientRect()
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX: left + width / 2,
          clientY: top + height / 2,
        }),
      )
    },
    await element.getElement(),
  )
}

/**
 * Open block `id`'s property drawer from its row's context menu, and wait for
 * the sheet to finish sliding in. WebDriver clicks a centre it computed before
 * the slide moved on, so a click on the moving sheet lands beside its target
 * and does nothing: the Close button never closed the drawer, and "Add
 * property" opened no picker.
 */
export async function openPropertyDrawer(id: string): Promise<void> {
  await openContextMenu($(`[data-testid="sortable-block"][data-block-id="${id}"]`))
  const item = $('[role="menuitem"]*=Properties')
  await item.waitForClickable({ timeout: ACTION_TIMEOUT })
  await item.click()
  const drawer = $('[role="dialog"]*=Block Properties')
  await drawer.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const sheet = await drawer.getElement()
  await browser.waitUntil(
    () => browser.execute((el: HTMLElement) => el.getAnimations().length === 0, sheet),
    { timeout: ACTION_TIMEOUT, timeoutMsg: 'the Block Properties sheet never finished sliding in' },
  )
}

/**
 * Press End and Enter in the roving editor's block, and return the id of the
 * blank sibling Enter created once the editor is in it. Enter's create is a
 * round-trip, and until it answers the editor still sits, emptied, in the
 * block it left, so the wait is for a blank block with a different id: acting
 * any sooner (a paste, an Escape) lands on the wrong block.
 */
export async function enterBlankSibling(): Promise<string> {
  const editor = '[data-testid="block-editor"] [contenteditable="true"]'
  const readEditor = () =>
    browser.execute((sel: string) => {
      const el = document.querySelector(sel)
      return {
        id: el?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
        text: el?.textContent ?? null,
      }
    }, editor)
  const source = (await readEditor()).id
  if (source === null) throw new Error('enterBlankSibling: no block editor is open')
  await browser.keys(['End'])
  await browser.keys(['Enter'])
  let last: { id: string | null; text: string | null } = { id: null, text: null }
  const blank = await browser
    .waitUntil(
      async () => {
        last = await readEditor()
        return last.id !== null && last.id !== source && last.text === '' ? last.id : false
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `expected the editor in a new blank block below ${source}, got ${JSON.stringify(last)}`,
      )
    })
  return blank
}

/**
 * Assert that nothing matching `selector` is in the DOM, after a nav
 * round-trip re-queried the backend. Absence alone also holds on a page that
 * has not finished rendering yet, so callers put it AFTER the
 * positive readiness signal of the view (`navigateTo`'s `aria-current`, a
 * sibling row that must be present). Each poll is a fresh find inside
 * `waitUntil`, which retries a poll that throws: WebKitWebDriver fails a find
 * whose match leaves the DOM mid-find ("Stale element found when trying to
 * create the node handle"), and a `$()` resolved outside the wait threw that
 * straight out.
 */
export async function expectAbsent(selector: string, what: string): Promise<void> {
  await browser.waitUntil(async () => (await $$(selector).getElements()).length === 0, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `${what} is still present after the round-trip (${selector})`,
  })
}

/**
 * Click the sidebar's "New Page" ACTION button (not a nav destination), which
 * opens the New page dialog (#5637), and wait for the dialog's title field,
 * which takes focus.
 */
export async function openNewPageDialog(): Promise<void> {
  const button = sidebarNavButton('New Page')
  await button.waitForClickable({ timeout: NAV_TIMEOUT })
  await button.click()
  await $('#new-page-name').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/**
 * Create a page and open it: the New page dialog, `title` if given (blank
 * otherwise), then Enter. Unlike `navigateTo` there is no `aria-current` to
 * wait on, so readiness is the page editor's title textbox (`PageTitleEditor`,
 * aria-label `pageHeader.pageTitle`) plus the auto-created, auto-focused first
 * block's editor (`use-block-auto-create-first-block.ts`). With a title it
 * waits for that title, because a page from an earlier case may still be open.
 */
export async function openNewPage(title?: string): Promise<void> {
  await openNewPageDialog()
  if (title !== undefined) await typeInputVerified('#new-page-name', title)
  await browser.keys(['Enter'])
  if (title === undefined) {
    await $('[aria-label="Page title"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
  } else {
    await browser.waitUntil(
      async () => (await $('[aria-label="Page title"]').getText()) === title,
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: `the page ${title} never opened`,
      },
    )
  }
  await $('[data-testid="block-editor"] [contenteditable="true"]').waitForDisplayed({
    timeout: ACTION_TIMEOUT,
  })
}

/**
 * Press `chord` (xdotool's spelling) at the X server, where
 * `tauri-plugin-global-shortcut` grabs the Quick Capture hotkey: WebDriver's
 * keys go only to the focused webview.
 */
export function pressChord(chord: string): void {
  try {
    execFileSync('xdotool', ['key', chord])
  } catch (err) {
    throw new Error(
      `xdotool key ${chord} failed; the lane needs xdotool to press OS chords: ${String(err)}`,
    )
  }
}

/** Confirm the open `[role="alertdialog"]` (ConfirmDialog) with its `label` button and wait for it to close. */
export async function confirmDialog(label: string): Promise<void> {
  const dialog = $('[role="alertdialog"]')
  await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const confirm = dialog.$(`button=${label}`)
  await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
  await confirm.click()
  await dialog.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

/**
 * Re-open a page from the Pages view by its exact title. The title is the
 * `span.page-browser-item-title` inside the row's `button.page-browser-item`
 * (PageBrowser/PageRow.tsx); the button itself also holds the metadata
 * span, so the match is on the title span and the click bubbles to the
 * button. The page editor is ready once its title textbox is displayed. This
 * is the durable-read hop for page-editor specs: PageEditor and its BlockTree
 * unmount on the way out and re-fetch on the way back.
 */
export async function reopenPageByTitle(title: string): Promise<void> {
  await navigateTo('Pages')
  const titleSpan = $(
    `.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`,
  )
  await titleSpan.waitForClickable({ timeout: NAV_TIMEOUT })
  await titleSpan.click()
  await $('[aria-label="Page title"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

const APP_BINARY =
  process.env['TAURI_APP_BINARY'] ??
  path.resolve(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'agaric')

/** PIDs of the app binary under test; the lane runs one spec file at a time. */
function appPids(): number[] {
  const binary = realpathSync(APP_BINARY)
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        return readlinkSync(`/proc/${entry}/exe`) === binary
      } catch {
        return false
      }
    })
    .map(Number)
}

/**
 * End the app and open it again on the same vault: the app process ends and a
 * new one opens it, so nothing the webview held survives.
 *
 * The restart ends the WebDriver session and starts another: `tauri-driver`
 * keeps the sandbox's `AGARIC_DATA_DIR`, so the new app opens the same vault.
 * The old app must be gone first, or the new one hands its launch to it over
 * the single-instance D-Bus name and the session never starts (see
 * `reapSessionApp` in wdio.conf.ts).
 *
 * `'close'` ends the session and lets the app shut down; `'kill'` sends the
 * app SIGKILL first, so it gets no chance to save anything on the way out
 * (a crash, or the OS killing it).
 */
export async function restartApp(how: 'close' | 'kill' = 'close'): Promise<void> {
  if (how === 'kill') {
    for (const pid of appPids()) process.kill(pid, 'SIGKILL')
  } else {
    await browser.deleteSession()
  }
  await browser.waitUntil(() => Promise.resolve(appPids().length === 0), {
    timeout: NAV_TIMEOUT,
    interval: 200,
    timeoutMsg: `the app (pid ${appPids().join(', ')}) outlived its session`,
  })
  // A killed app's session is deleted here; the error that answers is suppressed.
  await browser.reloadSession()
  await waitForAppReady()
}

/** Leave page `title` and come back, so the rows holding `marker` are the backend's. */
export async function reopenPageHolding(title: string, marker: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle(title)
  await blockStaticByMarker(marker).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/**
 * Wait for a sonner toast whose text contains `text`. Toasts carry no testid
 * (ui/sonner.tsx); sonner stamps `data-sonner-toast` on each `<li>`.
 *
 * The match is done in JS over the resolved elements rather than with WDIO's
 * `*=` partial-text selector, which compiles to `contains(., "<text>")` and
 * therefore produces INVALID XPath the moment the expected text contains a
 * double quote (run 34065136247: `Attached "wdio-paste.png"` — the toast
 * template `blockTree.attachedFileMessage` quotes the filename — failed with
 * `invalid selector: The string did not match the expected pattern`). One
 * `execute` reads every toast: a toast resolved by one command can be
 * re-rendered away before the next reads its text, and that error ends the
 * wait.
 */
export async function waitForToast(text: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (wanted: string) =>
          [...document.querySelectorAll('[data-sonner-toast]')].some((toast) =>
            (toast.textContent ?? '').includes(wanted),
          ),
        text,
      ),
    {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `no toast containing ${JSON.stringify(text)} appeared`,
    },
  )
}

/**
 * Wait until the open `[[` or `#` picker offers an existing item named
 * `name`, not only the item that would create it. Closing a typed `[[name]]`
 * or `#name` resolves the name through the same search, which reads copies the
 * materializer writes after a create (FTS, `tags_cache`), and a miss creates a
 * second page or tag of that name.
 */
export async function waitForPickerToOffer(name: string): Promise<void> {
  let offered: string[] = []
  await browser
    .waitUntil(
      async () => {
        offered = await browser.execute(() =>
          [...document.querySelectorAll('[data-testid="suggestion-item"]')]
            .filter((item) => item.id !== 'suggestion-__create__')
            .map((item) => item.textContent ?? ''),
        )
        return offered.some((text) => text.includes(name))
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`the picker never offered ${name}; it offered ${JSON.stringify(offered)}`)
    })
}

/**
 * Pick an option from a Radix `Select` by a substring of its text.
 *
 * `SelectContent` is portaled to `document.body`, so the option is queried
 * globally, never chained off the trigger's ancestor. Substring (`*=`) rather
 * than exact: the SpaceSwitcher options append an aria-hidden hotkey chip
 * ("Ctrl+1") to the space name, which WDIO's exact-text match would include.
 * The pointer is moved off the trigger before the option click: the
 * SpaceSwitcher trigger carries a zero-delay Tooltip whose popper can render
 * over the open option list and swallow the click (the Playwright
 * `spaces-management.spec.ts` helper documents the same flake).
 */
export async function chooseSelectOption(
  triggerSelector: string,
  optionText: string,
): Promise<void> {
  const trigger = $(triggerSelector)
  await trigger.waitForClickable({ timeout: ACTION_TIMEOUT })
  await trigger.click()
  await browser.action('pointer').move({ x: 2, y: 2, origin: 'viewport' }).perform()
  const option = $(`[role="option"]*=${optionText}`)
  await option.waitForClickable({ timeout: ACTION_TIMEOUT })
  await option.click()
  await option.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

const SPACE_SWITCHER = '[aria-label="Switch space"]'

/**
 * The SpaceSwitcher trigger's label, read as DOM text: `getText()` returns ""
 * for it, because Radix's `SelectValue` is a portal target that the selected
 * item's text renders into from a subtree the closed Select keeps hidden.
 */
export async function switcherLabel(): Promise<string> {
  const label = await browser.execute(
    (selector: string) => document.querySelector(selector)?.textContent ?? '',
    SPACE_SWITCHER,
  )
  return label.trim()
}

/** Make `name` the active space through the SpaceSwitcher, and wait until the trigger shows it. */
export async function switchToSpace(name: string): Promise<void> {
  await chooseSelectOption(SPACE_SWITCHER, name)
  await browser.waitUntil(async () => (await switcherLabel()).includes(name), {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `space switcher never showed ${JSON.stringify(name)}`,
  })
}

/**
 * Paste a file into the FOCUSED block through the app's own paste handler.
 *
 * Attachments enter only by paste/drop on the editor (EditableBlock.tsx
 * `handlePaste` -> `processFileAttachments` -> `add_attachment_with_bytes`);
 * there is no picker. The event is dispatched on the
 * `[data-testid="block-editor"]` <section>, which owns React's `onPaste`, and
 * NOT on the contenteditable inside it: ProseMirror's own paste listener lives
 * there and, for a files-only DataTransfer, falls through to `capturePaste`,
 * which steals focus to a hidden div for 50 ms.
 *
 * WebKitGTK may refuse a `ClipboardEvent` constructed with `clipboardData`;
 * the handler reads only `clipboardData.files` and each file's
 * `name/type/size/arrayBuffer()`, so a plain `Event` with the property
 * defined on it is an equivalent payload.
 */
export async function pasteFileIntoFocusedBlock(
  base64: string,
  filename: string,
  mimeType: string,
): Promise<void> {
  await browser.execute(
    (b64: string, name: string, type: string) => {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const file = new File([bytes], name, { type })
      const target = document.querySelector('[data-testid="block-editor"]')
      if (target === null) throw new Error('pasteFileIntoFocusedBlock: no focused block editor')
      let payload: unknown
      try {
        const dt = new DataTransfer()
        dt.items.add(file)
        payload = dt.files.length === 1 ? dt : null
      } catch {
        payload = null
      }
      if (payload === null) {
        payload = { files: [file], items: [], types: ['Files'], getData: () => '' }
      }
      let event: Event | null = null
      try {
        const ce = new ClipboardEvent('paste', {
          clipboardData: payload as DataTransfer,
          bubbles: true,
          cancelable: true,
        })
        event = ce.clipboardData === payload ? ce : null
      } catch {
        event = null
      }
      if (event === null) {
        event = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: payload, configurable: true })
      }
      target.dispatchEvent(event)
    },
    base64,
    filename,
    mimeType,
  )
}

/**
 * Wait until block `id` renders exactly one image, decoded from a `blob:` URL:
 * GatedImage wraps the bytes `read_attachment` returns, so a decoded image
 * (`naturalWidth > 0`) proves the bytes are on disk.
 */
export async function expectImageRendered(id: string, when: string): Promise<void> {
  await $(`[data-block-id="${id}"]`).scrollIntoView()
  let seen: Array<{ src: string; complete: boolean; width: number }> = []
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(
          (blockId: string) =>
            [...document.querySelectorAll<HTMLImageElement>('[data-testid="image-rendered"]')]
              .filter(
                (img) => img.closest('[data-block-id]')?.getAttribute('data-block-id') === blockId,
              )
              .map((img) => ({
                src: img.getAttribute('src') ?? '',
                complete: img.complete,
                width: img.naturalWidth,
              })),
          id,
        )
        const [only] = seen
        return (
          seen.length === 1 &&
          only !== undefined &&
          only.src.startsWith('blob:') &&
          only.complete &&
          only.width > 0
        )
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}: the image block renders ${JSON.stringify(seen)}`)
    })
}

const PAGE_SOURCE = '[data-testid="page-source-editor"]'

/** A line of the source buffer: its text and the block id it carries (#5160 A). */
export interface SourceLine {
  text: string
  id: string | null
}

/** The open source buffer's lines. */
export async function pageSourceLines(): Promise<SourceLine[]> {
  return browser.execute(
    (selector: string) =>
      [...document.querySelectorAll(`${selector} [data-source-line]`)].map((line) => ({
        text: line.textContent ?? '',
        id: line.getAttribute('data-block-id'),
      })),
    PAGE_SOURCE,
  )
}

/** The open source buffer's text, as Save sends it. */
export async function pageSourceText(): Promise<string> {
  return (await pageSourceLines()).map((line) => line.text).join('\n')
}

/**
 * The page kebab's "Edit as Markdown" (#5140): the source editor, once its
 * buffer holds every one of `markers`.
 */
export async function openPageSource(markers: string[]) {
  const kebab = $('button[aria-label="Page actions"]')
  await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await kebab.click()
  const editAsMarkdown = $('[role="menuitem"]*=Edit as Markdown')
  await editAsMarkdown.waitForClickable({ timeout: ACTION_TIMEOUT })
  await editAsMarkdown.click()
  const source = $(PAGE_SOURCE)
  await browser.waitUntil(
    async () => {
      const text = await pageSourceText()
      return markers.every((marker) => text.includes(marker))
    },
    { timeout: ACTION_TIMEOUT, timeoutMsg: `the source editor never held ${markers.join(', ')}` },
  )
  return source
}

/**
 * Replace the source buffer with `lines`, each under the id it gives, in one
 * edit, as lines cut from the buffer paste back. Typed keys lose repeated
 * characters in this WebView (see `typeMarkerVerified`).
 */
export async function setPageSourceLines(lines: SourceLine[]): Promise<void> {
  await browser.execute(
    (selector: string, next: SourceLine[]) => {
      // TipTap keeps its editor on the editable element.
      const dom = document.querySelector<
        HTMLElement & { editor?: { commands: { setContent: (content: unknown) => boolean } } }
      >(selector)
      if (dom?.editor === undefined) throw new Error('setPageSourceLines: no source editor')
      dom.editor.commands.setContent({
        type: 'doc',
        content: next.map(({ text, id }) =>
          text === ''
            ? { type: 'line', attrs: { blockId: id } }
            : { type: 'line', attrs: { blockId: id }, content: [{ type: 'text', text }] },
        ),
      })
    },
    PAGE_SOURCE,
    lines,
  )
}

/** A place in the source buffer: `offset` characters into line `line`, both counted from 0. */
export interface SourceSpot {
  line: number
  offset: number
}

/**
 * Select `from` to `to` in the source buffer and send it a `type` clipboard
 * event holding `data`, which the buffer's own cut, copy and paste handlers
 * take; resolves to what the clipboard holds after. A plain `Event` carries a
 * stand-in for the system clipboard, which WebKitGTK may refuse on a
 * constructed `ClipboardEvent` (see `pasteFileIntoFocusedBlock`).
 */
export async function pageSourceClipboard(
  type: 'cut' | 'copy' | 'paste',
  from: SourceSpot,
  to: SourceSpot = from,
  data: Record<string, string> = {},
): Promise<Record<string, string>> {
  return browser.execute(
    (
      selector: string,
      kind: string,
      start: SourceSpot,
      end: SourceSpot,
      held: Record<string, string>,
    ) => {
      const dom = document.querySelector<
        HTMLElement & {
          editor?: {
            state: { doc: { child: (index: number) => { nodeSize: number } } }
            commands: { setTextSelection: (range: { from: number; to: number }) => boolean }
          }
        }
      >(selector)
      if (dom?.editor === undefined) throw new Error('pageSourceClipboard: no source editor')
      const { doc } = dom.editor.state
      const at = ({ line, offset }: SourceSpot): number => {
        let pos = 1
        for (let i = 0; i < line; i += 1) pos += doc.child(i).nodeSize
        return pos + offset
      }
      dom.editor.commands.setTextSelection({ from: at(start), to: at(end) })
      const store = new Map(Object.entries(held))
      const clipboardData = {
        getData: (format: string) => store.get(format) ?? '',
        setData: (format: string, value: string) => {
          store.set(format, value)
        },
        clearData: () => {
          store.clear()
        },
      }
      const event = new Event(kind, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboardData })
      dom.dispatchEvent(event)
      return Object.fromEntries(store)
    },
    PAGE_SOURCE,
    type,
    from,
    to,
    data,
  )
}

/**
 * Click the source editor's button whose text holds `name` (Save reads
 * `Save (2 changes)` once the buffer changed; the buffer sits in TipTap's own
 * wrapper, inside the div that also holds its toolbar), then move the pointer
 * off it. The "Markdown saved" toast slides in under a pointer left on Save,
 * WebKit reports that as the pointer entering it, and sonner then expands the
 * stack and holds every toast open: two saves later the stack covers Save and
 * Cancel for good.
 */
export async function clickPageSourceButton(name: string): Promise<void> {
  const button = $(PAGE_SOURCE).parentElement().parentElement().parentElement().$(`button*=${name}`)
  await button.waitForClickable({ timeout: ACTION_TIMEOUT })
  await button.click()
  await browser.action('pointer').move({ x: 2, y: 2, origin: 'viewport' }).perform()
}

/**
 * Open the Settings tab `tab` (its `SettingsTab` id), ready once its panel
 * shows. Leaving Settings and calling this again remounts the panel, so it
 * re-reads what the tab displays.
 */
export async function openSettingsTab(tab: string): Promise<void> {
  await navigateTo('Settings')
  const button = $(`#settings-tab-${tab}`)
  await button.waitForClickable({ timeout: NAV_TIMEOUT })
  await button.click()
  await $(`[data-testid="settings-panel-${tab}"]`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Settings › Data › "Open edit history", ready once the entries grid shows. */
export async function openEditHistory(): Promise<void> {
  await navigateTo('Settings')
  const dataTab = $('#settings-tab-data')
  await dataTab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await dataTab.click()
  const open = $('[data-testid="settings-panel-data"]').$('button*=Open edit history')
  await open.waitForClickable({ timeout: ACTION_TIMEOUT })
  await open.click()
  await $('[role="grid"][aria-label="History entries"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/**
 * Import `markdown` as the page `title` (the file name minus `.md`) through
 * Settings › Data's hidden `<input type="file">`, and resolve to the import
 * summary once it names the page. WebDriver's Element Send Keys sets a file
 * input's FileList from a path, so no native dialog opens; the `hidden` class
 * comes off first because WebKitWebDriver applies the keyboard-interactability
 * check to file inputs.
 */
export async function importMarkdownPage(title: string, markdown: string): Promise<string> {
  await navigateTo('Settings')
  const dataTab = $('#settings-tab-data')
  await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
  await dataTab.click()
  await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'wdio-import-')), `${title}.md`)
  writeFileSync(file, markdown)
  const input = $('[data-testid="import-file-input"]')
  await input.waitForExist({ timeout: ACTION_TIMEOUT })
  await browser.execute(() => {
    document.querySelector('[data-testid="import-file-input"]')?.classList.remove('hidden')
  })
  await input.addValue(file)

  const result = $('[data-testid="import-result"]')
  await result.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await browser.waitUntil(async () => (await result.getText()).includes(`Imported “${title}”`), {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the import result never named ${title}`,
  })
  return result.getText()
}

/** The rows of the open page whose text holds `task`, one per occurrence of a repeating task. */
export function taskRows(task: string) {
  return $$(`[data-testid="sortable-block"]*=${task}`).getElements()
}

/** The id of the occurrence of `task` whose task checkbox reads `state`. */
export async function occurrenceIn(task: string, state: string): Promise<string> {
  let id: string | null = null
  await browser.waitUntil(
    async () => {
      for (const row of await taskRows(task)) {
        const marker = row.$('[data-testid="task-marker"]')
        if (!(await marker.isExisting())) continue
        if (((await marker.getAttribute('aria-label')) ?? '').startsWith(`Task: ${state}.`)) {
          id = await row.getAttribute('data-block-id')
          return true
        }
      }
      return false
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `no occurrence of the task reads ${state}` },
  )
  if (id === null) throw new Error(`no occurrence of the task reads ${state}`)
  return id
}

/** Click the task checkbox of block `id` until it reports `state`. */
export async function cycleTaskTo(id: string, state: string): Promise<void> {
  const marker = $(`[data-block-id="${id}"] [data-testid="task-marker"]`)
  await marker.waitForExist({ timeout: NAV_TIMEOUT })
  for (let click = 0; click < 5; click++) {
    const label = (await marker.getAttribute('aria-label')) ?? ''
    if (label.startsWith(`Task: ${state}.`)) return
    await marker.moveTo()
    await marker.click()
    await browser.waitUntil(async () => (await marker.getAttribute('aria-label')) !== label, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the task checkbox stayed at ${JSON.stringify(label)}`,
    })
  }
  throw new Error(`the task checkbox never reached ${state}`)
}

/** Open block `id` in the editor, the cursor after a space at its end. */
export async function editAtEnd(id: string): Promise<void> {
  await $(`[data-testid="block-static"][data-block-id="${id}"]`).click()
  await $('[data-testid="block-editor"] [contenteditable="true"]').waitForDisplayed({
    timeout: ACTION_TIMEOUT,
  })
  await browser.keys(['End'])
  await browser.keys([' '])
}

/**
 * Type `/repeat` into the focused editor and pick `label`. One key per call:
 * WebKit coalesces identical adjacent keys sent together. A space ends the
 * slash query, so the item is clicked by its label.
 */
export async function pickRepeatCommand(label: string): Promise<void> {
  for (const ch of '/repeat') await browser.keys([ch])
  const item = $(`[data-testid="suggestion-item"]*=${label}`)
  await item.waitForClickable({ timeout: ACTION_TIMEOUT })
  await item.click()
}

/** Text the clipboard plugin holds, read the way the paste chord reads it. */
export async function clipboardText(): Promise<string> {
  return await browser.execute(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<string | null> }
      }
    ).__TAURI_INTERNALS__
    return (await internals.invoke('plugin:clipboard-manager|read_text')) ?? ''
  })
}

/**
 * The bytes of the file a WebView download (`downloadBlob`'s `<a download>`)
 * wrote after `since` under a name `name` matches; the file is deleted once
 * read. The app registers no download handler, so WebKitGTK picks the folder:
 * with the sandbox's empty `XDG_CONFIG_HOME` there is no Downloads folder and
 * it writes to the app's working directory, which is this worker's. The home
 * folders are searched too. The size must hold still across two polls,
 * because the success toast fires before the write ends.
 */
export async function takeDownload(name: RegExp, since: number): Promise<Buffer> {
  const dirs = [process.cwd(), path.join(os.homedir(), 'Downloads'), os.homedir()]
  const sizes = new Map<string, number>()
  const settled = (): string | false => {
    for (const dir of dirs) {
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries.filter((e) => name.test(e))) {
        const file = path.join(dir, entry)
        const { mtimeMs, size } = statSync(file)
        if (mtimeMs < since - 2_000 || size === 0) continue
        if (sizes.get(file) === size) return file
        sizes.set(file, size)
      }
    }
    return false
  }
  const file = await browser
    .waitUntil(settled, { timeout: ACTION_TIMEOUT, interval: 500 })
    .catch(() => {
      throw new Error(`no download matching ${String(name)} landed in ${dirs.join(', ')}`)
    })
  const bytes = readFileSync(file)
  rmSync(file)
  return bytes
}

/**
 * Newline-delimited JSON-RPC over an MCP socket, requests pipelined, as the
 * agent whose token it connects with.
 */
export class McpClient {
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>()
  private readonly socket: Socket

  private constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline !== -1) {
        const message = JSON.parse(this.buffer.slice(0, newline)) as Record<string, unknown>
        this.buffer = this.buffer.slice(newline + 1)
        this.pending.get(message['id'] as number)?.(message)
        newline = this.buffer.indexOf('\n')
      }
    })
  }

  /** Writes `AGARIC-TOKEN <token>` first, as `agaric-mcp` does, and throws if `initialize` is refused. */
  static async connect(socketPath: string, token: string): Promise<McpClient> {
    const socket = createConnection(socketPath)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(`AGARIC-TOKEN ${token}\n`)
    const client = new McpClient(socket)
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'wdio', version: '1' },
    })
    if (init['result'] === undefined) throw new Error(`initialize: ${JSON.stringify(init)}`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return client
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const reply = new Promise<Record<string, unknown>>((resolve) => this.pending.set(id, resolve))
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return reply
  }

  /** `tools/call` that rejects on a protocol or tool error, resolving the JSON result. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = await this.request('tools/call', { name, arguments: args })
    const result = reply['result'] as
      | { isError?: boolean; content?: { type: string; text?: string }[] }
      | undefined
    const text = result?.content?.[0]?.text
    if (result?.isError === true || text === undefined) {
      throw new Error(`${name} failed: ${JSON.stringify(reply)}`)
    }
    return JSON.parse(text) as unknown
  }

  close(): void {
    this.socket.destroy()
  }
}
