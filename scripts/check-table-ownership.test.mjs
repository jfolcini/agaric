import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { CRATE_ROOTS } from './lib/rust-scan.mjs'

// `--self-test` covers the scanner and the baseline parser. These run the
// guard's `main()` end to end over a real tree: the comparison against the
// baseline, the owner exemption, the baseline reader and writer, and the
// missing-crate-root refusals.

const GUARD_FILES = ['check-table-ownership.mjs', 'lib/rust-scan.mjs', 'lib/guard-file-source.mjs']
const BASELINE = 'src-tauri/table-ownership-baseline.txt'
// Nested, so a walk that does not recurse reads nothing.
const SYNC_RS = 'src-tauri/agaric-sync/src/nested/a.rs'
const STORE_RS = 'src-tauri/agaric-store/src/nested/a.rs'
const CROSS_CRATE = 'fn f() { sqlx::query!("DELETE FROM pages_cache WHERE id = ?"); }\n'

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

// The guard judges the tree that contains it, so each fixture gets its own
// copy of the guard and every crate root it checks for.
function withGuardTree(files, fn, { roots = CRATE_ROOTS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'table-ownership-'))
  try {
    for (const file of GUARD_FILES) {
      mkdirSync(dirname(join(dir, 'scripts', file)), { recursive: true })
      copyFileSync(join(import.meta.dirname, file), join(dir, 'scripts', file))
    }
    for (const root of roots) mkdirSync(join(dir, root), { recursive: true })
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
    const run = (...args) =>
      spawnSync(process.execPath, ['scripts/check-table-ownership.mjs', ...args], {
        cwd: dir,
        encoding: 'utf8',
      })
    fn({ run, baseline: () => readFileSync(join(dir, BASELINE), 'utf8') })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('a cross-crate write past its baseline exits 1 naming the pair and the file', () => {
  withGuardTree({ [SYNC_RS]: CROSS_CRATE }, ({ run }) => {
    const r = run()
    assert.equal(r.status, 1, r.stderr)
    assert.match(
      r.stderr,
      /sync crate has 1 raw write\(s\) to 'pages_cache' \(baseline 0; owner = store crate\)\n {6}files: src-tauri\/agaric-sync\/src\/nested\/a\.rs\n/,
    )
  })
})

void test('a cross-crate write within its baseline entry exits 0', () => {
  withGuardTree(
    { [SYNC_RS]: CROSS_CRATE, [BASELINE]: '# header\n1 sync pages_cache  # carve-out\n' },
    ({ run }) => {
      const r = run()
      assert.equal(r.status, 0, r.stderr)
    },
  )
})

void test("the owner crate's own write needs no baseline entry", () => {
  withGuardTree({ [STORE_RS]: CROSS_CRATE }, ({ run }) => {
    const r = run()
    assert.equal(r.status, 0, r.stderr)
  })
})

void test('--update-baseline recounts, keeps annotations, drops a vanished pair, adds a new one bare', () => {
  withGuardTree(
    {
      [SYNC_RS]: CROSS_CRATE + CROSS_CRATE,
      'src-tauri/src/a.rs': 'fn f() { sqlx::query!("UPDATE blocks SET x = 1"); }\n',
      [BASELINE]:
        '# header\n\n# app note\n5 app blocks  # carve-out\n# gone note\n3 sync tags_cache\n# footer\n',
    },
    ({ run, baseline }) => {
      const r = run('--update-baseline')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, `Wrote ${BASELINE}\n`)
      assert.equal(
        baseline(),
        '# header\n\n# app note\n1 app blocks  # carve-out\n2 sync pages_cache\n# footer\n',
      )
    },
  )
})

void test('a malformed baseline line exits 1 naming it', () => {
  withGuardTree({ [BASELINE]: '10 store # blocks\n' }, ({ run }) => {
    const r = run()
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /malformed baseline line .*: "10 store # blocks"\n/)
  })
})

void test('a missing crate root exits 1 naming it; --synthetic-tree alone suppresses it', () => {
  const missing = 'src-tauri/agaric-sync/src/'
  const roots = CRATE_ROOTS.filter((root) => root !== missing)
  withGuardTree(
    {},
    ({ run }) => {
      const r = run()
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /directory does not exist:\n\n {2}src-tauri\/agaric-sync\/src\n/)
      assert.equal(run('--synthetic-tree').status, 0)
    },
    { roots },
  )
})

void test('--update-baseline refuses a missing crate root, and with --synthetic-tree, without writing', () => {
  const missing = 'src-tauri/agaric-sync/src/'
  const roots = CRATE_ROOTS.filter((root) => root !== missing)
  const before = '# header\n3 sync tags_cache\n'
  withGuardTree(
    { [BASELINE]: before },
    ({ run, baseline }) => {
      const refused = run('--update-baseline')
      assert.equal(refused.status, 1, refused.stderr)
      assert.match(refused.stderr, /^Refusing to re-anchor/)
      const both = run('--synthetic-tree', '--update-baseline')
      assert.equal(both.status, 2, both.stderr)
      assert.equal(baseline(), before)
    },
    { roots },
  )
})
