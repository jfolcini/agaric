// ---------------------------------------------------------------------------
// Real-backend launcher environment in an AppImage (#6871).
//
// An AppImage's launchers point `LD_LIBRARY_PATH` and more into the bundle, and
// a program the app starts inherits them: on a host with a newer GLib, `gio`
// and `flatpak` load the bundle's libraries and exit before the browser opens.
// The AppImage ships `src-tauri/scripts/appimage-xdg-open.sh` as its first
// `xdg-open` on PATH, which strips the bundle before running the host's.
// wdio.conf.ts starts this spec's app the way an AppImage would, with that
// wrapper and a stand-in host `xdg-open` behind it that records what it
// receives (`SPECS_IN_AN_APPIMAGE_ENV`). A link or the data folder the opener
// plugin opens must reach the host's launcher with the app's environment minus
// the bundle.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import {
  NAV_TIMEOUT,
  appEnvironment,
  appVaultDir,
  clickUncovered,
  openDataTab,
  openSettingsTab,
  waitForAppReady,
} from './helpers'

const TOKEN_REFERENCE_URL =
  'https://github.com/jfolcini/agaric/blob/main/docs/features/appearance.md#custom-css'

interface Launch {
  target: string
  ldLibraryPath: string
  appDir: string
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

describe('Agaric real-backend launcher environment in an AppImage (#6871) @settings', () => {
  it('opens a link with the host environment, not the bundle', async () => {
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

  it('opens the data folder with the host environment, not the bundle', async () => {
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
