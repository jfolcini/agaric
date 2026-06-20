#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// STRICT tables policy check.
//
// Enforces the AGENTS.md invariant under "Database":
// every new `CREATE TABLE` in a SQLite migration must use STRICT mode.
// Existing pre-policy migrations (0001..0041) are skipped via a
// migration-number floor — they're immutable per the existing
// `migrations-immutable` hook and will not be retrofitted.
// FTS5 / virtual tables are carved out (SQLite forbids STRICT there).
//
// Usage: node scripts/check-migrations-strict.mjs <file.sql> [<file.sql>...]
// Exit:  0 = clean, 1 = at least one new CREATE TABLE missed STRICT.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// First migration required to use STRICT. Bump only when introducing
// A new policy floor; existing migrations 0001..0041 predate.
const FIRST_STRICT_MIGRATION = 42

/**
 * Strip SQL line comments (dash-dash) and block comments (slash-star)
 * while preserving content inside single-quoted string literals.
 * This prevents semicolons or parens inside comments from being
 * misinterpreted as statement terminators / structure markers.
 */
function stripSqlComments(sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === "'") {
      // String literal: find closing quote (no escape handling needed
      // for standard SQL single quotes in this context).
      const end = sql.indexOf("'", i + 1)
      if (end === -1) {
        out += sql.slice(i)
        break
      }
      out += sql.slice(i, end + 1)
      i = end + 1
      continue
    }

    if (ch === '-' && next === '-') {
      // Line comment: skip to end of line.
      const end = sql.indexOf('\n', i)
      if (end === -1) break
      i = end + 1
      continue
    }

    if (ch === '/' && next === '*') {
      // Block comment: skip to matching */.
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 2
      continue
    }

    out += ch
    i++
  }
  return out
}

const files = process.argv.slice(2)
let failed = false

for (const file of files) {
  const name = basename(file)
  // Migration filename convention: NNNN_*.sql
  const match = name.match(/^(\d+)_/)
  if (match) {
    const n = parseInt(match[1], 10)
    if (n < FIRST_STRICT_MIGRATION) continue
  }

  const src = stripSqlComments(readFileSync(file, 'utf8'))

  // Walk every CREATE TABLE in the file. The regex captures the
  // statement start; we then walk forward to the terminating `;`
  // (SQLite syntax does not nest `;`, so this is safe).
  //
  // The identifier class covers all four SQLite spellings — bare,
  // "double-quoted", `backticked`, [bracketed] — plus an optional
  // schema qualifier (`main.t`). A quoted name (`CREATE TABLE "x"`)
  // previously failed to match at all, silently skipping the STRICT
  // check for that table (issue #818 (1)).
  const ident = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w]*)'
  const re = new RegExp(
    `CREATE\\s+(VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?((?:${ident}\\s*\\.\\s*)?${ident})`,
    'gi',
  )
  for (const m of src.matchAll(re)) {
    // FTS5 / other virtual tables: STRICT is not accepted.
    if (m[1]) continue

    const startIdx = m.index
    const tableName = m[2]

    // Find statement terminator.
    const semiIdx = src.indexOf(';', startIdx)
    const stmt = semiIdx === -1 ? src.slice(startIdx) : src.slice(startIdx, semiIdx)

    // Compute the post-`)` tail of the column-list block. We look for
    // the LAST `)` in the statement — table options (STRICT,
    // WITHOUT ROWID) live after the column-list close-paren.
    const closeIdx = stmt.lastIndexOf(')')
    const tail = closeIdx === -1 ? stmt : stmt.slice(closeIdx + 1)

    if (!/\bSTRICT\b/i.test(tail)) {
      // Line number of the CREATE keyword.
      const line = src.slice(0, startIdx).split('\n').length
      console.error(
        `ERROR: ${file} line ${line}: CREATE TABLE ${tableName} must use STRICT mode (see AGENTS.md § Database)`,
      )
      failed = true
    }
  }
}

process.exit(failed ? 1 : 0)
