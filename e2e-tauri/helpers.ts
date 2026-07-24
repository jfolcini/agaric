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
//   - `.//button[.//span[normalize-space(.)="<Label>"]]` scoped to the sidebar
//     AppSidebar.tsx renderNavItem renders each nav destination as
//     `<SidebarMenuButton><icon/><span>{label}</span>`, i.e. a `<button>`
//     (ui/sidebar.tsx SidebarMenuButton: `Comp = 'button'`) whose only label
//     `<span>` holds the i18n nav label (Journal / Tags / Pages / Settings).
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
//   - `[data-testid="block-editor"]`        the roving TipTap editor box.
//   - `[data-testid="block-static"]`        a committed (non-focused) block row
//     (StaticBlock; carries `data-block-id`).
// ---------------------------------------------------------------------------

// Boot of a real WebKitWebView + first live-backend IPC round-trip is slower
// than a headless-chrome mock, so keep every wait generous and never race.
export const APP_READY_TIMEOUT = 60_000
export const NAV_TIMEOUT = 30_000
export const ACTION_TIMEOUT = 30_000

/** Primary nav destinations addressable by their sidebar label. */
export type NavLabel = 'Journal' | 'Tags' | 'Pages' | 'Settings'

/**
 * Resolve a primary sidebar nav `<button>` by its exact visible label, using a
 * genuinely subtree-scoped XPath (leading `.` — honoured by WDIO relative to
 * the sidebar root). Matches ONLY the nav button whose label `<span>` is exactly
 * `label` (AppSidebar.tsx renderNavItem), never the like-named Journal `<h1>`
 * heading or a QuickAccessBar chip. See the selector-policy header for the full
 * rationale behind not using `aria/<label>` here.
 */
function sidebarNavButton(label: NavLabel) {
  const sidebar = $('[data-slot="sidebar"]')
  return sidebar.$(`.//button[.//span[normalize-space(.)="${label}"]]`)
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
    const lastStatic = $$('[data-testid="block-static"]')
    const count = await lastStatic.length
    if (count === 0) {
      throw new Error(
        'openJournalBlockEditor: neither a focused block editor nor any block-static appeared after the Add-block CTA',
      )
    }
    await (await lastStatic[count - 1]).click()
    await $(editorSelector).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  }
  await $(editorSelector).click()
}

/**
 * Type `text` into the focused block editor and VERIFY it landed intact,
 * retrying up to `MAX_TYPE_ATTEMPTS` times.
 *
 * `browser.keys(text.split(''))` streams one key event per character into the
 * live WebKit/TipTap editor. Under a janky first render (e.g. right after a
 * boot that full-replays the op-log, or while boot-time FTS/tag-ref rebuilds are
 * still firing) individual keystrokes are dropped — the real-backend lane
 * observed e.g. "wdio-journal-crossview" landing as "wdio-journal-crosview" and
 * "wdio real backend smoke …" losing its spaces. The block still committed and
 * rendered as a StaticBlock, but with mangled text, so a `*=${marker}` substring
 * assertion could never match. This read-back-and-retype loop makes the typed
 * text an asserted invariant rather than a best-effort stream: after typing we
 * compare the editor's text to `text`, and on mismatch select-all + delete and
 * retype. It throws (with both strings) rather than committing corrupt text.
 *
 * The roving editor must already be open and focused (call
 * `openJournalBlockEditor` first). The editor element is re-resolved on every
 * attempt so a mid-type ProseMirror re-render can't leave us holding a stale
 * handle. Does NOT commit — the caller presses Enter/Escape after this resolves.
 */
export async function typeMarkerVerified(text: string): Promise<void> {
  const MAX_TYPE_ATTEMPTS = 3
  const editorSelector = '[data-testid="block-editor"] [contenteditable="true"]'
  let lastSeen = ''
  for (let attempt = 1; attempt <= MAX_TYPE_ATTEMPTS; attempt++) {
    const editor = $(editorSelector)
    await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await editor.click()
    if (attempt === 1) {
      await browser.keys(text.split(''))
    } else {
      // Run 30057838392 proved the drop is DETERMINISTIC, not a race: adjacent
      // duplicate characters coalesce ("crossview"→"crosview" identically on
      // all attempts; "22"/"88" digit pairs each lost one). A plain retype can
      // therefore never converge. On retries, pace each keystroke so WebKit's
      // key handling sees distinct events even for repeated characters.
      for (const ch of text) {
        await browser.keys([ch])
        await browser.pause(40)
      }
    }
    // Poll briefly: ProseMirror applies the transaction and re-renders text
    // asynchronously, so read back under a short waitUntil rather than once.
    let matched = false
    try {
      await browser.waitUntil(
        async () => {
          lastSeen = (await $(editorSelector).getText()).trim()
          return lastSeen === text
        },
        { timeout: 3_000, interval: 200 },
      )
      matched = true
    } catch {
      matched = false
    }
    if (matched) return
    if (attempt < MAX_TYPE_ATTEMPTS) {
      // Clear the mangled attempt: select-all + delete, then retype.
      await $(editorSelector).click()
      await browser.keys(['Control', 'a'])
      await browser.keys(['Delete'])
    }
  }
  throw new Error(
    `block editor text never matched the marker after ${MAX_TYPE_ATTEMPTS} attempts — ` +
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
