// ---------------------------------------------------------------------------
// Real-backend Settings › App health and the bug report it feeds (#5741 items
// 11 and 12, #5740 item 11).
//
// The mock answers `get_status` with fixed numbers and the integrity check with
// "Everything matches" whatever the vault holds, and a download goes nowhere.
// Here the materializer counts real work, the reconciliation oracle rebuilds
// every derived table of a real vault, and the bug report's ZIP is bytes on
// disk. The three tests share one vault; each reads its own baseline, and the
// integrity result lives in SettingsView, so each leaves Settings before it
// runs a check.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  clipboardText,
  importMarkdownPage,
  navigateTo,
  runScopedMarker,
  takeDownload,
  waitForAppReady,
  waitForToast,
} from './helpers'

const RESULT = 'output[aria-label="Integrity check result"]'
const PREVIEW = '[data-testid="bug-report-preview"]'

/** Settings › App health, freshly mounted when the caller came from another view. */
async function openAppHealth(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-status')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await $('[data-testid="settings-panel-status"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** The Materializer status cards, label to number, once all four have loaded. */
async function readMetrics(): Promise<Record<string, number>> {
  let metrics: Record<string, number> = {}
  await browser.waitUntil(
    async () => {
      metrics = await browser.execute(() =>
        Object.fromEntries(
          [...document.querySelectorAll('.status-metric')].map((card) => [
            card.querySelector('.status-metric-label')?.textContent?.trim() ?? '',
            Number(card.querySelector('.status-metric-value')?.textContent),
          ]),
        ),
      )
      return Object.keys(metrics).length === 4
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: 'the Materializer status cards never loaded' },
  )
  return metrics
}

/** Wait until the polled metrics satisfy `ok`; the panel polls every 5 s. */
async function waitForMetrics(
  ok: (metrics: Record<string, number>) => boolean,
  what: string,
): Promise<Record<string, number>> {
  let metrics: Record<string, number> = {}
  await browser
    .waitUntil(
      async () => {
        metrics = await readMetrics()
        return ok(metrics)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}; the panel shows ${JSON.stringify(metrics)}`)
    })
  return metrics
}

const idle = (m: Record<string, number>) =>
  m['Foreground queue'] === 0 && m['Background queue'] === 0

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

describe('Agaric real-backend App health and bug report (#5741, #5740)', () => {
  it('counts the ops an edit burst dispatched, and the queues drain to 0', async () => {
    await waitForAppReady()
    await openAppHealth()
    const before = await waitForMetrics(idle, 'the materializer never went idle after boot')

    await navigateTo('Journal')
    const words = ['one', 'two', 'six']
    for (const word of words) await addBlockWithMarker(runScopedMarker(`wdio-health-${word}`))

    // A floor, not a bare rise: the maintenance tick can land in this wait and
    // dispatch on its own. Each typed block's edit queues a link and a tag-ref
    // reindex of its own; the consumer coalesces the rest by timing.
    const rose = (m: Record<string, number>, card: string) =>
      (m[card] ?? 0) - (before[card] ?? 0) >= 2 * words.length
    await openAppHealth()
    await waitForMetrics(
      (m) => idle(m) && rose(m, 'Ops processed') && rose(m, 'Background dispatched'),
      `the op counts never rose enough from ${JSON.stringify(before)} with both queues back at 0`,
    )
  })

  it('rebuilds every derived table of a vault with a task, a tag, a link and properties, and finds no difference', async () => {
    const marker = runScopedMarker('wdio-integrity')
    await navigateTo('Journal')
    await openAppHealth()
    const empty = await runIntegrityCheck()

    // An existing target: a page the import creates for a link diverges in the check.
    await importMarkdownPage(`${marker}-target`, `- ${marker}-target-body\n`)
    await importMarkdownPage(
      marker,
      [
        `- TODO ${marker}-task #${marker}-tag [[${marker}-target]]`,
        '  repeat:: weekly',
        `  assignee:: ${marker}-carol`,
        `- ${marker}-parent`,
        `  - ${marker}-child`,
        '',
      ].join('\n'),
    )
    await navigateTo('Journal')
    await openAppHealth()
    const seeded = await runIntegrityCheck()

    // The linked page and its block, then the page, its blocks and the new
    // tag: the check folded exactly what the imports wrote.
    expect(seeded.blocks - empty.blocks).toBe(7)
  })

  it('puts the integrity section in the bug report, copies the body verbatim, and saves the ZIP with the logs', async () => {
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
  })
})
