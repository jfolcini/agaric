import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The `xdg-open` the AppImage ships (#6871), run from where the AppImage puts
// it, in the environment the 0.24.0 AppImage's AppRun hands the app.

const WRAPPER = join(import.meta.dirname, '..', 'src-tauri', 'scripts', 'appimage-xdg-open.sh')

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails — the runner owns the failure report and the exit code.

/** A stand-in host launcher that records its arguments and environment. */
function standIn(dir, name, record) {
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\n{ printf 'argv=%s|%s\\n' "$#" "$*"; env; } > '${record}'\n`,
    {
      mode: 0o755,
    },
  )
}

function run(hostLaunchers) {
  const root = mkdtempSync(join(tmpdir(), 'appimage-xdg-open-'))
  const appdir = join(root, 'mount_AgaricX')
  const bundleBin = join(appdir, 'usr', 'bin')
  const hostBin = join(root, 'host-bin')
  // Only the tools the wrapper and stand-ins call: a system dir on PATH would
  // bring the runner's own xdg-open, which runs before any stand-in gio.
  const tools = join(root, 'tools')
  mkdirSync(bundleBin, { recursive: true })
  mkdirSync(hostBin)
  mkdirSync(tools)
  for (const tool of ['env', 'sed']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
    symlinkSync(found.stdout.trim(), join(tools, tool))
  }
  copyFileSync(WRAPPER, join(bundleBin, 'xdg-open'))
  const record = join(root, 'record')
  for (const name of hostLaunchers) standIn(hostBin, name, record)

  const result = spawnSync(join(bundleBin, 'xdg-open'), ['https://example.com/a b'], {
    env: {
      APPDIR: appdir,
      LD_LIBRARY_PATH: `${appdir}/usr/lib/:${appdir}/usr/lib/x86_64-linux-gnu/:`,
      PATH: `${appdir}/usr/bin/:${appdir}/usr/sbin/:${hostBin}:${tools}`,
      XDG_DATA_DIRS: `${appdir}/usr/share/:${appdir}Y/share:${appdir}/usr/share:/usr/share`,
      GIO_MODULE_DIR: `${appdir}//usr/lib/gio/modules`,
      SIBLING: `${appdir}Y/usr/lib`,
      DISPLAY: ':0',
      GTK_THEME: 'Adwaita:dark',
    },
    encoding: 'utf8',
    // A wrapper that leaves its own dir on PATH runs itself again, forever.
    timeout: 10_000,
  })
  try {
    assert.equal(result.status, 0, result.stderr)
    const lines = readFileSync(record, 'utf8').trim().split('\n')
    const argv = lines[0]
    const env = Object.fromEntries(
      lines
        .slice(1)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    return { appdir, hostBin, tools, argv, env }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('the host xdg-open gets the target and no entry under APPDIR', () => {
  const { appdir, hostBin, tools, argv, env } = run(['xdg-open'])

  assert.equal(argv, 'argv=1|https://example.com/a b', 'the target arrives as one argument')
  assert.equal(env['LD_LIBRARY_PATH'], undefined, 'a variable left empty is removed')
  assert.equal(env['GIO_MODULE_DIR'], undefined)
  assert.equal(env['APPDIR'], undefined)
  assert.equal(env['PATH'], `${hostBin}:${tools}`, 'host entries keep their order')
  assert.equal(
    env['XDG_DATA_DIRS'],
    `${appdir}Y/share:/usr/share`,
    'beside bundle entries, a sibling of the mount is kept',
  )
  assert.equal(env['SIBLING'], `${appdir}Y/usr/lib`, 'a sibling of the mount is not the bundle')
  assert.equal(env['DISPLAY'], ':0')
  assert.equal(env['GTK_THEME'], 'Adwaita:dark')
})

void test('without a host xdg-open, gio opens the target, as the opener plugin falls back', () => {
  const { argv, env } = run(['gio'])

  assert.equal(argv, 'argv=2|open https://example.com/a b')
  assert.equal(env['LD_LIBRARY_PATH'], undefined)
})
