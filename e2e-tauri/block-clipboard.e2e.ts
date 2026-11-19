// ---------------------------------------------------------------------------
// Real-backend block copy and paste through the system clipboard (#5140
// Phase 3b).
//
// Copy used to serialise the selection in TS, one block per line, and paste
// split the text on every newline: a two-line code block came back as a row
// per line, and a pasted copy lost its task state. Copy is now the backend's
// render (`get_blocks_source`) and paste its parse (`paste_blocks`), so a TODO
// parent keeps its state and its child, and a code block stays ONE block. The
// chords run both clipboard plugin calls, `write_text` and `read_text`, the
// latter granted by the capability file for the first time here. The
// Playwright twin (`e2e/block-paste-outline.spec.ts`) runs against the mock.
//
// The other plugin and capability paths share this boot:
// - The bug report (#5741 item 12, #5740 item 11): its integrity section, the
//   body copied verbatim through the clipboard plugin, and the ZIP with the log
//   files, which is bytes on disk. The App health counters and the integrity
//   check's rebuild of a seeded vault are `e2e/app-health.spec.ts`, on the bridge.
// - The opener plugin in an AppImage (#6871): an AppImage's launchers point
//   `LD_LIBRARY_PATH` and more into the bundle, and a program the app starts
//   inherits them, so on a host with a newer GLib `gio` and `flatpak` load the
//   bundle's libraries and exit before the browser opens. The AppImage ships
//   `src-tauri/scripts/appimage-xdg-open.sh` as its first `xdg-open` on PATH,
//   which strips the bundle before running the host's. wdio.conf.ts starts this
//   file's app the way an AppImage would, with that wrapper and a stand-in host
//   `xdg-open` behind it that records what it receives
//   (`SPECS_IN_AN_APPIMAGE_ENV`). A link or the data folder the opener opens
//   must reach the host's launcher with the app's environment minus the bundle.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appEnvironment,
  appVaultDir,
  blockStaticByMarker,
  clickUncovered,
  clipboardText,
  ctrlClick,
  enterBlankSibling,
  invoke,
  navigateTo,
  openDataTab,
  openNewPage,
  openSettingsTab,
  reopenPageByTitle,
  runScopedMarker,
  takeDownload,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const PARENT = runScopedMarker('wdio-clip-parent')
const CHILD = runScopedMarker('wdio-clip-kid')
const FIRST = runScopedMarker('wdio-clip-codeone')
const SECOND = runScopedMarker('wdio-clip-codetwo')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

const RESULT = 'output[aria-label="Integrity check result"]'
const PREVIEW = '[data-testid="bug-report-preview"]'

const TOKEN_REFERENCE_URL =
  'https://github.com/jfolcini/agaric/blob/main/docs/features/appearance.md#custom-css'

interface Launch {
  target: string
  ldLibraryPath: string
  appDir: string
}

interface RowShape {
  marker: string | null
  level: string | null
  task: string | null
  code: boolean
  both: boolean
}

/**
 * Every block row in document order, as the marker it holds, its outline
 * level, its task label and whether it renders a code block with both lines.
 * Rows are `sortable-block`, which a block keeps whether it renders static or
 * holds the editor; a code block is a `pre` either way.
 */
function rowShapes(): Promise<RowShape[]> {
  return browser.execute(
    (markers: string[], first: string, second: string) =>
      Array.from(document.querySelectorAll('[data-testid="sortable-block"]')).map((row) => {
        const item = row.closest('li[aria-level]')
        const text = row.textContent ?? ''
        return {
          marker: markers.find((m) => text.includes(m)) ?? null,
          level: item?.getAttribute('aria-level') ?? null,
          task:
            item?.querySelector('[data-testid="task-marker"]')?.getAttribute('aria-label') ?? null,
          code: row.querySelector('pre') !== null,
          both: text.includes(first) && text.includes(second),
        }
      }),
    [PARENT, CHILD, FIRST],
    FIRST,
    SECOND,
  )
}

