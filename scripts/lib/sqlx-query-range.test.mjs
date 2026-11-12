import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { initScratchRepo, scrubbedGitEnv, withScrubbedProcessEnv } from './git-scratch-guard.mjs'
import { decide, gitRunner, parsePatch, querySpans, rangeVerdict } from './sqlx-query-range.mjs'

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

const HELPER = join(import.meta.dirname, 'sqlx-query-range.mjs')
const RS = 'src-tauri/src/a.rs'

// The query_as! spans lines 3-7.
const QUERY_FILE = `fn one() {}
async fn f(pool: &Pool) {
    let row = sqlx::query_as!(
        Row,
        "SELECT id FROM blocks WHERE id = ?",
        id,
    )
    .fetch_one(pool)
    .await;
}
fn two() {}
`

const replaceLine = (text, line, body) => {
  const lines = text.split('\n')
  lines[line - 1] = body
  return lines.join('\n')
}

// A one-line edit of `line` in `text`, as `decide` receives it.
const editAt = (text, line, newText = text) => ({
  oldPath: RS,
  newPath: RS,
  oldText: text,
  newText,
  hunks: [{ oldStart: line, oldCount: 1, newStart: line, newCount: 1 }],
})

function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'sqlx-query-range-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const dir = join(root, 'repo')
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      // Writes (or, for null, deletes) each path, commits, and returns the sha.
      const commit = (files) => {
        for (const [path, body] of Object.entries(files)) {
          if (body === null) {
            git('rm', '-q', path)
          } else {
            mkdirSync(dirname(join(dir, path)), { recursive: true })
            writeFileSync(join(dir, path), body)
          }
        }
        git('add', '-A')
        git('commit', '-qm', 'step', '--allow-empty')
        return git('rev-parse', 'HEAD').trim()
      }
      const real = gitRunner({ cwd: dir, env })
      const cli = (...args) =>
        spawnSync(process.execPath, [HELPER, ...args], { cwd: dir, env, encoding: 'utf8' })
      fn({
        git,
        commit,
        real,
        cli,
        verdict: (base, head, run = real) => rangeVerdict(base, head, run),
      })
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('a hunk on an inner line of a multi-line macro runs', () => {
  withRepo(({ commit, verdict }) => {
    const base = commit({ [RS]: QUERY_FILE })
    const head = commit({ [RS]: replaceLine(QUERY_FILE, 6, '        other_id,') })
    assert.equal(verdict(base, head), `run: ${RS}:6 is inside sqlx::query_as!`)
  })
})

void test('an unbalanced ) inside a raw-string query does not end the span', () => {
  const text = `fn g() {
    sqlx::query!(
        r#"SELECT ) FROM t"#,
        id,
    )
}
`
  assert.deepEqual(querySpans(text), [[2, 5]])
  assert.equal(
    decide({ paths: [RS], files: [editAt(text, 4)], wrapper: null }),
    `run: ${RS}:4 is inside sqlx::query!`,
  )
})

void test('an edit outside every span, on a comment naming the macro, skips', () => {
  const after = replaceLine(QUERY_FILE, 1, 'fn one() {} // like sqlx::query!(x) below')
  // `-7,0 +8` inserts after the macro's closing line 7; the empty side names no line.
  const inserted = {
    ...editAt(QUERY_FILE, 7, replaceLine(QUERY_FILE, 7, '    )\n    // after')),
    hunks: [{ oldStart: 7, oldCount: 0, newStart: 8, newCount: 1 }],
  }
  assert.equal(
    decide({
      paths: [RS],
      files: [editAt(QUERY_FILE, 1, after), editAt(QUERY_FILE, 11), inserted],
      wrapper: null,
    }),
    'skip',
  )
})

void test('{} and [] delimiters, an aliased path and a bare query! are all spans', () => {
  const text = `fn a() {
    let _ = ::sqlx::query_scalar! {
        "SELECT 1"
    };
    let _ = db::query!(
        "SELECT 2"
    );
    let _ = query_as_unchecked![
        "SELECT 3"
    ];
}
`
  assert.deepEqual(querySpans(text), [
    [2, 4],
    [5, 7],
    [8, 10],
  ])
})

void test('a macro_rules! wrapping a query macro always runs; one feeding runtime query( does not', () => {
  withRepo(({ commit, verdict }) => {
    const runtime = `macro_rules! ancestors {
    ($id:expr) => {
        sqlx::query(concat!("SELECT ", $id))
    };
}
`
    const base = commit({ [RS]: QUERY_FILE, 'src-tauri/src/m.rs': runtime })
    const unrelated = commit({ [RS]: replaceLine(QUERY_FILE, 11, 'fn two() { todo!() }') })
    assert.equal(verdict(base, unrelated), 'skip')
    commit({
      'src-tauri/src/m.rs': `${runtime}macro_rules! fetch_one {
    ($pool:expr, $sql:literal) => {
        sqlx::query!($sql).fetch_one($pool)
    };
}
`,
    })
    const head = commit({ [RS]: replaceLine(QUERY_FILE, 1, 'fn one() { todo!() }') })
    assert.equal(verdict(`${head}^`, head), 'run: wrapper macro fetch_one (src-tauri/src/m.rs)')
  })
})

