// ---------------------------------------------------------------------------
// Real-backend bug report (#5741 item 12, #5740 item 11): its integrity section,
// the body copied verbatim, and the ZIP with the logs, which is bytes on disk.
// The App health counters and the integrity check's rebuild of a seeded vault
// are `e2e/app-health.spec.ts`, on the bridge.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  clipboardText,
  navigateTo,
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

describe('Agaric real-backend bug report (#5741, #5740) @boot @settings', () => {
  it('puts the integrity section in the bug report, copies the body verbatim, and saves the ZIP with the logs', async () => {
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
})
