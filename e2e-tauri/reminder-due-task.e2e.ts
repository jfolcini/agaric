// ---------------------------------------------------------------------------
// Real-backend OS reminder for a due task (#5741).
//
// The reminder is the maintenance job `reminders_tick` (`reminders.rs`): on a
// run at or after the chosen local time it notifies every open task due on the
// run's local date that has no row in its fired ledger, writing the row first.
// The mock has no job, no ledger and no OS, so only this lane shows a reminder
// that never fires.
//
// The sink is the session bus: `dbus-monitor` sees the app's
// `org.freedesktop.Notifications.Notify` call (notify-rust, `notifier.rs`)
// whether or not a notification daemon answers it, and the summary is the
// task's first line.
//
// No wall-clock window: the reminder minute is the current one, so the next
// run is already past it, and the task is due on that minute's date. Near
// midnight the minute is the coming midnight instead, so the run that fires
// sees the same date the task is due on.
//
// Slow by design: the job runs on the maintenance daemon's 60 s tick, the
// first a tick after boot, and that real run is what the spec proves. It
// waits for one run only; that a later run does not notify again is the
// ledger's job, pinned by `fires_exactly_once_across_two_ticks`.
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
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const DATE_PICKER = '[data-testid="date-picker-popup"]'
const SWITCH = '[data-testid="notifications-enabled-switch"]'
const TIME_INPUT = '[data-testid="notifications-reminder-time"]'
const NOTIFY_MATCH = "type='method_call',interface='org.freedesktop.Notifications',member='Notify'"
// Seeding plus one tick fits in this, so a minute this close to midnight moves to midnight.
const ROLLOVER_MARGIN_MS = 120_000
// The margin, a tick, and slack.
const REMINDER_TIMEOUT = 240_000

let monitor: ChildProcess | undefined
let monitorLog = ''
let monitorExit = ''

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

/** The reminder minute: now, or the coming midnight when the first run could fall past it. */
function reminderMinute(now: Date): Date {
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  return midnight.getTime() - now.getTime() < ROLLOVER_MARGIN_MS ? midnight : now
}

/** A page holding one block, `task`, due on `day` through `/due`. */
async function seedTaskDue(task: string, day: string): Promise<void> {
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
  await typeInputVerified(`${DATE_PICKER} input[aria-label="Type a date"]`, day)
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

describe('Agaric real-backend due-task reminder (#5741) @journal', () => {
  before(async () => {
    await startNotifyMonitor()
    await waitForAppReady()
  })

  after(() => {
    monitor?.kill()
  })

  it('reminders on at the current minute, with a task due that day', async () => {
    const at = reminderMinute(new Date())
    const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

    await seedTaskDue(TASK_A, isoDay(at))

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
})
