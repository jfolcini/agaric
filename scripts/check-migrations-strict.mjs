#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// STRICT tables policy check (PEND-07).
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
// a new policy floor; existing migrations 0001..0041 predate PEND-07.
const FIRST_STRICT_MIGRATION = 42

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

  const src = readFileSync(file, 'utf8')

  // Walk every CREATE TABLE in the file. The regex captures the
  // statement start; we then walk forward to the terminating `;`
  // (SQLite syntax does not nest `;`, so this is safe).
  const re = /CREATE\s+(VIRTUAL\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/gi
  for (const m of src.matchAll(re)) {
    // FTS5 / other virtual tables: STRICT is not accepted.
    if (m[1]) continue

    const startIdx = m.index
    const tableName = m[3]

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