/**
 * Wait until the editor sits in an EMPTY block at outline `level`: an indent
 * or dedent has landed on the blank block Enter opened.
 */
async function waitForEmptyEditorAt(level: string, what: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser
        .execute(() => {
          const editor = document.querySelector('[data-testid="block-editor"]')
          if (editor?.querySelector('p.is-editor-empty') == null) return null
          return editor.closest('li[aria-level]')?.getAttribute('aria-level') ?? null
        })
        .then((seen) => seen === level),
    { timeout: ACTION_TIMEOUT, timeoutMsg: what },
  )
}

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="sortable-block"]*=${PARENT}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Settings › App health, freshly mounted when the caller came from another view. */
async function openAppHealth(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-status')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await $('[data-testid="settings-panel-status"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/**
 * Press Run check on a freshly mounted App health tab and wait for the clean
 * answer; resolves to the block count and date the backend rebuilt from.
 */
async function runIntegrityCheck(): Promise<{ blocks: number; date: string }> {
  const result = $(RESULT)
  await result.waitForExist({ timeout: NAV_TIMEOUT })
  expect(await result.getText()).toBe('')
  const run = $('[data-testid="integrity-run-button"]')
  await run.waitForClickable({ timeout: ACTION_TIMEOUT })
  await run.click()
  let text = ''
  await browser
    .waitUntil(
      async () => {
        text = await result.getText()
        return text !== ''
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error('the integrity check never reported')
    })
  expect(text).toContain('Everything matches')
  const match = /from (\d+) blocks? on (\d{4}-\d{2}-\d{2})/.exec(text)
  if (match === null) throw new Error(`the integrity result names no block count: ${text}`)
  return { blocks: Number(match[1]), date: match[2] ?? '' }
}

function launches(): Launch[] {
  const record = path.join(appVaultDir(), 'launches.txt')
  if (!existsSync(record)) return []
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [target = '', ldLibraryPath = '', appDir = ''] = line.split('\t')
      return { target, ldLibraryPath, appDir }
    })
}

async function launchOf(isTarget: (target: string) => boolean, what: string): Promise<Launch> {
  let launch: Launch | undefined
  await browser.waitUntil(
    () => {
      launch = launches().find((l) => isTarget(l.target))
      return launch !== undefined
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `the launcher was never started for ${what}` },
  )
  return launch as Launch
}

/**
 * The `LD_LIBRARY_PATH` the launcher should get: the app's own, which must
 * start in the bundle or this spec proves nothing, minus the bundle's entries.
 */
function hostLibraryPath(): string {
  const env = appEnvironment()
  const bundle = `${env.get('APPDIR') ?? '<no APPDIR>'}/`
  const entries = (env.get('LD_LIBRARY_PATH') ?? '').split(':')
  expect(entries[0]?.startsWith(bundle)).toBe(true)
  const host = entries.filter((entry) => entry !== '' && !entry.startsWith(bundle))
  expect(host.length).toBeGreaterThan(0)
  return host.join(':')
}

