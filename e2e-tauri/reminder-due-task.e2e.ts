// ---------------------------------------------------------------------------
// Real-backend OS reminder for a task due today, fired once (#5741).
//
// The reminder is the maintenance job `reminders_tick` (`reminders.rs`): on a
// run at or after the chosen local time it notifies every open task due today
// that has no row in its fired ledger, writing the row first. The mock has no
// job, no ledger and no OS, so only this lane shows a reminder that never
// fires or fires on every run.
//
// The sink is the session bus: `dbus-monitor` sees the app's
// `org.freedesktop.Notifications.Notify` call (notify-rust, `notifier.rs`)
// whether or not a notification daemon answers it, and the summary is the
// task's first line. The second task proves a later run happened, so the
// first task's single capture is "once", not "not yet twice".
//
// Slow by design: the job runs on every 60 s tick of the maintenance daemon,
// the first about a minute after boot, so a reminder arrives up to a minute
// after its time. Each wait is its own case to stay inside the per-test
// timeout.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn } from 'node:child_process'

import {
  ACTION_TIMEOUT,
  isoDay,
  NAV_TIMEOUT,
  navigateTo,
  openNewPage,
  openSettingsTab,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TASK_A = runScopedMarker('wdio-remind-first')
const TASK_B = runScopedMarker('wdio-remind-second')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const DATE_PICKER = '[data-testid="date-picker-popup"]'
const SWITCH = '[data-testid="notifications-enabled-switch"]'
const TIME_INPUT = '[data-testid="notifications-reminder-time"]'
const NOTIFY_MATCH = "type='method_call',interface='org.freedesktop.Notifications',member='Notify'"
// Up to a minute until the reminder time, a tick until the run after it, and slack.
const REMINDER_TIMEOUT = 240_000

let monitor: ChildProcess | undefined
let monitorLog = ''
let monitorExit = ''
let today = ''

/** Start `dbus-monitor` on the session bus and resolve once it is monitoring. */
function startNotifyMonitor(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('dbus-monitor', ['--session', NOTIFY_MATCH], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    monitor = child
    let stderr = ''
    const timer = setTimeout(
      () => reject(new Error(`dbus-monitor never started monitoring: ${stderr}`)),
      ACTION_TIMEOUT,
    )
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      monitorLog += chunk.toString()
      // The bus names the monitor's connection as it becomes a monitor.
      if (monitorLog.includes('member=NameAcquired')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`dbus-monitor failed to start; the lane needs dbus-bin: ${err.message}`))
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      monitorExit = `dbus-monitor exited (${code ?? signal}): ${stderr}`
      reject(new Error(monitorExit))
    })
  })
}

/** The captured `Notify` calls' summary and body (their third and fourth top-level strings). */
function notifications(): { summary: string; body: string }[] {
  return monitorLog
    .split(/\n(?=\S)/)
    .filter((message) => message.includes('member=Notify'))
    .map((message) => {
      const strings = [...message.matchAll(/^ {3}string "(.*)"$/gm)].map((m) => m[1] ?? '')
      return { summary: strings[2] ?? '', body: strings[3] ?? '' }
    })
}

function notifiedCount(task: string): number {
  return notifications().filter((n) => n.summary === task).length
}

/** Wait until a reminder for `task` has been captured. */
async function waitForReminder(task: string): Promise<void> {
  await browser.waitUntil(() => Promise.resolve(notifiedCount(task) > 0), {
    timeout: REMINDER_TIMEOUT,
    interval: 2_000,
    timeoutMsg:
      `no Notify for ${task} reached the session bus; captured ` +
      `${JSON.stringify(notifications())} ${monitorExit}`,
  })
}

/** A page holding one block, `task`, due today through `/due`. */
async function seedTaskDueToday(task: string): Promise<void> {
  await openNewPage(runScopedMarker(`${task}-page`))
  await typeMarkerVerified(task)
  const id = await browser.execute(
    (sel: string) =>
      document.querySelector(sel)?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? '',
    EDITOR,
  )
  if (id === '') throw new Error(`the block holding ${task} has no data-block-id`)
  await browser.keys(['End'])
  await browser.keys([' '])
  for (const ch of '/due') await browser.keys([ch])
  const dueItem = $('#suggestion-due')
  await dueItem.waitForClickable({ timeout: ACTION_TIMEOUT })
  await dueItem.click()
  await typeInputVerified(`${DATE_PICKER} input[aria-label="Type a date"]`, 'today')
  await browser.keys(['Enter'])
  await $(DATE_PICKER).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  // The chip renders once `set_due_date` has answered.
  await $(`[data-block-id="${id}"] .due-date-chip`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await navigateTo('Journal')
}

/** The Tasks & reminders tab's switch and time, once its load has answered with `time`. */
async function reminderSettingsShown(time: string): Promise<{ enabled: string | null }> {
  await openSettingsTab('notifications')
  await browser.waitUntil(async () => (await $(TIME_INPUT).getValue()) === time, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the re-opened tab does not show the reminder time ${time}`,
  })
  return { enabled: await $(SWITCH).getAttribute('aria-checked') }
}

describe('Agaric real-backend due-task reminder (#5741)', () => {
  before(async () => {
    await startNotifyMonitor()
    await waitForAppReady()
  })

  after(() => {
    monitor?.kill()
  })

  it('reminders on at the next minute, with a task due today', async () => {
    const now = new Date()
    if (24 * 60 - (now.getHours() * 60 + now.getMinutes()) < 15) {
      throw new Error('the run starts within 15 minutes of local midnight: "due today" would roll')
    }
    today = isoDay(now)
    const next = new Date(now.getTime() + 60_000)
    const time = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`

    await seedTaskDueToday(TASK_A)

    await openSettingsTab('notifications')
    const toggle = $(SWITCH)
    await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.click()
    await $(TIME_INPUT).waitForEnabled({ timeout: ACTION_TIMEOUT })
    // WebKitGTK's time field ignores WebDriver keys, so set the value the way
    // React reads it: the native setter, then an `input` event.
    await browser.execute(
      (sel: string, value: string) => {
        const input = document.querySelector<HTMLInputElement>(sel)
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value,
        )
        input?.dispatchEvent(new Event('input', { bubbles: true }))
      },
      TIME_INPUT,
      time,
    )

    await navigateTo('Journal')
    expect(await reminderSettingsShown(time)).toEqual({ enabled: 'true' })
  })

  it('notifies the due task once it is time', async () => {
    await waitForReminder(TASK_A)
    expect(notifications().filter((n) => n.summary === TASK_A)).toEqual([
      { summary: TASK_A, body: 'Due today' },
    ])
  })

  it('a later run notifies a new due task and not the first one again', async () => {
    await seedTaskDueToday(TASK_B)
    await waitForReminder(TASK_B)
    expect(notifiedCount(TASK_B)).toBe(1)
    expect(notifiedCount(TASK_A)).toBe(1)
    expect(isoDay(new Date())).toBe(today)
  })
})
