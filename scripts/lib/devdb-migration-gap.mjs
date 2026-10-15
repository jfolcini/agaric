// The body of `devdb_migration_gap` in scripts/verify-ci-equivalent.sh (#4266);
// the contract is that function's comment. Run as
//
//     node --no-warnings scripts/lib/devdb-migration-gap.mjs <src_tauri> <migrations_dir>
//
// It prints a diagnosis and the exact remedy on stdout (nothing when dev.db is
// caught up) and exits 0 when caught up, 1 on a confirmed gap, 2 when it could
// not inspect. Node exits 1 on an uncaught error, which the caller would read
// as a confirmed gap and hard-block the push with a stack trace for a
// diagnosis, so every failure once this file runs goes through the one
// try/catch at the bottom and exits 2. That includes `node:sqlite` itself
// failing to load, which is why it is imported dynamically inside that try
// rather than at the top.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { unescape as percentDecode } from 'node:querystring'

const lines = []
const say = (...text) => lines.push(...text)

const REMEDY = ['    cd src-tauri', '    cargo sqlx migrate run']
const REPROVISION = [
  '    rm -f src-tauri/dev.db src-tauri/dev.db-wal src-tauri/dev.db-shm',
  '    bash scripts/setup-dev-db.sh',
]

// A path that cannot be stat'ed (absent, or under an unsearchable directory)
// is not a file: its diagnosis is "does not exist", not "could not inspect".
function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const QUERY_CRED_KEY_RE =
  /\b(password|pwd|passwd|secret|token|api[_-]?key|access[_-]?token)=[^&#]*/gi

// Redacts userinfo (user:password@) and credential-shaped query values from a
// URL before it is printed: push output gets pasted into issues and chat, and
// a non-sqlite DATABASE_URL ("postgres://user:password@host/db",
// "postgres://host/db?password=secret") can carry a real credential.
//
// Userinfo: the authority is everything after "//" up to the first "?", "#"
// or end of string, captured WHOLE, and everything before its LAST "@" becomes
// "***". The last, not the first, because a password may contain an "@"; the
// whole span, not a class that excludes "/", because a password may contain a
// raw "/". That also redacts a stray "@" in a path with no userinfo, which is
// the safe direction. A URL with no "//" or no "@" in its authority is
// returned unchanged.
//
// Query string: kept in the printed line because host, dbname and sslmode are
// diagnostic, but some drivers take "?password=" instead of userinfo, so the
// VALUE of any credential-shaped key is redacted. A heuristic list of key
// names, not a guarantee.
function redactUrlCredentials(url) {
  const redacted = url.replace(/(\/\/)([^?#]*)/, (_, prefix, authority) => {
    const at = authority.lastIndexOf('@')
    return at === -1 ? prefix + authority : `${prefix}***${authority.slice(at)}`
  })
  const q = redacted.indexOf('?')
  if (q === -1) return redacted
  return redacted.slice(0, q + 1) + redacted.slice(q + 1).replace(QUERY_CRED_KEY_RE, '$1=***')
}

// sqlx-sqlite's `SqliteConnectOptions::from_str` strips "sqlite://" and
// "sqlite:" as PLAIN string prefixes (no authority parse, so "sqlite://dev.db"
// is "dev.db" and "sqlite:///abs/path" is "/abs/path"), splits once on the
// first "?", then percent-decodes the rest "to allow for `?` or `#` in the
// filename" (its own comment), lossily. `querystring.unescape` decodes the
// same way and, unlike URLSearchParams, leaves "+" alone.
function resolveSqlitePath(url) {
  let rest = url.slice('sqlite:'.length)
  const q = rest.indexOf('?')
  if (q !== -1) rest = rest.slice(0, q)
  if (rest.startsWith('//')) rest = rest.slice(2)
  return percentDecode(rest)
}

// A relaxed .env line parser, not a dotenvy reimplementation, for the forms
// real .env files use: an optional "export " prefix, spaces around "=", one
// matched pair of surrounding quotes (exactly one quote per side, and anything
// after the closing quote dropped), and a trailing "# comment" outside quotes.
// dotenvy keeps the FIRST "DATABASE_URL=" line, so the first line that assigns
// the key decides, usable or not.
//
// Returns { value } for a clean assignment, { ambiguous: true } when the key is
// only mentioned in a form this parser does not recognise (a YAML-style
// "DATABASE_URL:", prose) or is assigned an unresolved "${VAR}" reference, and
// {} when the file says nothing about it. Using an ambiguous value verbatim
// would name a nonexistent file and hard-block with the wrong diagnosis.
function readEnvDatabaseUrl(envFile) {
  let mentioned = false
  for (const raw of readFileSync(envFile, 'utf8').split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/.exec(line)
    if (m === null) {
      // A word boundary, not a substring test: "POSTGRES_DATABASE_URL=" and
      // "DATABASE_URL_REPLICA=" name different keys.
      if (/\bDATABASE_URL\b/.test(line)) mentioned = true
      continue
    }
    let v = m[1].trim()
    if (v.startsWith('"') || v.startsWith("'")) {
      const end = v.indexOf(v[0], 1)
      v = end === -1 ? v.slice(1) : v.slice(1, end)
    } else {
      // dotenvy starts a comment only at a "#" PRECEDED BY WHITESPACE in an
      // unquoted value, so "sqlite:my#db.db" is the whole value.
      const hash = v.search(/(?<=\s)#/)
      if (hash !== -1) v = v.slice(0, hash)
      v = v.trim()
    }
    return v.includes('${') ? { ambiguous: true } : { value: v }
  }
  return mentioned ? { ambiguous: true } : {}
}

// The "cannot tell" cases: a DATABASE_URL that resolved, but to nothing this
// preflight can check. Each is a warn (2), never a block (1): checking dev.db
// instead would hard-block with a remedy aimed at the wrong database.
function uncheckableUrl(val) {
  if (val === '') {
    say(
      "DATABASE_URL is set but empty: ''",
      '  There is nothing here for this preflight to check against —',
      '  it cannot tell whether your actual database is caught up',
      '  with migrations/. If you are using sqlite, set it to a',
      '  plain sqlite: URL, e.g.:',
      '    DATABASE_URL=sqlite:dev.db',
    )
    return 2
  }
  if (!val.startsWith('sqlite:')) {
    say(
      `DATABASE_URL is set but is not a sqlite: URL: '${redactUrlCredentials(val)}'`,
      '  This preflight only understands sqlite: URLs and cannot tell',
      '  whether your actual database is caught up with migrations/.',
      '  If you are using sqlite, set it to a plain sqlite: URL, e.g.:',
      '    DATABASE_URL=sqlite:dev.db',
    )
    return 2
  }
  const dbRel = resolveSqlitePath(val)
  if (dbRel === ':memory:') {
    say(
      'DATABASE_URL is sqlite::memory: — an in-memory database',
      '  There is no on-disk file for this preflight to check against —',
      '  it cannot tell whether an in-memory database is caught up',
      '  with migrations/.',
    )
    return 2
  }
  if (dbRel === '') {
    say(
      `DATABASE_URL resolves to an empty sqlite path: '${redactUrlCredentials(val)}'`,
      '  There is no filename here for this preflight to check against —',
      '  it cannot tell whether your actual database is caught up with',
      '  migrations/. Set it to a plain sqlite: URL naming a file, e.g.:',
      '    DATABASE_URL=sqlite:dev.db',
    )
    return 2
  }
  return null
}

// A gap is only CONFIRMED (1, hard block) when the build would read dev.db.
// With DATABASE_URL set nowhere, sqlx-macros-core resolves no database URL
// and `sqlx::query!` always falls back to the committed `.sqlx/` cache, so
// this push never opens the file: report its real state, as a warn (2).
function confirmedGap(databaseUrlUnset) {
  if (!databaseUrlUnset) return 1
  say(
    '  (DATABASE_URL is not set anywhere — no export, no .env entry —',
    "  so cargo sqlx's query macros resolve from the committed",
    '  src-tauri/.sqlx/ query cache and never open this file for THIS',
    '  push. This is a heads-up, not a confirmed reason your build',
    '  would fail; provision it anyway before you rely on it, e.g. for',
    '  `cargo sqlx prepare` or a future push that DOES set DATABASE_URL.)',
  )
  return 2
}

function migrationsOnDisk(migrationsDir) {
  const expected = new Map()
  if (!isDir(migrationsDir)) return expected
  for (const fn of readdirSync(migrationsDir).toSorted()) {
    const m = /^(\d+)_.+\.sql$/.exec(fn)
    if (m) expected.set(Number(m[1]), fn)
  }
  return expected
}

// Version -> stored checksum of every migration that applied successfully, or
// null when dev.db has no `_sqlx_migrations` table. `success`, because sqlx
// itself treats a failed row as needing `cargo sqlx migrate repair`, not as
// applied. A plain path with `readOnly`, not a `file:` URI, so a checkout path
// containing "#", "?" or "%" needs no escaping, and a missing file is an open
// error rather than a new empty database.
function readApplied(DatabaseSync, dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'")
      .get()
    if (table === undefined) return null
    const rows = db.prepare('SELECT version, checksum FROM _sqlx_migrations WHERE success').all()
    return new Map(rows.map((row) => [row.version, row.checksum]))
  } finally {
    db.close()
  }
}

const ascending = (a, b) => a - b

// Applied versions whose stored checksum no longer matches the file. sqlx
// stores SHA-384 over the migration's SQL text (`Migration::new` in
// sqlx-core), so an in-place edit to an already-applied migration, which
// leaves the version sets equal and the schemas different, is caught for one
// hash per file. A NULL checksum (sqlx never writes one; a hand-built database
// can) is no evidence of drift and is skipped.
function driftedVersions(applied, expected, migrationsDir) {
  return [...applied.keys()].toSorted(ascending).filter((v) => {
    const stored = applied.get(v)
    if (!expected.has(v) || stored == null) return false
    const actual = createHash('sha384')
      .update(readFileSync(join(migrationsDir, expected.get(v))))
      .digest()
    return !actual.equals(stored)
  })
}

// Behind first: when dev.db is both behind and drifted, `migrate run` is the
// remedy that moves it forward. Then ahead (a version applied with no file,
// what switching off a branch that added a migration leaves behind), then
// drifted; neither of those two is fixable by `migrate run`.
function compare(applied, expected, migrationsDir) {
  const pending = [...expected.keys()].filter((v) => !applied.has(v)).toSorted(ascending)
  if (pending.length > 0) {
    say(
      'dev.db is behind src-tauri/migrations/ — pending migration(s):',
      ...pending.map((v) => `    ${expected.get(v)}`),
      '  Apply them:',
      ...REMEDY,
    )
    return false
  }
  const ahead = [...applied.keys()].filter((v) => !expected.has(v)).toSorted(ascending)
  if (ahead.length > 0) {
    say(
      'dev.db is AHEAD of src-tauri/migrations/ — applied migration(s) with no file:',
      ...ahead.map((v) => `    version ${v} (no matching src-tauri/migrations/${v}_*.sql)`),
      '  This is what switching off a branch that added a migration leaves behind.',
      '  `sqlx migrate run` cannot fix it — there is nothing left to run. Either',
      '  check that branch back out, or re-provision dev.db from scratch:',
      ...REPROVISION,
    )
    return false
  }
  const drifted = driftedVersions(applied, expected, migrationsDir)
  if (drifted.length > 0) {
    say(
      "dev.db's applied migration(s) no longer match src-tauri/migrations/ on disk:",
      ...drifted.map((v) => `    ${expected.get(v)} (edited in place after it was applied)`),
      '  The version numbers agree, so dev.db LOOKS caught up, but its schema is',
      '  whatever the OLD text of these file(s) produced. `sqlx migrate run` will',
      '  not re-run an already-applied version; re-provision dev.db from scratch:',
      ...REPROVISION,
    )
    return false
  }
  return true
}

// DATABASE_URL resolves the way sqlx-cli does: an exported value wins over
// `.env` (dotenvy never overrides a set variable), and "dev.db", sqlx-cli's own
// default, applies when neither names one.
function main(DatabaseSync, srcTauri, migrationsDir) {
  let val = process.env.DATABASE_URL
  if (!val) {
    const envFile = join(srcTauri, '.env')
    if (isFile(envFile)) {
      const env = readEnvDatabaseUrl(envFile)
      if (env.ambiguous) {
        say(
          `could not resolve DATABASE_URL from ${envFile}`,
          '  (unrecognized .env form, or an unresolved ${VAR}-style reference)',
          '  Set it to a plain sqlite: URL so this preflight can check it, e.g.:',
          '    DATABASE_URL=sqlite:dev.db',
        )
        return 2
      }
      if (env.value !== undefined) val = env.value
    }
  }
  const databaseUrlUnset = val === undefined
  let dbRel = 'dev.db'
  if (!databaseUrlUnset) {
    const warn = uncheckableUrl(val)
    if (warn !== null) return warn
    dbRel = resolveSqlitePath(val)
  }
  const dbFile = isAbsolute(dbRel) ? dbRel : join(srcTauri, dbRel)

  if (!isFile(dbFile)) {
    say(
      `dev.db does not exist: ${dbFile}`,
      '  Provision it (idempotent):',
      '    bash scripts/setup-dev-db.sh',
      '  or apply migrations directly:',
      ...REMEDY,
    )
    return confirmedGap(databaseUrlUnset)
  }

  const expected = migrationsOnDisk(migrationsDir)
  let applied
  try {
    applied = readApplied(DatabaseSync, dbFile)
  } catch (err) {
    // An unreadable, truncated or non-sqlite file: not evidence of a gap.
    if (err?.code !== 'ERR_SQLITE_ERROR') throw err
    say(`could not inspect dev.db (${dbFile}): ${err.message}`)
    return 2
  }
  if (applied === null) {
    say(
      `dev.db exists but has never been migrated (no _sqlx_migrations table): ${dbFile}`,
      '  Apply all migrations:',
      ...REMEDY,
    )
    return confirmedGap(databaseUrlUnset)
  }
  return compare(applied, expected, migrationsDir) ? 0 : confirmedGap(databaseUrlUnset)
}

let code
try {
  const { DatabaseSync } = await import('node:sqlite')
  const [srcTauri, migrationsDir] = process.argv.slice(2)
  code = main(DatabaseSync, srcTauri, migrationsDir)
} catch (err) {
  // A permission or OS error reading .env, migrations/ or a migration file,
  // or anything else unexpected: say so plainly and exit 2, so the caller
  // warns instead of hard-blocking a push nothing is wrong with.
  say(`could not inspect dev.db: ${err?.name}: ${err?.message}`)
  code = 2
}
process.stdout.write(lines.map((line) => `${line}\n`).join(''))
process.exitCode = code
