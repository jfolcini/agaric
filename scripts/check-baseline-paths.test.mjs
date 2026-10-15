import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { DATA_SOURCES, EMBEDDED_SOURCES, NO_PATHS } from './check-baseline-paths.mjs'
import {
  initScratchRepo,
  scrubbedGitEnv,
  withScrubbedProcessEnv,
} from './lib/git-scratch-guard.mjs'

// Runs the guard end to end in a scratch repo holding every declared source,
// each naming one path that resolves against its own base directory.

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

const GUARD_FILES = ['check-baseline-paths.mjs', 'lib/guard-file-source.mjs']
const ENTRY = 'entry/target.txt'
const SETS = Object.keys(DATA_SOURCES).length + EMBEDDED_SOURCES.length
const CLEAN = `check-baseline-paths: ${SETS} path(s) resolve, across ${SETS} baseline/allowlist set(s).\n`

const DYNAMIC_SQL = 'src-tauri/dynamic-sql-baseline.txt'
const UNSAFE = 'src-tauri/unsafe-allowlist.txt'
const CONTENT_REGEX = 'scripts/content-regex-baseline.json'
const RAW_INVOKE = 'scripts/check-raw-invoke.mjs'

function dataBody(kind) {
  switch (kind) {
    case 'json:fn::': {
      return JSON.stringify([{ fn: `${ENTRY}::sym` }])
    }
    case 'json:file': {
      return JSON.stringify([{ file: ENTRY }])
    }
    case 'text:count-path': {
      return `# header\n1 ${ENTRY}\n`
    }
    case 'text:lines': {
      return `# header\n${ENTRY}\n`
    }
    default: {
      throw new Error(`no fixture for extractor ${kind}`)
    }
  }
}

// The guard judges the tree that contains it, so each fixture gets its own
// copy. `edit` runs before `git add`, `afterAdd` after it, so a test can make
// the index and the disk disagree. `track: false` leaves the repo with an empty index.
function withGuardRepo(
  { edit = () => {}, afterAdd = () => {}, git: useGit = true, track = true },
  fn,
) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-paths-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const dir = join(root, 'repo')
      const env = scrubbedGitEnv(root)
      const write = (rel, body) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(join(dir, rel), body)
      }
      const remove = (rel) => rmSync(join(dir, rel), { recursive: true })
      for (const rel of Object.keys(NO_PATHS)) write(rel, 'placeholder\n')
      for (const [rel, [kind, base]] of Object.entries(DATA_SOURCES)) {
        write(rel, dataBody(kind))
        write(join(base, ENTRY), 'target\n')
      }
      const embedded = {}
      for (const [rel, name, base] of EMBEDDED_SOURCES) {
        embedded[rel] = `${embedded[rel] ?? ''}const ${name} = ['${ENTRY}']\n`
        write(join(base, ENTRY), 'target\n')
      }
      for (const [rel, body] of Object.entries(embedded)) write(rel, body)
      for (const file of GUARD_FILES) {
        mkdirSync(dirname(join(dir, 'scripts', file)), { recursive: true })
        copyFileSync(join(import.meta.dirname, file), join(dir, 'scripts', file))
      }
      edit({ write, remove })
      if (useGit) {
        const git = initScratchRepo(dir, env)
        if (track) git('add', '-A')
      }
      afterAdd({ write, remove })
      const run = (...args) =>
        spawnSync(process.execPath, ['scripts/check-baseline-paths.mjs', ...args], {
          cwd: dir,
          env,
          encoding: 'utf8',
        })
      fn(run)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('a tree whose every entry resolves exits 0 and prints its denominator', () => {
  withGuardRepo({}, (run) => {
    const r = run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, CLEAN)
  })
})

void test('a dangling data-file entry exits 1 naming it (#4501)', () => {
  withGuardRepo(
    { edit: ({ write }) => write(DYNAMIC_SQL, '1 src-tauri/src/moved.rs\n') },
    (run) => {
      const r = run()
      assert.equal(r.status, 1, r.stderr)
      assert.match(
        r.stderr,
        /^Baseline\/allowlist path guard \(#4501\) — an entry names a path that does not exist:\n\n {2}src-tauri\/dynamic-sql-baseline\.txt: `src-tauri\/src\/moved\.rs` names a path that does not exist\n/,
      )
    },
  )
})

void test("an entry is resolved against its set's base directory, not the repo root", () => {
  // The root-level copy of ENTRY still exists; only the src-tauri/ one goes.
  withGuardRepo({ edit: ({ remove }) => remove(join('src-tauri', ENTRY)) }, (run) => {
    const r = run()
    assert.equal(r.status, 1, r.stderr)
    assert.match(
      r.stderr,
      /\n {2}src-tauri\/unsafe-allowlist\.txt: `entry\/target\.txt` names a path/,
    )
  })
})

void test('a dangling entry in an embedded set exits 1 naming the set', () => {
  withGuardRepo(
    {
      edit: ({ write }) =>
        write(
          RAW_INVOKE,
          "const EXEMPT_FILES = ['src/gone.ts']\nconst EXEMPT_DIR_PREFIXES = ['entry/']\n",
        ),
    },
    (run) => {
      const r = run()
      assert.equal(r.status, 1, r.stderr)
      assert.match(
        r.stderr,
        /\n {2}scripts\/check-raw-invoke\.mjs:EXEMPT_FILES: `src\/gone\.ts` names a path that does not exist\n/,
      )
    },
  )
})

void test('glob entries are skipped and counted, not resolved', () => {
  withGuardRepo({ edit: ({ write }) => write(UNSAFE, `${ENTRY}\ngone/**/*.rs\n`) }, (run) => {
    const r = run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, CLEAN.replace('set(s).', 'set(s); 1 glob entr(ies) skipped.'))
  })
})