describe('Agaric real-backend block clipboard (#5140 Phase 3b) @editor @settings @boot', () => {
  it('copies and pastes a TODO parent with its child and a code block, durably', async () => {
    await waitForAppReady()
    await openNewPage()

    // PARENT, then CHILD indented under it, then a code block back at the
    // top level. Enter moves the editor to a new sibling below.
    await typeMarkerVerified(PARENT)
    await enterBlankSibling()
    await browser.keys(['Control', 'Shift', 'ArrowRight'])
    await waitForEmptyEditorAt('2', 'the new block never indented under the parent')
    await typeMarkerVerified(CHILD)
    await enterBlankSibling()
    await browser.keys(['Control', 'Shift', 'ArrowLeft'])
    await waitForEmptyEditorAt('1', 'the new block never dedented to the top level')
    await browser.keys('/code'.split(''))
    const codeItem = $('[data-testid="suggestion-item"]*=Insert code block')
    await codeItem.waitForClickable({ timeout: ACTION_TIMEOUT })
    await codeItem.click()
    await $('[data-testid="block-editor"] pre').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    // Inside a code block Enter is a newline; the second line is paced like
    // `typeVerified`'s retry, since its read-back covers only a whole editor.
    await typeMarkerVerified(FIRST)
    await browser.keys(['Enter'])
    for (const ch of SECOND) {
      await browser.keys([ch])
      await browser.pause(40)
    }
    await browser.waitUntil(
      async () => {
        const text = await $(EDITOR).getText()
        return text.includes(FIRST) && text.includes(SECOND)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the two code lines never landed in the editor' },
    )

    // The sidebar click blurs and commits the code block.
    await reopenTheNewPage()

    // PARENT becomes a TODO; the page re-read shows its checkbox.
    const parentId = await $(`[data-testid="sortable-block"]*=${PARENT}`).getAttribute(
      'data-block-id',
    )
    await invoke('set_todo_state', { blockId: parentId, state: 'TODO' })
    await reopenTheNewPage()
    const taskMarker = $(`li[data-block-id="${parentId}"]`).$('[data-testid="task-marker"]')
    await browser.waitUntil(
      async () =>
        (await taskMarker.isExisting()) &&
        ((await taskMarker.getAttribute('aria-label')) ?? '').startsWith('Task: TODO'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the parent never became a TODO' },
    )

    // Block-select mode: the chords stand down while a block holds the editor.
    // Escape leaves it with that block selected (#5160 D17), and the second
    // Escape clears that selection so the Ctrl+clicks below start from none.
    if (await $('[data-testid="block-editor"]').isExisting()) {
      await browser.keys(['Escape'])
      await $('[data-testid="block-editor"]').waitForExist({
        reverse: true,
        timeout: ACTION_TIMEOUT,
      })
      await browser.keys(['Escape'])
    }
    await ctrlClick(blockStaticByMarker(PARENT))
    await ctrlClick(blockStaticByMarker(SECOND))
    await browser.waitUntil(
      async () => (await $('[data-testid="batch-toolbar"]').getText()).includes('2'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+click did not select the two roots' },
    )

    await browser.keys(['Control', 'c'])
    await browser.waitUntil(
      async () => {
        const text = await clipboardText()
        return text.includes(CHILD) && text.includes(SECOND)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+C never put the two roots on the clipboard' },
    )

    // Paste anchors on the last selected root, the code block.
    await browser.keys(['Control', 'v'])
    await browser.waitUntil(
      async () =>
        (await $$(`[data-testid="sortable-block"]*=${PARENT}`).getElements()).length === 2,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+V did not paste a copy of the parent' },
    )
    const toasts = await $$('[data-sonner-toast]').getElements()
    for (const toast of toasts) {
      expect(await toast.getText()).not.toContain('Failed to paste blocks')
    }

    // The durable read: the backend's rows after a round-trip. The original
    // pair, then the pasted copy right after the code block it was anchored
    // on: two TODO parents, each with its child nested under it, and two code
    // blocks each holding both lines — no row per line beside them.
    await reopenTheNewPage()
    await browser.waitUntil(async () => (await rowShapes()).length === 6, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the original and the pasted copy',
    })
    const rows = await rowShapes()
    expect(rows.map((r) => [r.marker, r.level])).toEqual([
      [PARENT, '1'],
      [CHILD, '2'],
      [FIRST, '1'],
      [PARENT, '1'],
      [CHILD, '2'],
      [FIRST, '1'],
    ])
    for (const row of rows.filter((r) => r.marker === PARENT)) {
      expect(row.task).toContain('Task: TODO')
    }
    for (const row of rows.filter((r) => r.marker === FIRST)) {
      expect(row.code).toBe(true)
      expect(row.both).toBe(true)
    }
  })

  it('puts the integrity section in the bug report, copies the body verbatim, and saves the ZIP with the logs (#5741, #5740)', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openAppHealth()
    const check = await runIntegrityCheck()

    const help = $('#settings-tab-help')
    await help.waitForClickable({ timeout: ACTION_TIMEOUT })
    await help.click()
    const report = $('[data-testid="settings-panel-help"]').$('button*=Report a bug')
    await report.waitForClickable({ timeout: ACTION_TIMEOUT })
    await report.click()

    const previewText = () =>
      browser.execute(
        (selector: string) => document.querySelector(selector)?.textContent ?? '',
        PREVIEW,
      )
    const section = `## Integrity check\n\nNo divergences — ${check.blocks} blocks scanned, ${check.date}.`
    await browser
      .waitUntil(async () => (await previewText()).includes(section), { timeout: ACTION_TIMEOUT })
      .catch(async () => {
        throw new Error(`the report body lacks ${JSON.stringify(section)}: ${await previewText()}`)
      })

    const includeLogs = $('#bug-report-include-logs')
    await includeLogs.waitForClickable({ timeout: ACTION_TIMEOUT })
    await includeLogs.click()
    let listed: string[] = []
    await browser
      .waitUntil(
        async () => {
          listed = await browser.execute(() =>
            [
              ...document.querySelectorAll('[data-testid="bug-report-logs-list"] li .font-mono'),
            ].map((name) => name.textContent ?? ''),
          )
          return listed.length > 0
        },
        { timeout: ACTION_TIMEOUT },
      )
      .catch(() => {
        throw new Error('the bug report listed no log file')
      })

    const copy = $('button*=Copy report')
    await copy.waitForClickable({ timeout: ACTION_TIMEOUT })
    await copy.click()
    await waitForToast('Report copied to clipboard')
    const body = await previewText()
    expect(await clipboardText()).toBe(body)

    const since = Date.now()
    const save = $('[data-testid="bug-report-download-zip"]')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await waitForToast('Saved agaric-bug-report-')
    const zip = await JSZip.loadAsync(
      await takeDownload(/^agaric-bug-report-\d{4}-\d{2}-\d{2}( \(\d+\))?\.zip$/, since),
    )

    const logs = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('logs/'))
    expect(logs.map((f) => f.name).toSorted()).toEqual(listed.map((n) => `logs/${n}`).toSorted())
    for (const log of logs) expect((await log.async('string')).length).toBeGreaterThan(0)
    const metadata = JSON.parse((await zip.file('metadata.json')?.async('string')) ?? '{}') as {
      app_version?: string
      device_id?: string
    }
    expect(metadata.device_id).toBe('[REDACTED_DEVICE_ID]')
    expect(body).toContain(metadata.app_version ?? 'metadata.json names no app_version')

    await browser.keys(['Escape'])
    await $(PREVIEW).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  })

  it('opens a link with the host environment, not the bundle (#6871)', async () => {
    await waitForAppReady()
    const expected = hostLibraryPath()

    await openSettingsTab('appearance')
    await clickUncovered(
      $('[data-testid="settings-panel-appearance"]').$('button=Token reference'),
      'the custom CSS token reference button',
    )

    const launch = await launchOf((t) => t === TOKEN_REFERENCE_URL, TOKEN_REFERENCE_URL)
    expect(launch.ldLibraryPath).toBe(expected)
    expect(launch.appDir).toBe('<unset>')
  })

  it('opens the data folder with the host environment, not the bundle (#6871)', async () => {
    const expected = hostLibraryPath()
    const vault = realpathSync(appVaultDir())

    await openDataTab()
    await clickUncovered(
      $('[data-testid="settings-panel-data"]').$('button=Open folder'),
      'the snapshot row open folder button',
    )

    const launch = await launchOf(
      (t) => existsSync(t) && realpathSync(t) === vault,
      `the vault folder ${vault}`,
    )
    expect(launch.ldLibraryPath).toBe(expected)
    expect(launch.appDir).toBe('<unset>')
  })
})
