/**
 * useUpdateCheck — desktop auto-update wire-up (FE half).
 *
 * Fires at most once per 24 h on app boot to ask the Tauri updater plugin
 * whether a new release is available. When an update is found, a sonner
 * toast is raised with two actions:
 *
 *   - **Install & restart** — flushes pending drafts (mid-edit safety),
 *     downloads + installs the update, then relaunches the app via
 *     `@tauri-apps/plugin-process#relaunch`.
 *   - **Later** — dismisses the toast (sonner handles this via the
 *     `cancel` field).
 *
 * Desktop-only — mobile platforms route through the Play Store / App Store
 * and have no Tauri updater plugin; the boot check short-circuits on the
 * shared `isMobilePlatform()` capability check from `../lib/platform`.
 *
 * Flatpak builds are also skipped: Flathub requires apps NOT to
 * self-update (updates flow through Flathub's own repo/CI instead), so
 * the boot effect asks the backend's `is_flatpak` command (the renderer
 * can't stat `/.flatpak-info` itself) before firing and bails out when
 * it reports `true`. This mirrors — and is belt-and-suspenders with —
 * the Rust-side guard in `src-tauri/src/lib.rs` that already skips
 * *registering* `tauri_plugin_updater` under Flatpak in the first place.
 *
 * The 24-hour debounce uses `localStorage` (`agaric:last-update-check`)
 * so it survives page reloads. The exported `checkForUpdatesNow()`
 * function bypasses the debounce and always surfaces a confirmation
 * toast — it is what the Settings → Help `t('help.updateCheckNowButton')` button calls.
 *
 * Boot-check errors are logged silently — a connection blip at startup
 * shouldn't pester the user. The manual path surfaces failures.
 */

// Hoist `@tauri-apps/plugin-process` (used in performInstall) to the top
// so the dynamic chunk is fetched at module load, not at click time.
// If the network drops between `downloadAndInstall()` (which succeeded)
// and a lazy import of `relaunch`, the install completes but the
// relaunch silently fails — pre-fetching the relaunch chunk closes that
// gap. The plugin-updater import stays lazy because (a) it's only used
// in two flows that may never fire (mobile / debounced) and (b) it's
// the larger of the two chunks.
import { relaunch } from '@tauri-apps/plugin-process'
import { useEffect } from 'react'

import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { isMobilePlatform } from '@/lib/platform'
import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'
import { flushAllDrafts } from '@/lib/tauri'

/** localStorage key holding the ISO timestamp of the last successful update check. */
export const LAST_UPDATE_CHECK_STORAGE_KEY = PREFERENCES.lastUpdateCheck.key

/** 24 hours in milliseconds — the boot-check debounce window. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** Stable sonner toast id for the update-available toast; dedupes across renders. */
const UPDATE_AVAILABLE_TOAST_ID = 'update-available'

/** Read the last-check ISO timestamp from localStorage, defensively. */
function readLastCheckIso(): string | null {
  return typeof localStorage === 'undefined' ? null : readPreference(PREFERENCES.lastUpdateCheck)
}

/** Persist the last-check ISO timestamp, defensively. */
function writeLastCheckIso(iso: string): void {
  if (typeof localStorage === 'undefined') return
  writePreference(PREFERENCES.lastUpdateCheck, iso)
}

/**
 * True iff this process is running inside a Flatpak sandbox, per the
 * backend's `is_flatpak` command (`src-tauri/src/commands/mod.rs`). The
 * renderer can't stat `/.flatpak-info` itself, so this is a thin IPC
 * wrapper around the Rust-side check (which itself backs the
 * `tauri_plugin_updater` registration guard in `src-tauri/src/lib.rs` —
 * see that guard's comment for the Flathub no-self-update rationale).
 *
 * Defaults to `false` (i.e. "not Flatpak, proceed with the boot check")
 * on any IPC failure — a plain browser/dev session or a transient IPC
 * error shouldn't silently disable auto-update for the overwhelming
 * majority (AppImage/.deb) of desktop users; only an actual Flatpak
 * sandbox should suppress it.
 */
