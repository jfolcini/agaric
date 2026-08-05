#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Blocks-rebuild cascade guard (#606).
//
// With `foreign_keys = ON`, `DROP TABLE blocks` immediately fires FK
// actions. That destroys authoritative `page_aliases` and `block_drafts`
// rows. Since 0089, it can also cascade blocks → spaces and then apply
// spaces → blocks.space_id ON DELETE SET NULL, destroying both the space
// registry and memberships copied into the replacement table.
//
// Future rebuilds must therefore use the ordered copy-aside recipe in
// migrations/AGENTS.md §Table-rebuild. This guard validates executable
// snapshot/restore statements and their ordering; names in comments,
// strings, or unrelated SELECTs do not satisfy it. Runtime migration tests
// in src-tauri/src/db/tests.rs provide the deeper seed-then-migrate proof.
//
// Migration 0089 is the one-time registry introduction: no `spaces` table
// exists at its input boundary, so its specialized property-backed
// backfill is checked separately. The full registry/member recipe applies
// to every later blocks rebuild.
//
// #3271: the required-column sets for `block_drafts` and `spaces` used to
// be hardcoded lists, and the `block_drafts` one went stale the moment
// 0092 added `draft_anchor_seq`/`draft_anchor_device` — a rebuild whose
// snapshot dropped those columns would have passed silently. Both sets
// are now DERIVED by replaying every real migration file on disk up to
// (not including) the one under test (`schemaAsOf`), so a future column
// addition is automatically required in the next rebuild's snapshot/
// restore with no hand-edit to this script. If derivation ever can't find
// a table (a gap in the tracker's CREATE/ALTER/RENAME/DROP handling), the
// guard fails loudly instead of silently treating "no required columns"
// as "nothing to check".
//
// Usage: node scripts/check-migrations-rebuild-cascade.mjs <f.sql>...
//        node scripts/check-migrations-rebuild-cascade.mjs --self-test
// Exit:  0 = clean, 1 = a guarded rebuild misses the preservation step.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'node:fs'
import { basename } from 'node:path'

const FIRST_GUARDED_MIGRATION = 89
const SPACES_INTRODUCTION_MIGRATION = 89
const MIGRATIONS_DIR = new URL('../src-tauri/migrations/', import.meta.url)

/**
 * Remove SQL comments and single-quoted string contents. Keeping strings
 * would let `SELECT 'INSERT INTO spaces ...'` satisfy a textual guard.
 */
function stripSqlNoise(sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === "'") {
      out += ' '
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += '  '
          i += 2
        } else if (sql[i] === "'") {
          out += ' '
          i++
          break
        } else {
          out += sql[i] === '\n' ? '\n' : ' '
          i++
        }
      }
      continue
    }

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      if (end === -1) break
      out += '\n'
      i = end + 1
      continue
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) break
      const comment = sql.slice(i, end + 2)
      out += comment.replace(/[^\n]/g, ' ')
      i = end + 2
      continue
    }

    out += ch
    i++
  }
  return out
}

function normalizeStatement(statement) {
  return statement
    .replace(/"([^"]+)"/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function statementsFor(sql) {
  return stripSqlNoise(sql).split(';').map(normalizeStatement).filter(Boolean)
}

function findStatement(statements, pattern, start = 0, end = statements.length) {
  for (let i = start; i < end; i++) {
    if (pattern.test(statements[i])) return i
  }
  return -1
}

function tableCreatedBefore(statements, table, before) {
  const createRe = new RegExp(
    `^create\\s+(?:(?:temp|temporary)\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\b`,
  )
  return findStatement(statements, createRe, 0, before) >= 0
}

/** Find a real scratch-table snapshot and return its table and statement index. */
function selectProjection(statement, source) {
  const match = statement.match(
    new RegExp(`\\bselect\\s+(.+?)\\s+from\\s+(?:main\\.)?${source}\\b`),
  )
  return match?.[1]?.trim() ?? null
}