void test('a TRACKED undeclared baseline exits 1 naming it; an untracked or session-log one does not', () => {
  withGuardRepo(
    {
      edit: ({ write }) => {
        write('src/Lib-Allow-List.ts', 'x\n')
        write('docs/session-log/baseline-notes.md', 'x\n')
      },
      afterAdd: ({ write }) => write('scripts/untracked-baseline.json', '[]\n'),
    },
    (run) => {
      const r = run()
      assert.equal(r.status, 1, r.stderr)
      assert.match(
        r.stderr,
        /outside this check's\ndeclared population:\n\n {2}src\/Lib-Allow-List\.ts: a tracked file/,
      )
      assert.doesNotMatch(r.stderr, /untracked-baseline|session-log/)
    },
  )
})

void test('a declared source that is gone from disk fails closed, even while still tracked', () => {
  withGuardRepo(
    {
      afterAdd: ({ remove }) => {
        remove(CONTENT_REGEX)
        remove('scripts/coverage-baseline.json')
        remove('scripts/check-ipc-error-path.mjs')
      },
    },
    (run) => {
      const r = run()
      assert.equal(r.status, 1, r.stderr)
      assert.match(
        r.stderr,
        /\n {2}scripts\/content-regex-baseline\.json: declared in DATA_SOURCES but not in this checkout\n/,
      )
      assert.match(
        r.stderr,
        /\n {2}scripts\/coverage-baseline\.json: declared in NO_PATHS but not in this checkout\n/,
      )
      assert.match(
        r.stderr,
        /\n {2}scripts\/check-ipc-error-path\.mjs: declared as carrying `NO_TEST_ALLOWLIST` but not in this checkout\n/,
      )
    },
  )
})

void test('a source that cannot be read, or yields nothing, fails closed', () => {
  withGuardRepo(
    {
      edit: ({ write }) => {
        write(CONTENT_REGEX, '[{"file": ')
        write('scripts/doc-code-paths-baseline.json', Buffer.from([0xff, 0xfe]))
        write('scripts/bulk-equivalence-baseline.json', '[{"test": "x"}]')
        write(DYNAMIC_SQL, '# emptied\n')
        write(RAW_INVOKE, "const RENAMED = ['entry/']\n")
        write('scripts/check-raw-local-storage.mjs', Buffer.from([0xff, 0xfe]))
      },
    },
    (run) => {
      const r = run()
      assert.equal(r.status, 1, r.stderr)
      assert.match(
        r.stderr,
        /\n {2}scripts\/content-regex-baseline\.json: could not be read as `json:file` \(SyntaxError: /,
      )
      assert.match(
        r.stderr,
        /\n {2}scripts\/doc-code-paths-baseline\.json: could not be read as `json:file` \(TypeError: /,
      )
      assert.match(
        r.stderr,
        /\n {2}scripts\/bulk-equivalence-baseline\.json: could not be read as `json:fn::` \(Error: missing field `fn`\)\n/,
      )
      assert.match(r.stderr, /\n {2}src-tauri\/dynamic-sql-baseline\.txt: yielded ZERO entries\./)
      assert.match(
        r.stderr,
        /\n {2}scripts\/check-raw-invoke\.mjs: `EXEMPT_FILES` yielded no entries/,
      )
      assert.match(
        r.stderr,
        /\n {2}scripts\/check-raw-invoke\.mjs: `EXEMPT_DIR_PREFIXES` yielded no entries/,
      )
      assert.match(
        r.stderr,
        /\n {2}scripts\/check-raw-local-storage\.mjs: could not be read for `EXEMPT_FILES` \(TypeError: /,
      )
    },
  )
})

void test('an embedded set whose literal is present but empty fails closed', () => {
  withGuardRepo(
    {
      edit: ({ write }) =>
        write(RAW_INVOKE, 'const EXEMPT_FILES = []\nconst EXEMPT_DIR_PREFIXES = new Set([])\n'),
    },
    (run) => {
      const r = run()
      assert.equal(r.status, 1, r.stderr)
      assert.match(
        r.stderr,
        /\n {2}scripts\/check-raw-invoke\.mjs: `EXEMPT_FILES` yielded no entries/,
      )
      assert.match(
        r.stderr,
        /\n {2}scripts\/check-raw-invoke\.mjs: `EXEMPT_DIR_PREFIXES` yielded no entries/,
      )
    },
  )
})

void test('outside a git checkout discovery fails closed, and the declared sources are still checked', () => {
  withGuardRepo({ git: false, edit: ({ write }) => write(DYNAMIC_SQL, '1 gone.rs\n') }, (run) => {
    const r = run()
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /the repository could not be ENUMERATED/)
    assert.match(r.stderr, /dynamic-sql-baseline\.txt: `gone\.rs` names a path that does not exist/)
  })
})

void test('a git repository that tracks no files fails discovery closed', () => {
  withGuardRepo({ track: false }, (run) => {
    const r = run()
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /the repository could not be ENUMERATED/)
  })
})

void test('an unknown argument exits 2 naming it', () => {
  withGuardRepo({}, (run) => {
    const r = run('-v', '--bogus')
    assert.equal(r.status, 2, r.stderr)
    assert.equal(r.stderr, 'check-baseline-paths: unknown argument(s): ["--bogus"]\n')
  })
})