async function isRunningUnderFlatpak(): Promise<boolean> {
  try {
    const result = await commands.isFlatpak()
    return result.status === 'ok' && result.data
  } catch (err) {
    logger.warn('updater', 'is_flatpak check failed; assuming non-Flatpak', undefined, err)
    return false
  }
}

/** True iff the last successful check was less than 24 h ago. */
function isWithinDebounceWindow(nowMs: number): boolean {
  const iso = readLastCheckIso()
  if (iso == null) return false
  const last = Date.parse(iso)
  if (Number.isNaN(last)) return false
  const delta = nowMs - last
  // Guard against future timestamps (clock skew, NTP roll-back, another
  // window writing a future ISO by accident). A negative delta means
  // the stored timestamp is ahead of "now" — treat as stale and re-check
  // rather than suppress forever.
  if (delta < 0) return false
  return delta < ONE_DAY_MS
}

/** Trigger the install-and-relaunch flow. Flushes drafts first. */
async function performInstall(update: { downloadAndInstall: () => Promise<void> }): Promise<void> {
  try {
    // Mid-edit safety — flush any pending drafts before tearing the
    // process down. Failures here ABORT the install: losing a draft
    // to an interrupted install is the worst case, so we'd rather the
    // user retry than ship a partial save. The rejection bubbles to
    // the outer catch and routes through the same toast-cleanup path
    // as a download failure.
    await flushAllDrafts()
    await update.downloadAndInstall()
    await relaunch()
  } catch (err) {
    logger.error('updater', 'Update install failed', undefined, err)
    // Dismiss the persistent "update available" toast so the user
    // doesn't have a stale Install button still clickable, AND clear
    // the LS timestamp so the next boot re-tries the check sooner
    // (avoids a 24 h silent wait after a failed install attempt).
    notify.dismiss(UPDATE_AVAILABLE_TOAST_ID)
    if (typeof localStorage !== 'undefined') {
      removePreference(PREFERENCES.lastUpdateCheck)
    }
    const message = err instanceof Error ? err.message : i18n.t('help.updateInstallFailedToast')
    notify.error(`${i18n.t('help.updateInstallFailedToast')}: ${message}`)
  }
}

/**
 * Show the "update available" toast with Install & restart + Later
 * actions. Uses a stable id so re-renders / repeat checks don't stack
 * multiple toasts.
 */
function showUpdateAvailableToast(update: {
  version: string
  downloadAndInstall: () => Promise<void>
}): void {
  notify.message(i18n.t('help.updateAvailableToast', { version: update.version }), {
    id: UPDATE_AVAILABLE_TOAST_ID,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: i18n.t('help.updateInstallActionLabel'),
      onClick: () => {
        void performInstall(update)
      },
    },
    cancel: {
      label: i18n.t('help.updateLaterActionLabel'),
      onClick: () => {
        // Sonner auto-dismisses on cancel click; nothing else to do.
      },
    },
  })
}

/** Shape of the object returned by `@tauri-apps/plugin-updater#check`. */
type UpdaterCheckResult = {
  version: string
  downloadAndInstall: () => Promise<void>
} | null

// In-flight check guard. Both the boot effect and the manual button
// route through `runUpdateCheck`; without this, a fast user click while
// the boot check is still pending issues two parallel `check()` round
// trips (doubled network cost + a race in `writeLastCheckIso`). The
// guard returns the existing promise so the second caller sees the
// same outcome as the first.
let inFlightCheck: Promise<void> | null = null

/**
 * Run the updater check + handle the result. Shared between the boot
 * effect and the manual `t('help.updateCheckNowButton')` flow; `silentOnNoUpdate` controls
 * whether a confirmation toast fires when there's nothing new.
 *
 * Not `async` — the body either short-circuits (returns `undefined`
 * for mobile) or returns an existing/newly-created promise directly.
 * Marking it `async` would add an unnecessary microtask hop AND trip
 * oxlint's `typescript/require-await` rule.
 */