function projectionProvides(projection, source, requiredColumns) {
  if (projection === '*' || projection === `${source}.*`) return true
  const outputColumns = new Set(
    projection.split(',').map((expression) => {
      const alias = expression.match(/\bas\s+([a-z_][a-z0-9_]*)$/)?.[1]
      if (alias) return alias
      return expression.trim().split('.').at(-1)
    }),
  )
  return requiredColumns.every((column) => outputColumns.has(column))
}

function findSnapshot(statements, source, before, requiredColumns) {
  const sourceRe = new RegExp(`\\bfrom\\s+(?:main\\.)?${source}\\b`)
  const insertRe = /^insert\s+into\s+([a-z_][a-z0-9_]*)\b/
  const ctasRe = /^create\s+(?:(?:temp|temporary)\s+)?table\s+([a-z_][a-z0-9_]*)\s+as\s+select\b/

  for (let i = 0; i < before; i++) {
    const statement = statements[i]
    if (!sourceRe.test(statement) || !/\bselect\b/.test(statement)) continue
    const projection = selectProjection(statement, source)
    if (!projection || !projectionProvides(projection, source, requiredColumns)) continue

    const ctas = statement.match(ctasRe)
    if (ctas) return { table: ctas[1], index: i }

    const insert = statement.match(insertRe)
    if (insert && tableCreatedBefore(statements, insert[1], i)) {
      return { table: insert[1], index: i }
    }
  }
  return null
}

function findRestore(statements, target, scratch, start) {
  const insertRe = new RegExp(
    `^insert\\s+into\\s+(?:main\\.)?${target}\\b(?:\\s*\\([^)]*\\))?\\s+select\\b`,
  )
  for (let i = start; i < statements.length; i++) {
    const statement = statements[i]
    if (!insertRe.test(statement)) continue
    // The first FROM after SELECT must be the captured scratch table. A
    // nested EXISTS that merely mentions scratch must not satisfy linkage.
    const directSource = statement.match(
      /\bselect\b[\s\S]*?\bfrom\s+(?:main\.)?([a-z_][a-z0-9_]*)\b/,
    )
    if (directSource?.[1] === scratch) return i
  }
  return -1
}

function migrationNumber(name) {
  const match = name.match(/^(\d+)_/)
  return match ? Number.parseInt(match[1], 10) : null
}

/** List every real migration file on disk, sorted by migration number. */
function findAllMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .map((name) => ({ name, number: migrationNumber(name) }))
    .toSorted((a, b) => a.number - b.number)
}

/** Split `text` on top-level occurrences of `sep`, ignoring ones nested inside parens. */
function splitTopLevel(text, sep) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === sep && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/** Return the text between the first `(` at/after `from` and its matching `)`. */
function extractParenBody(statement, from) {
  const start = statement.indexOf('(', from)
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < statement.length; i++) {
    if (statement[i] === '(') depth++
    else if (statement[i] === ')') {
      depth--
      if (depth === 0) return statement.slice(start + 1, i)
    }
  }
  return null
}

