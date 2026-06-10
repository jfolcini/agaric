#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Blocks-rebuild cascade guard (#606).
//
// Under `foreign_keys = ON`, `DROP TABLE blocks` IMMEDIATELY
// cascade-deletes every row of every child table with an
// `ON DELETE CASCADE` FK into blocks — the cascade is part of the
// DROP, not a deferred validation, so the migration transaction does
// not protect children. Most children re-materialize from the op log;
// `page_aliases` (no op_log entries) and `block_drafts` (device-local)
// do NOT — the shipped rebuilds 0073/0080/0085 destroyed both.
//
// This hook greps every NEW migration containing a `DROP TABLE blocks`
// statement and requires the same file to also reference both
// authoritative satellites (`page_aliases`, `block_drafts`) in
// non-comment SQL — i.e. the copy-aside/restore recipe from
// migrations/AGENTS.md §Table-rebuild. It is a deliberately shallow
// textual tripwire: a quoted (`"blocks"`) or schema-qualified
// (`main.blocks`) drop, or a rename-first rebuild, evades it, and a
// string literal mentioning the phrase false-positives it (fail-closed).
// The real verification is the seed-then-migrate harness — any future
// migration that actually wipes the satellites fails the `*_606` tests
// in src-tauri/src/db.rs regardless of how the drop is spelled.
//
// Usage: node scripts/check-migrations-rebuild-cascade.mjs <f.sql>...
// Exit:  0 = clean, 1 = a guarded rebuild misses the preservation step.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// First migration the guard applies to. 0073/0080/0085 shipped without
// preservation (immutable; damage done) and are exempt.
const FIRST_GUARDED_MIGRATION = 89

// Child tables of `blocks` that do NOT recover from the op log.
const AUTHORITATIVE_SATELLITES = ['page_aliases', 'block_drafts']

/**
 * Strip SQL line comments (dash-dash) and block comments (slash-star)
 * while preserving content inside single-quoted string literals.
 * (Same stripper as check-migrations-strict.mjs.)
 */
function stripSqlComments(sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === "'") {
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
      const end = sql.indexOf('\n', i)
      if (end === -1) break
      i = end + 1
      continue
    }

    if (ch === '/' && next === '*') {
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
  const match = name.match(/^(\d+)_/)
  if (match && parseInt(match[1], 10) < FIRST_GUARDED_MIGRATION) continue

  const src = stripSqlComments(readFileSync(file, 'utf8'))

  if (!/\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?blocks\b/i.test(src)) continue

  for (const table of AUTHORITATIVE_SATELLITES) {
    const re = new RegExp(`\\b${table}\\b`, 'i')
    if (!re.test(src)) {
      console.error(
        `ERROR: ${file}: \`DROP TABLE blocks\` cascade-wipes ${table} ` +
          `(ON DELETE CASCADE fires at the DROP, inside the migration tx; ` +
          `${table} does not recover from the op log). Copy it to a scratch ` +
          `table before the DROP and restore it after the rename — recipe in ` +
          `src-tauri/migrations/AGENTS.md §Table-rebuild (#606).`,
      )
      failed = true
    }
  }
}

process.exit(failed ? 1 : 0)