void test('deleting a .sql file, a migration or a .sqlx entry runs', () => {
  withRepo(({ commit, verdict }) => {
    const files = [
      'src-tauri/.sqlx/query-abc.json',
      'src-tauri/migrations/0001_init.sql',
      'src-tauri/agaric-store/queries/x.sql',
    ]
    commit(Object.fromEntries(files.map((path) => [path, 'x\n'])))
    for (const path of files) {
      const head = commit({ [path]: null })
      assert.equal(verdict(`${head}^`, head), `run: ${path} changed`)
    }
  })
})

void test('an sqlx bump in Cargo.lock or a member Cargo.toml runs', () => {
  for (const path of ['src-tauri/Cargo.lock', 'src-tauri/agaric-store/Cargo.toml']) {
    assert.equal(decide({ paths: [path], files: [], wrapper: null }), `run: ${path} changed`)
  }
})

void test('a pure rename skips; a rename with an in-span edit runs', () => {
  withRepo(({ commit, verdict }) => {
    const moved = 'src-tauri/src/b.rs'
    const base = commit({ [RS]: QUERY_FILE })
    const rename = commit({ [RS]: null, [moved]: QUERY_FILE })
    assert.equal(verdict(base, rename), 'skip')
    const edited = commit({
      [moved]: null,
      [RS]: replaceLine(QUERY_FILE, 5, '        "SELECT 1",'),
    })
    assert.equal(verdict(rename, edited), `run: ${RS}:5 is inside sqlx::query_as!`)
  })
})

void test('deleting a query-bearing file, or turning query! into runtime query(, runs', () => {
  withRepo(({ commit, verdict }) => {
    const base = commit({ [RS]: QUERY_FILE })
    const deleted = commit({ [RS]: null })
    assert.equal(verdict(base, deleted), `run: ${RS}:3 before the change is inside sqlx::query_as!`)
    commit({ [RS]: QUERY_FILE })
    const runtime = commit({ [RS]: replaceLine(QUERY_FILE, 3, '    let row = sqlx::query_as(') })
    assert.equal(
      verdict(`${runtime}^`, runtime),
      `run: ${RS}:3 before the change is inside sqlx::query_as!`,
    )
  })
})

// Rewrites the git call whose arguments satisfy `pick` into one that fails.
const failing = (real, pick) => (args) =>
  real(pick(args) ? ['rev-parse', '--verify', 'no-such-rev'] : args)

void test('an empty range skips only when both git diffs succeed', () => {
  withRepo(({ commit, cli, real, verdict }) => {
    const head = commit({ [RS]: QUERY_FILE })
    const r = cli(head, head)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'skip\n')
    const nameStatus = failing(real, (args) => args.includes('--name-status'))
    assert.throws(() => verdict(head, head, nameStatus), /no-such-rev/)
    const docs = commit({ 'README.md': 'x\n' })
    const patch = failing(real, (args) => args.includes('-U0'))
    assert.throws(() => verdict(head, docs, patch), /no-such-rev/)
  })
})

void test('an unreadable revision or file, a listed .rs with no diff, or an unknown patch line fails', () => {
  withRepo(({ commit, cli, real, verdict }) => {
    const base = commit({ [RS]: QUERY_FILE })
    const head = commit({ [RS]: replaceLine(QUERY_FILE, 11, 'fn two() { todo!() }') })
    const r = cli('0123456789abcdef0123456789abcdef01234567', head)
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^sqlx-query-range: /)
    const show = failing(real, (args) => args[0] === 'show')
    assert.throws(() => verdict(base, head, show), /no-such-rev/)
    const noSection = (args) => real(args.includes('-U0') ? [...args.slice(0, -1), '*.none'] : args)
    assert.throws(
      () => verdict(base, head, noSection),
      /src-tauri\/src\/a\.rs is listed as changed but has no diff/,
    )
    const binary = `diff --git a/${RS} b/${RS}\nBinary files a/${RS} and b/${RS} differ\n`
    assert.throws(() => parsePatch(binary), /unparseable diff line: Binary files/)
  })
})

void test('an unterminated macro spans to the end of the file and runs', () => {
  const text = `fn f() {
    sqlx::query!(
        "SELECT 1",
        id,
`
  assert.deepEqual(querySpans(text), [[2, 4]])
  assert.equal(
    decide({ paths: [RS], files: [editAt(text, 4)], wrapper: null }),
    `run: ${RS}:4 is inside sqlx::query!`,
  )
})