const TABLE_CONSTRAINT_RE = /^(constraint\b|primary\s+key\b|foreign\s+key\b|unique\s*\(|check\s*\()/

/** Parse a `CREATE TABLE (...)` body into its column names, skipping table-level constraints. */
function parseColumnList(body) {
  const columns = []
  for (const part of splitTopLevel(body, ',')) {
    const trimmed = part.trim()
    if (!trimmed || TABLE_CONSTRAINT_RE.test(trimmed)) continue
    const name = trimmed.match(/^([a-z_][a-z0-9_]*)/)?.[1]
    if (name) columns.push(name)
  }
  return columns
}

/** Replay one normalized statement's effect (if any) on the tracked table schemas. */
function applyStatementToSchema(schema, statement) {
  let match = statement.match(/^create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(/)
  if (match) {
    const body = extractParenBody(statement, match.index)
    if (body !== null) schema.set(match[1], parseColumnList(body))
    return
  }

  match = statement.match(
    /^alter\s+table\s+(?:main\s*\.\s*)?([a-z_][a-z0-9_]*)\s+add\s+(?:column\s+)?([a-z_][a-z0-9_]*)/,
  )
  if (match) {
    schema.get(match[1])?.push(match[2])
    return
  }

  match = statement.match(
    /^alter\s+table\s+(?:main\s*\.\s*)?([a-z_][a-z0-9_]*)\s+rename\s+to\s+([a-z_][a-z0-9_]*)/,
  )
  if (match) {
    const columns = schema.get(match[1])
    if (columns) schema.set(match[2], columns)
    schema.delete(match[1])
    return
  }

  match = statement.match(/^drop\s+table\s+(?:if\s+exists\s+)?(?:main\s*\.\s*)?([a-z_][a-z0-9_]*)/)
  if (match) schema.delete(match[1])
}

/**
 * Reconstruct every table's live column set as of just BEFORE `upToNumber`
 * runs, by replaying every earlier real migration file on disk in order
 * (CREATE TABLE / ALTER TABLE ADD COLUMN / ALTER TABLE RENAME TO / DROP TABLE).
 * This is what lets the required-column checks below stay correct across
 * schema changes with no hand-maintained list to go stale.
 */
function schemaAsOf(upToNumber) {
  const schema = new Map()
  for (const file of findAllMigrationFiles()) {
    if (file.number === null || file.number >= upToNumber) continue
    const statements = statementsFor(readFileSync(new URL(file.name, MIGRATIONS_DIR), 'utf8'))
    for (const statement of statements) applyStatementToSchema(schema, statement)
  }
  return schema
}

function validateAuthoritativeChildren(statements, dropIndex, renameIndex, schema, violations) {
  for (const table of ['page_aliases', 'block_drafts']) {
    const columns = schema.get(table)
    if (!columns || columns.length === 0) {
      violations.push(
        `${table}: could not derive its current columns from migration history — the schema ` +
          `tracker in check-migrations-rebuild-cascade.mjs is out of sync, fix it before trusting this guard`,
      )
      continue
    }
    const snapshot = findSnapshot(statements, table, dropIndex, columns)
    if (!snapshot) {
      violations.push(
        `${table}: take a scratch-table snapshot of (${columns.join(', ')}) before DROP TABLE blocks`,
      )
      continue
    }
    if (findRestore(statements, table, snapshot.table, renameIndex + 1) < 0) {
      violations.push(
        `${table}: restore the (${columns.join(', ')}) scratch snapshot after the replacement is renamed`,
      )
    }
  }
}

function validateSpacesIntroduction(statements, dropIndex, renameIndex, violations) {
  // String contents are intentionally scrubbed before analysis, so the
  // immutable 0089 predicate (`key = 'is_space'`) cannot be inspected here.
  // Pin the executable block-id snapshot and post-rename registry restore;
  // the exact 0088→0089 Rust regression pins the predicate and data result.
  const snapshot = findSnapshot(statements, 'block_properties', dropIndex, ['block_id'])
  if (!snapshot) {
    violations.push('spaces: snapshot the is_space registry source before the 0089 blocks DROP')
    return
  }
  const createSpaces = findStatement(statements, /^create\s+table\s+spaces\b/, 0, dropIndex)
  if (createSpaces < 0 || createSpaces <= snapshot.index) {
    violations.push('spaces: create the initial empty registry after its source snapshot')
  }
  const prematureRegistryWrite = findStatement(
    statements,
    /^(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into)\s+(?:main\.)?spaces\b/,
    Math.max(createSpaces + 1, 0),
    dropIndex,
  )
  if (prematureRegistryWrite >= 0) {
    violations.push('spaces: keep the initial registry empty until after the blocks rename')
  }
  if (findRestore(statements, 'spaces', snapshot.table, renameIndex + 1) < 0) {
    violations.push('spaces: populate the initial registry from its snapshot after the rename')
  }
}

function validateFutureSpacesRebuild(statements, dropIndex, renameIndex, schema, violations) {
  const registryColumns = schema.get('spaces')
  if (!registryColumns || registryColumns.length === 0) {
    violations.push(
      'spaces: could not derive its current columns from migration history — the schema ' +
        'tracker in check-migrations-rebuild-cascade.mjs is out of sync, fix it before trusting this guard',
    )
    return
  }

  const registry = findSnapshot(statements, 'spaces', dropIndex, registryColumns)
  const members = findSnapshot(statements, 'blocks', dropIndex, ['block_id', 'space_id'])
  if (!registry) {
    violations.push(
      `spaces: snapshot registry rows (${registryColumns.join(', ')}) into a scratch table before DROP`,
    )
  }
  if (
    !members ||
    selectProjection(statements[members.index], 'blocks') !== 'id as block_id, space_id' ||
    !/\bwhere\s+space_id\s+is\s+not\s+null\b/.test(statements[members.index])
  ) {
    violations.push('spaces: snapshot `id AS block_id, space_id` memberships before DROP')
    return
  }
  if (!registry || !members) return

  const deleteIndex = findStatement(statements, /^delete\s+from\s+(?:main\.)?spaces$/)
  if (
    deleteIndex < 0 ||
    deleteIndex <= registry.index ||
    deleteIndex <= members.index ||
    deleteIndex >= dropIndex
  ) {
    violations.push('spaces: DELETE the live registry after both snapshots and before DROP')
  }

  const restoreIndex = findRestore(statements, 'spaces', registry.table, renameIndex + 1)
  if (restoreIndex < 0) {
    violations.push('spaces: restore the registry scratch rows after the rename')
    return
  }

  const membershipRe = new RegExp(
    `^update\\s+(?:main\\.)?blocks\\s+set\\s+space_id\\s*=\\s*` +
      `\\(\\s*select\\s+space_id\\s+from\\s+(?:main\\.)?${members.table}\\s+` +
      `where\\s+block_id\\s*=\\s*blocks\\.id\\s*\\)\\s+where\\s+id\\s+in\\s*` +
      `\\(\\s*select\\s+block_id\\s+from\\s+(?:main\\.)?${members.table}\\s*\\)$`,
  )
  if (findStatement(statements, membershipRe, restoreIndex + 1) < 0) {
    violations.push('spaces: restore member space_id values after restoring the registry')
  }
}

function violationsFor(name, sql) {
  const violations = []
  const number = migrationNumber(name)
  if (number !== null && number < FIRST_GUARDED_MIGRATION) return violations

  const statements = statementsFor(sql)
  const dropIndex = findStatement(
    statements,
    /^drop\s+table\s+(?:if\s+exists\s+)?(?:(?:main)\s*\.\s*)?blocks\b/,
  )
  if (dropIndex < 0) return violations

  const renameIndex = findStatement(
    statements,
    /^alter\s+table\s+[a-z_][a-z0-9_]*\s+rename\s+to\s+blocks\b/,
    dropIndex + 1,
  )
  if (renameIndex < 0) {
    violations.push('rename the replacement table to blocks after DROP TABLE blocks')
    return violations
  }

  const schema = schemaAsOf(number ?? Number.POSITIVE_INFINITY)
  validateAuthoritativeChildren(statements, dropIndex, renameIndex, schema, violations)
  if (number === SPACES_INTRODUCTION_MIGRATION) {
    validateSpacesIntroduction(statements, dropIndex, renameIndex, violations)
  } else {
    validateFutureSpacesRebuild(statements, dropIndex, renameIndex, schema, violations)
  }
  return violations
}

function runSelfTest() {
  let failed = false
  const complete = `
    PRAGMA defer_foreign_keys = ON;
    CREATE TEMP TABLE keep_aliases AS SELECT * FROM page_aliases;
    CREATE TEMP TABLE keep_drafts AS SELECT * FROM block_drafts;
    CREATE TEMP TABLE keep_spaces AS SELECT id FROM spaces;
    CREATE TEMP TABLE keep_members AS
      SELECT id AS block_id, space_id FROM blocks WHERE space_id IS NOT NULL;
    DELETE FROM spaces;
    CREATE TABLE replacement (id TEXT);
    DROP TABLE main."blocks";
    ALTER TABLE replacement RENAME TO blocks;
    INSERT INTO spaces (id) SELECT id FROM keep_spaces;
    UPDATE blocks SET space_id = (
      SELECT space_id FROM keep_members WHERE block_id = blocks.id
    ) WHERE id IN (SELECT block_id FROM keep_members);
    INSERT INTO page_aliases SELECT * FROM keep_aliases;
    INSERT INTO block_drafts SELECT * FROM keep_drafts;
  `

  const expect = (label, sql, shouldPass, name = '0090_fixture.sql') => {
    const violations = violationsFor(name, sql)
    const passed = shouldPass ? violations.length === 0 : violations.length > 0
    if (passed) {
      console.log(`  ✓ ${label}`)
    } else {
      console.error(
        `  ✗ ${label}: expected ${shouldPass ? 'success' : 'failure'}, got ${violations.length} violation(s)`,
      )
      for (const violation of violations) console.error(`      ${violation}`)
      failed = true
    }
  }

  expect('complete ordered choreography passes', complete, true)
  expect(
    'names inside a string do not satisfy the guard',
    `SELECT '${complete.replaceAll("'", "''")}'; DROP TABLE blocks; ALTER TABLE n RENAME TO blocks;`,
    false,
  )
  expect(
    'an unrelated spaces SELECT is not a registry snapshot',
    complete.replace(
      'CREATE TEMP TABLE keep_spaces AS SELECT id FROM spaces;',
      'SELECT id FROM spaces;',
    ),
    false,
  )
  expect(
    'COUNT(*) is not a full registry snapshot',
    complete.replace('SELECT id FROM spaces;', 'SELECT COUNT(*) FROM spaces;'),
    false,
  )
  expect(
    'a membership projection without block_id fails',
    complete.replace('SELECT id AS block_id, space_id', 'SELECT space_id'),
    false,
  )
  expect(
    'SELECT * is not the aliased membership snapshot',
    complete.replace('SELECT id AS block_id, space_id', 'SELECT *'),
    false,
  )
  expect(
    'comment-only preservation SQL does not satisfy the guard',
    complete.replace(
      'CREATE TEMP TABLE keep_aliases AS SELECT * FROM page_aliases;',
      '-- CREATE TEMP TABLE keep_aliases AS SELECT * FROM page_aliases;',
    ),
    false,
  )
  expect(
    'missing alias restore fails',
    complete.replace('INSERT INTO page_aliases SELECT * FROM keep_aliases;', ''),
    false,
  )
  expect(
    'missing registry restore fails',
    complete.replace('INSERT INTO spaces (id) SELECT id FROM keep_spaces;', ''),
    false,
  )
  expect(
    'a nested scratch mention is not a linked registry restore',
    complete.replace(
      'INSERT INTO spaces (id) SELECT id FROM keep_spaces;',
      'INSERT INTO spaces (id) SELECT id FROM blocks WHERE EXISTS (SELECT 1 FROM keep_spaces);',
    ),
    false,
  )
  expect(
    'missing membership restore fails',
    complete.replace(/UPDATE blocks SET[\s\S]*?\);/, ''),
    false,
  )
  expect(
    'registry DELETE after DROP fails',
    complete
      .replace('DELETE FROM spaces;', '')
      .replace('DROP TABLE main."blocks";', 'DROP TABLE main."blocks"; DELETE FROM spaces;'),
    false,
  )
  expect(
    'a conditional registry DELETE does not prove it was emptied',
    complete.replace('DELETE FROM spaces;', "DELETE FROM spaces WHERE id = 'never';"),
    false,
  )
  expect(
    'registry restore before rename fails',
    complete
      .replace('INSERT INTO spaces (id) SELECT id FROM keep_spaces;', '')
      .replace(
        'ALTER TABLE replacement RENAME TO blocks;',
        'INSERT INTO spaces (id) SELECT id FROM keep_spaces; ALTER TABLE replacement RENAME TO blocks;',
      ),
    false,
  )
  expect(
    'membership restore before registry restore fails',
    complete.replace(
      `INSERT INTO spaces (id) SELECT id FROM keep_spaces;
    UPDATE blocks SET space_id = (
      SELECT space_id FROM keep_members WHERE block_id = blocks.id
    ) WHERE id IN (SELECT block_id FROM keep_members);`,
      `UPDATE blocks SET space_id = (
      SELECT space_id FROM keep_members WHERE block_id = blocks.id
    ) WHERE id IN (SELECT block_id FROM keep_members);
    INSERT INTO spaces (id) SELECT id FROM keep_spaces;`,
    ),
    false,
  )
  expect(
    'an unrelated UPDATE does not restore memberships',
    complete.replace(
      `UPDATE blocks SET space_id = (
      SELECT space_id FROM keep_members WHERE block_id = blocks.id
    ) WHERE id IN (SELECT block_id FROM keep_members);`,
      'UPDATE blocks SET content = (SELECT block_id FROM keep_members) WHERE space_id IS NULL;',
    ),
    false,
  )
  expect(
    'an uncorrelated UPDATE does not restore exact memberships',
    complete.replace(
      `UPDATE blocks SET space_id = (
      SELECT space_id FROM keep_members WHERE block_id = blocks.id
    ) WHERE id IN (SELECT block_id FROM keep_members);`,
      `UPDATE blocks SET space_id = (SELECT space_id FROM keep_members)
       WHERE id IN (SELECT block_id FROM keep_members);`,
    ),
    false,
  )

  const introduction = `
    CREATE TABLE keep_aliases (page_id TEXT, alias TEXT);
    INSERT INTO keep_aliases SELECT page_id, alias FROM page_aliases;
    CREATE TABLE keep_drafts (block_id TEXT, content TEXT, updated_at INTEGER);
    INSERT INTO keep_drafts SELECT block_id, content, updated_at FROM block_drafts;
    CREATE TABLE spaces_backfill (id TEXT);
    INSERT INTO spaces_backfill SELECT block_id FROM block_properties WHERE key = 'is_space';
    CREATE TABLE spaces (id TEXT);
    DROP TABLE blocks;
    ALTER TABLE replacement RENAME TO blocks;
    INSERT INTO spaces SELECT id FROM spaces_backfill;
    INSERT INTO page_aliases SELECT * FROM keep_aliases;
    INSERT INTO block_drafts SELECT * FROM keep_drafts;
  `
  expect(
    '0089 specialized empty-registry introduction passes',
    introduction,
    true,
    '0089_fixture.sql',
  )
  expect(
    '0089 registry population before DROP fails',
    introduction.replace(
      'DROP TABLE blocks;',
      'INSERT INTO spaces SELECT id FROM spaces_backfill; DROP TABLE blocks;',
    ),
    false,
    '0089_fixture.sql',
  )
  expect('pre-0089 rebuild remains grandfathered', 'DROP TABLE blocks;', true, '0088_fixture.sql')
  expect('migration without a blocks drop is ignored', 'SELECT * FROM spaces;', true)

  // #3271 regression: the required-column lists used to be hardcoded and
  // went stale the moment 0092 added `block_drafts.draft_anchor_seq` /
  // `draft_anchor_device` — a rebuild whose snapshot only carried the pre-
  // 0092 columns would have passed silently, discarding both columns for
  // every drafted row. Columns are now derived from migration history
  // (`schemaAsOf`), so this must fail on any migration numbered after 0092.
  const staleDraftColumns = complete
    .replace(
      'CREATE TEMP TABLE keep_drafts AS SELECT * FROM block_drafts;',
      'CREATE TEMP TABLE keep_drafts AS SELECT block_id, content, updated_at FROM block_drafts;',
    )
    .replace(
      'INSERT INTO block_drafts SELECT * FROM keep_drafts;',
      'INSERT INTO block_drafts (block_id, content, updated_at) ' +
        'SELECT block_id, content, updated_at FROM keep_drafts;',
    )
  expect(
    'block_drafts snapshot missing draft_anchor_seq/draft_anchor_device fails (#3271)',
    staleDraftColumns,
    false,
    '0107_fixture.sql',
  )
  expect(
    'block_drafts SELECT * still satisfies a post-0092 required-column set',
    complete,
    true,
    '0107_fixture.sql',
  )

  if (failed) process.exit(1)
  console.log('self-test: all assertions passed')
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  let failed = false
  for (const file of process.argv.slice(2)) {
    const violations = violationsFor(basename(file), readFileSync(file, 'utf8'))
    for (const violation of violations) {
      console.error(
        `ERROR: ${file}: ${violation}. Follow src-tauri/migrations/AGENTS.md §Table-rebuild (#606).`,
      )
      failed = true
    }
  }
  process.exit(failed ? 1 : 0)
}