function runUpdateCheck(silentOnNoUpdate: boolean): Promise<void> | undefined {
  if (isMobilePlatform()) return undefined
  if (inFlightCheck != null) return inFlightCheck
  inFlightCheck = runUpdateCheckInner(silentOnNoUpdate).finally(() => {
    inFlightCheck = null
  })
  return inFlightCheck
}

async function runUpdateCheckInner(silentOnNoUpdate: boolean): Promise<void> {
  let update: UpdaterCheckResult
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    update = (await check()) as UpdaterCheckResult
  } catch (err) {
    if (silentOnNoUpdate) {
      logger.warn('updater', 'Update check failed (silent boot path)', undefined, err)
    } else {
      logger.error('updater', 'Update check failed (manual path)', undefined, err)
      const message = err instanceof Error ? err.message : i18n.t('help.updateInstallFailedToast')
      notify.error(message)
    }
    return
  }
  // Persist the timestamp on every successful round-trip, regardless of
  // whether an update was found — the debounce protects against repeat
  // network hits, not against repeat "no update" confirmations.
  writeLastCheckIso(new Date().toISOString())
  if (update != null) {
    showUpdateAvailableToast(update)
  } else if (!silentOnNoUpdate) {
    notify.success(i18n.t('help.updateNoneFoundToast'))
  }
}

/**
 * Manual `t('help.updateCheckNowButton')` entry point — bypasses the 24 h debounce and
 * always shows a toast (either update-available or the no-update
 * confirmation). Used by the Settings → Help button.
 */
export async function checkForUpdatesNow(): Promise<void> {
  await runUpdateCheck(false)
}

/**
 * Empty-deps boot effect. Skips entirely (registers nothing) when the UA
 * sniff says we're on mobile (`isMobilePlatform()`) or the backend reports
 * we're running inside a Flatpak sandbox (Flathub's no-self-update
 * requirement — see `isRunningUnderFlatpak`).
 *
 * Otherwise, in addition to firing an initial `runUpdateCheck` in
 * silent mode, this registers a 24 h `setInterval` re-check plus
 * `visibilitychange` (tab/window regains focus) and `online` (network
 * restored) listeners that re-check immediately — so a long-running or
 * autostarted instance (tray, `tauri-plugin-autostart`) doesn't stay
 * stuck at a single boot-time check for days/weeks.
 *
 * Every one of these re-check triggers routes through the same
 * `isWithinDebounceWindow` guard the boot check uses (localStorage
 * records a successful check less than 24 h ago), plus the
 * `runUpdateCheck` in-flight guard — that's what makes it safe to call
 * `attemptCheck` on every focus/reconnect without a second debounce
 * here.
 */
export function useUpdateCheck(): void {
  useEffect(() => {
    if (isMobilePlatform()) return

    const attemptCheck = (): void => {
      if (isWithinDebounceWindow(Date.now())) return
      void runUpdateCheck(true)
    }

    let intervalId: ReturnType<typeof setInterval> | undefined
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        attemptCheck()
      }
    }
    const handleOnline = (): void => {
      attemptCheck()
    }

    // The Flatpak check is an IPC round-trip, so wiring up (initial check +
    // interval + listeners) happens once the backend answers; `cancelled`
    // guards against an unmount during that await.
    let cancelled = false
    void (async () => {
      if (await isRunningUnderFlatpak()) return
      if (cancelled) return
      attemptCheck()
      intervalId = setInterval(attemptCheck, ONE_DAY_MS)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      window.addEventListener('online', handleOnline)
    })()

    return () => {
      cancelled = true
      if (intervalId !== undefined) clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('online', handleOnline)
    }
  }, [])
}
