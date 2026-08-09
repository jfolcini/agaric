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
// #3438 closed four holes the #3271 round left in the static arm:
//   1. Naming a column is not preserving it. Both arms keyed purely on the
//      OUTPUT name, so `NULL AS draft_anchor_seq` in a snapshot, and a bare
//      `NULL` positionally paired with a named column in a restore, satisfied
//      the guard while writing exactly the defaults #3271 is about. The
//      expression bound to each required column must now carry a value.
//   2. `applyStatementToSchema` ignored `ALTER TABLE … RENAME COLUMN` and
//      `… DROP COLUMN`, so the derived set could require a column that no
//      longer exists — the same staleness class the derivation eliminated.
//   3. The membership projection was an exact string compare against one
//      spelling; it is now checked as a BINDING (block_id ← blocks.id,
//      space_id ← blocks.space_id) in any order or qualification.
//   4. The first covering snapshot was latched, so a `SELECT * FROM blocks`
//      bulk copy placed before the membership snapshot shadowed it.
// The self-test additionally cross-checks the three copies of the recipe (the
// migrations/AGENTS.md block, the Rust test's `format!` literal, this file's
// `complete` fixture) — see `documentedRecipe`/`executableRecipePin`.
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
const MIGRATIONS_AGENTS_MD = new URL('../src-tauri/migrations/AGENTS.md', import.meta.url)
const DB_TESTS_RS = new URL('../src-tauri/src/db/tests.rs', import.meta.url)

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

/**
 * KNOWN LIMITATION: this splits on every `;`, so it mis-splits compound
 * bodies — most notably `CREATE TRIGGER ... BEGIN <stmt>; <stmt>; END;`,
 * which arrives as several fragments rather than one statement (AGENTS.md
 * requires triggers to be re-created on a `block_properties` rebuild, so such
 * bodies do occur in guarded files). Every consequence is fail-closed: a
 * fragment can only ADD statements the checks below might reject, never
 * satisfy a snapshot/restore requirement that the real DDL does not — a
 * trigger-body `INSERT INTO spaces` fragment, for example, trips the
 * premature-registry-write check rather than silencing it. A real SQL parser
 * would be the fix if that ever becomes too noisy.
 */
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

/**
 * Split a SELECT projection into `{ source, output }` pairs: the expression
 * that produces the value, and the column name it lands under.
 *
 * Splitting is paren-aware, so `coalesce(a, b) AS x` is one binding rather
 * than two (the old `,`-split miscounted it and could read `b) as x` as an
 * output named `x` with source `b)`).
 */
function projectionBindings(projection) {
  return splitTopLevel(projection, ',').map((expression) => {
    const trimmed = expression.trim()
    const aliased = trimmed.match(/^([\s\S]*?)\s+as\s+([a-z_][a-z0-9_]*)$/)
    const source = (aliased ? aliased[1] : trimmed).trim()
    return { source, output: aliased ? aliased[2] : source.split('.').at(-1) }
  })
}

/**
 * A literal that reproduces a column's default instead of carrying its stored
 * value. `stripSqlNoise` blanks string-literal contents, so a scrubbed `''`
 * arrives as the empty string — that is the tell, not a parse failure.
 *
 * KNOWN LIMITATION: only bare literals are recognised. `CAST(NULL AS INTEGER)`
 * or a scalar subquery returning NULL would still read as value-bearing. Both
 * are far more contrived than the plain `NULL` a hand-written rebuild actually
 * produces, and the runtime `*_606` harness (which seeds non-default anchors
 * `4242`/`'DEV606ANCHOR'`) reddens on any of them.
 */
const CONSTANT_EXPRESSION_RE = /^(?:null|default|true|false|-?\d+(?:\.\d+)?(?:e-?\d+)?)$/

function isValueBearingSource(source) {
  let expression = source.trim()
  while (expression.startsWith('(') && expression.endsWith(')')) {
    const inner = extractParenBody(expression, 0)
    if (inner === null || `(${inner})` !== expression) break
    expression = inner.trim()
  }
  return expression !== '' && !CONSTANT_EXPRESSION_RE.test(expression)
}

function projectionProvides(projection, source, requiredColumns) {
  if (projection === '*' || projection === `${source}.*`) return true
  const provided = new Set(
    projectionBindings(projection)
      // `NULL AS draft_anchor_seq` names the column and destroys it (#3438).
      .filter((binding) => isValueBearingSource(binding.source))
      .map((binding) => binding.output),
  )
  return requiredColumns.every((column) => provided.has(column))
}

/**
 * Every scratch-table snapshot of `source` that carries `requiredColumns`, in
 * statement order.
 *
 * Yielding all of them rather than latching the first (#3438) matters because
 * a rebuild may legitimately contain more than one covering SELECT from the
 * same table: `INSERT INTO _new_blocks SELECT * FROM blocks` placed before the
 * membership snapshot used to latch `_new_blocks` as the membership scratch
 * table and then fail the projection check, even with a correct
 * `_keep_block_spaces` snapshot later in the file. Callers with a shape
 * requirement beyond the column set filter the candidates themselves.
 */
function* snapshotCandidates(statements, source, before, requiredColumns) {
  const sourceRe = new RegExp(`\\bfrom\\s+(?:main\\.)?${source}\\b`)
  const insertRe = /^insert\s+into\s+([a-z_][a-z0-9_]*)\b/
  const ctasRe = /^create\s+(?:(?:temp|temporary)\s+)?table\s+([a-z_][a-z0-9_]*)\s+as\s+select\b/

  for (let i = 0; i < before; i++) {
    const statement = statements[i]
    if (!sourceRe.test(statement) || !/\bselect\b/.test(statement)) continue
    const projection = selectProjection(statement, source)
    if (!projection || !projectionProvides(projection, source, requiredColumns)) continue

    const ctas = statement.match(ctasRe)
    if (ctas) {
      yield { table: ctas[1], index: i }
      continue
    }

    const insert = statement.match(insertRe)
    if (insert && tableCreatedBefore(statements, insert[1], i)) {
      yield { table: insert[1], index: i }
    }
  }
}

function findSnapshot(statements, source, before, requiredColumns) {
  for (const candidate of snapshotCandidates(statements, source, before, requiredColumns)) {
    return candidate
  }
  return null
}

/**
 * Does an `INSERT INTO target ... SELECT ... FROM scratch` restore actually
 * write every required column?
 *
 * An explicit column list is authoritative: anything it omits is silently
 * defaulted/NULLed even when the scratch snapshot still holds the value. That
 * is the #3271 loss class on the restore side — a `SELECT *` snapshot paired
 * with `INSERT INTO block_drafts (block_id, content, updated_at)` destroys
 * `draft_anchor_seq`/`draft_anchor_device` just as thoroughly as a truncated
 * snapshot would, so the derived column set has to be enforced on BOTH arms.
 *
 * Without a column list the INSERT is positional over the target's full
 * column set, so the SELECT projection itself must carry the columns.
 *
 * #3438: naming the column in the list is necessary but not sufficient. The
 * INSERT list pairs POSITIONALLY with the SELECT projection, so
 * `INSERT INTO block_drafts (block_id, content, updated_at, draft_anchor_seq,
 * draft_anchor_device) SELECT block_id, content, updated_at, NULL, NULL FROM
 * _keep_block_drafts` names every required column and still writes the two
 * defaults for every row. The paired expression must carry a value.
 */
function restoreProvides(statement, target, scratch, requiredColumns) {
  const columnList = statement.match(
    new RegExp(`^insert\\s+into\\s+(?:main\\.)?${target}\\b\\s*\\(([^)]*)\\)\\s*select\\b`),
  )
  if (columnList) {
    const named = splitTopLevel(columnList[1], ',').map((column) => column.trim())
    if (!requiredColumns.every((column) => named.includes(column))) return false
    const projection = selectProjection(statement, scratch)
    if (projection === null) return false
    if (projection === '*' || projection === `${scratch}.*`) return true
    const bindings = projectionBindings(projection)
    // A length mismatch is not valid SQL for a column-listed INSERT; treat an
    // unparseable pairing as unproven rather than guessing at it.
    if (bindings.length !== named.length) return false
    return requiredColumns.every((column) =>
      isValueBearingSource(bindings[named.indexOf(column)].source),
    )
  }
  const projection = selectProjection(statement, scratch)
  return projection !== null && projectionProvides(projection, scratch, requiredColumns)
}

function findRestore(statements, target, scratch, start, requiredColumns) {
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
    if (directSource?.[1] !== scratch) continue
    if (!restoreProvides(statement, target, scratch, requiredColumns)) continue
    return i
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

  // Must follow the `RENAME TO` arm: only a statement that is not a table
  // rename can be a column rename. #3438 — an unhandled `RENAME COLUMN` left
  // the derived set naming a column that no longer exists, so the next
  // rebuild's snapshot could not possibly satisfy it. Fail-closed, but it is
  // the same staleness class `schemaAsOf` was introduced to eliminate.
  match = statement.match(
    /^alter\s+table\s+(?:main\s*\.\s*)?([a-z_][a-z0-9_]*)\s+rename\s+(?:column\s+)?([a-z_][a-z0-9_]*)\s+to\s+([a-z_][a-z0-9_]*)/,
  )
  if (match) {
    const columns = schema.get(match[1])
    const at = columns?.indexOf(match[2]) ?? -1
    if (at >= 0) columns[at] = match[3]
    return
  }

  // `ALTER TABLE … DROP COLUMN` (SQLite 3.35+). Unhandled, it left the dropped
  // column in the derived required set forever (#3438).
  match = statement.match(
    /^alter\s+table\s+(?:main\s*\.\s*)?([a-z_][a-z0-9_]*)\s+drop\s+(?:column\s+)?([a-z_][a-z0-9_]*)/,
  )
  if (match) {
    const columns = schema.get(match[1])
    const at = columns?.indexOf(match[2]) ?? -1
    if (at >= 0) columns.splice(at, 1)
    return
  }

  match = statement.match(/^drop\s+table\s+(?:if\s+exists\s+)?(?:main\s*\.\s*)?([a-z_][a-z0-9_]*)/)
  if (match) schema.delete(match[1])
}

/**
 * Reconstruct every table's live column set as of just BEFORE `upToNumber`
 * runs, by replaying every earlier real migration file on disk in order
 * (CREATE TABLE / ALTER TABLE ADD COLUMN / ALTER TABLE RENAME COLUMN /
 * ALTER TABLE DROP COLUMN / ALTER TABLE RENAME TO / DROP TABLE).
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
    if (findRestore(statements, table, snapshot.table, renameIndex + 1, columns) < 0) {
      violations.push(
        `${table}: restore all of (${columns.join(', ')}) from the scratch snapshot after the ` +
          `replacement is renamed — a restore whose column list or projection omits any of ` +
          `them discards that column for every row`,
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
  // The registry `spaces` is created by THIS migration with the single
  // column `id`, so that is its full required set at the introduction
  // boundary (`schemaAsOf` cannot supply it — the table does not yet exist
  // at 0089's input boundary).
  if (findRestore(statements, 'spaces', snapshot.table, renameIndex + 1, ['id']) < 0) {
    violations.push('spaces: populate the initial registry from its snapshot after the rename')
  }
}

/**
 * The membership scratch table must bind `block_id` to the block's own id and
 * `space_id` to its assignment, and must skip non-members.
 *
 * #3438: this used to be an exact string compare against
 * `'id as block_id, space_id'`, so `blocks.id AS block_id`,
 * `space_id AS space_id`, or a reordering were all rejected — one hardcoded
 * spelling of a recipe that is otherwise derived. The requirement is the
 * BINDING, not the spelling: whatever the order or qualification, the restore
 * `UPDATE` reads `block_id`/`space_id` out of this table, so those two outputs
 * have to come from those two source columns. Extra projected columns are
 * harmless and allowed.
 */
const MEMBERSHIP_BINDINGS = [
  { output: 'block_id', sources: ['id', 'blocks.id'] },
  { output: 'space_id', sources: ['space_id', 'blocks.space_id'] },
]

function isMembershipSnapshot(statement) {
  const projection = selectProjection(statement, 'blocks')
  // `SELECT *` provides both names but proves no `id → block_id` binding.
  if (projection === null || projection === '*' || projection === 'blocks.*') return false
  const bindings = projectionBindings(projection)
  const bound = MEMBERSHIP_BINDINGS.every(({ output, sources }) =>
    bindings.some((binding) => binding.output === output && sources.includes(binding.source)),
  )
  return bound && /\bwhere\s+space_id\s+is\s+not\s+null\b/.test(statement)
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
  // Scan every covering candidate, not just the first: a `SELECT * FROM blocks`
  // bulk copy into the replacement table also "provides" both names (#3438).
  let members = null
  for (const candidate of snapshotCandidates(statements, 'blocks', dropIndex, [
    'block_id',
    'space_id',
  ])) {
    if (isMembershipSnapshot(statements[candidate.index])) {
      members = candidate
      break
    }
  }
  if (!registry) {
    violations.push(
      `spaces: snapshot registry rows (${registryColumns.join(', ')}) into a scratch table before DROP`,
    )
  }
  if (!members) {
    violations.push(
      'spaces: snapshot memberships as `id AS block_id, space_id` ' +
        '(WHERE space_id IS NOT NULL) into a scratch table before DROP',
    )
    return
  }
  if (!registry) return

  const deleteIndex = findStatement(statements, /^delete\s+from\s+(?:main\.)?spaces$/)
  if (
    deleteIndex < 0 ||
    deleteIndex <= registry.index ||
    deleteIndex <= members.index ||
    deleteIndex >= dropIndex
  ) {
    violations.push('spaces: DELETE the live registry after both snapshots and before DROP')
  } else if (
    // Emptying the registry is only half the requirement: it has to STAY
    // empty until the replacement table is in place. Re-populating it before
    // `DROP TABLE blocks` restores the blocks → spaces CASCADE edge, so the
    // DROP fires spaces → `blocks.space_id` SET NULL all over again. This
    // mirrors the same premature-write rejection `validateSpacesIntroduction`
    // applies to the one-time 0089 path.
    findStatement(
      statements,
      /^(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into)\s+(?:main\.)?spaces\b/,
      deleteIndex + 1,
      dropIndex,
    ) >= 0
  ) {
    // The DROP is the load-bearing boundary this check actually ends at: a
    // registry write after it cannot restore the blocks → spaces CASCADE edge
    // in time to matter. Earlier wording said "until after the blocks rename",
    // which described a wider window than the check enforces (#3438).
    violations.push('spaces: keep the registry empty from its DELETE until the blocks DROP')
  }

  const restoreIndex = findRestore(
    statements,
    'spaces',
    registry.table,
    renameIndex + 1,
    registryColumns,
  )
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

/**
 * The `sql` fenced block in migrations/AGENTS.md that IS the copy-paste
 * rebuild recipe (the one containing the blocks DROP). #3438: the recipe lives
 * in three places — this block, the `recipe` format string in the Rust test
 * `agents_md_table_rebuild_recipe_preserves_authoritative_state_606`, and the
 * self-test's `complete` fixture — with nothing cross-checking them, and the
 * documented block was never itself run through this guard.
 *
 * Throwing (rather than returning null) is the point: if the block moves or is
 * duplicated, the self-test hook fails loudly instead of quietly cross-checking
 * nothing.
 */
function documentedRecipe() {
  const markdown = readFileSync(MIGRATIONS_AGENTS_MD, 'utf8')
  const blocks = [...markdown.matchAll(/```sql\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block) => /^\s*DROP TABLE blocks;/m.test(block))
  if (blocks.length !== 1) {
    throw new Error(
      `expected exactly one \`\`\`sql block containing \`DROP TABLE blocks;\` in ` +
        `src-tauri/migrations/AGENTS.md, found ${blocks.length} — the guard can no longer ` +
        `cross-check the documented recipe`,
    )
  }
  return blocks[0]
}

/** Placeholder for the Rust pin's schema-derived `_new_blocks` DDL. */
const NEW_BLOCKS_DDL_STUB = 'CREATE TABLE _new_blocks (id TEXT, space_id TEXT)'

/**
 * A fixture name numbered one past head, so the documented recipe is checked
 * as what it claims to be: the NEXT blocks rebuild, against the head schema.
 */
function nextRebuildFixtureName() {
  const highest = findAllMigrationFiles().at(-1)?.number ?? FIRST_GUARDED_MIGRATION
  return `${String(highest + 1).padStart(4, '0')}_synthetic_rebuild.sql`
}

/**
 * The SQL the Rust harness actually EXECUTES against the head schema, lifted
 * out of the `let recipe = format!("…");` literal in db/tests.rs. The one
 * interpolation (`{create_new_blocks}`, built at runtime from `sqlite_schema`)
 * is replaced by a stub: its exact DDL is the test's business, its presence is
 * this cross-check's.
 */
function executableRecipePin() {
  const source = readFileSync(DB_TESTS_RS, 'utf8')
  const literal = source.match(/let recipe = format!\(\s*"([\s\S]*?)"\s*\);/)
  if (!literal) {
    throw new Error(
      'could not find the `let recipe = format!("…");` literal in src-tauri/src/db/tests.rs — ' +
        'the guard can no longer cross-check the executable recipe pin against AGENTS.md',
    )
  }
  return (
    literal[1]
      // Rust line continuations: `\n\` + newline + indentation.
      .replace(/\\n\\\s*/g, '\n')
      .replaceAll('\\n', '\n')
      .replace('{create_new_blocks}', NEW_BLOCKS_DDL_STUB)
  )
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

  /**
   * A negative fixture that also pins WHICH check rejected it. A fixture that
   * reddens for an unrelated reason (a typo'd substitution that never applied,
   * a violation from a different table) proves nothing about the hole it
   * claims to cover, and would keep passing after the hole reopened.
   */
  const expectRejectedFor = (label, sql, mustMention, name = '0090_fixture.sql') => {
    const violations = violationsFor(name, sql)
    if (violations.some((violation) => violation.includes(mustMention))) {
      console.log(`  ✓ ${label}`)
    } else {
      console.error(`  ✗ ${label}: no violation mentioning ${JSON.stringify(mustMention)}`)
      for (const violation of violations) console.error(`      ${violation}`)
      if (violations.length === 0) console.error('      (no violations at all)')
      failed = true
    }
  }

  /** Assert something that throws on failure (used by the recipe cross-checks). */
  const check = (label, assertion) => {
    try {
      assertion()
      console.log(`  ✓ ${label}`)
    } catch (error) {
      console.error(`  ✗ ${label}: ${error.message}`)
      failed = true
    }
  }

  /**
   * Replay DDL through the schema tracker and pin one table's derived columns.
   * `columns === null` asserts the table is absent from the derived schema.
   */
  const expectDerivedColumns = (label, ddl, table, columns) => {
    const schema = new Map()
    for (const statement of statementsFor(ddl)) applyStatementToSchema(schema, statement)
    const actual = schema.get(table)
    const rendered = actual ? `[${actual.join(', ')}]` : 'absent'
    if (rendered === (columns === null ? 'absent' : `[${columns.join(', ')}]`)) {
      console.log(`  ✓ ${label}`)
    } else {
      const wanted = columns === null ? 'absent' : `[${columns.join(', ')}]`
      console.error(`  ✗ ${label}: expected ${table} = ${wanted}, got ${rendered}`)
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
  // The fixture above mutates BOTH arms, so it always trips the snapshot
  // check first and proves nothing about the restore. This one truncates
  // ONLY the restore: a full `SELECT *` snapshot faithfully captures the
  // anchor columns, and then the restore's explicit column list throws them
  // away — the exact #3271 loss class, previously invisible to the guard
  // because `findRestore` only matched the INSERT/SELECT/FROM shape.
  expect(
    'a full snapshot with a column-dropping block_drafts restore fails (#3271)',
    complete.replace(
      'INSERT INTO block_drafts SELECT * FROM keep_drafts;',
      'INSERT INTO block_drafts (block_id, content, updated_at) ' +
        'SELECT block_id, content, updated_at FROM keep_drafts;',
    ),
    false,
    '0107_fixture.sql',
  )
  expect(
    'a full snapshot with a column-dropping page_aliases restore fails (#3271)',
    complete.replace(
      'INSERT INTO page_aliases SELECT * FROM keep_aliases;',
      'INSERT INTO page_aliases (page_id) SELECT page_id FROM keep_aliases;',
    ),
    false,
    '0107_fixture.sql',
  )
  expect(
    'a listless restore whose projection drops columns fails (#3271)',
    complete.replace(
      'INSERT INTO block_drafts SELECT * FROM keep_drafts;',
      'INSERT INTO block_drafts SELECT block_id, content, updated_at FROM keep_drafts;',
    ),
    false,
    '0107_fixture.sql',
  )
  expect(
    'an explicit full-column restore list satisfies the derived set',
    complete.replace(
      'INSERT INTO block_drafts SELECT * FROM keep_drafts;',
      'INSERT INTO block_drafts ' +
        '(block_id, content, updated_at, draft_anchor_seq, draft_anchor_device) ' +
        'SELECT block_id, content, updated_at, draft_anchor_seq, draft_anchor_device ' +
        'FROM keep_drafts;',
    ),
    true,
    '0107_fixture.sql',
  )
  expect(
    're-populating the registry before DROP fails on a future rebuild',
    complete.replace(
      'DELETE FROM spaces;',
      'DELETE FROM spaces; INSERT INTO spaces (id) SELECT id FROM keep_spaces;',
    ),
    false,
  )

  // ── #3438 defect 1: the NULL-projection hole ──────────────────────────
  // Both arms keyed purely on the OUTPUT column name, so a projection could
  // name every required column and carry none of their values. These write
  // exactly the defaults (`draft_anchor_seq` 0, `draft_anchor_device` NULL)
  // that #3271 exists to stop, and both were GREEN before this change.
  expectRejectedFor(
    'NULL AS <col> is not a snapshot of that column (#3438)',
    complete.replace(
      'CREATE TEMP TABLE keep_drafts AS SELECT * FROM block_drafts;',
      'CREATE TEMP TABLE keep_drafts AS SELECT block_id, content, updated_at, ' +
        'NULL AS draft_anchor_seq, NULL AS draft_anchor_device FROM block_drafts;',
    ),
    'block_drafts: take a scratch-table snapshot',
    '0107_fixture.sql',
  )
  expectRejectedFor(
    'a restore naming every column but selecting NULL for two fails (#3438)',
    complete.replace(
      'INSERT INTO block_drafts SELECT * FROM keep_drafts;',
      'INSERT INTO block_drafts ' +
        '(block_id, content, updated_at, draft_anchor_seq, draft_anchor_device) ' +
        'SELECT block_id, content, updated_at, NULL, NULL FROM keep_drafts;',
    ),
    'block_drafts: restore all of',
    '0107_fixture.sql',
  )
  expectRejectedFor(
    'a literal, not just NULL, fails the value-bearing check (#3438)',
    complete.replace(
      'INSERT INTO page_aliases SELECT * FROM keep_aliases;',
      "INSERT INTO page_aliases (page_id, alias) SELECT page_id, '' FROM keep_aliases;",
    ),
    'page_aliases: restore all of',
    '0107_fixture.sql',
  )
  expectRejectedFor(
    'a zero literal for a numeric anchor fails too (#3438)',
    complete.replace(
      'INSERT INTO block_drafts SELECT * FROM keep_drafts;',
      'INSERT INTO block_drafts ' +
        '(block_id, content, updated_at, draft_anchor_seq, draft_anchor_device) ' +
        'SELECT block_id, content, updated_at, 0, draft_anchor_device FROM keep_drafts;',
    ),
    'block_drafts: restore all of',
    '0107_fixture.sql',
  )
  // Positive controls: the value-bearing rule must not reject real projections.
  expect(
    'a table-qualified, reordered restore projection still satisfies the set',
    complete.replace(
      'INSERT INTO block_drafts SELECT * FROM keep_drafts;',
      'INSERT INTO block_drafts ' +
        '(draft_anchor_device, draft_anchor_seq, updated_at, content, block_id) ' +
        'SELECT keep_drafts.draft_anchor_device, keep_drafts.draft_anchor_seq, ' +
        'keep_drafts.updated_at, keep_drafts.content, keep_drafts.block_id FROM keep_drafts;',
    ),
    true,
    '0107_fixture.sql',
  )
  expect(
    'a COALESCE over the real column is still value-bearing',
    complete.replace(
      'CREATE TEMP TABLE keep_drafts AS SELECT * FROM block_drafts;',
      'CREATE TEMP TABLE keep_drafts AS SELECT block_id, content, updated_at, ' +
        'COALESCE(draft_anchor_seq, 0) AS draft_anchor_seq, draft_anchor_device FROM block_drafts;',
    ),
    true,
    '0107_fixture.sql',
  )

  // ── #3438 defect 2: RENAME COLUMN / DROP COLUMN in the schema tracker ──
  // `schemaAsOf` replays real migration files, so these are exercised against
  // the tracker directly. Before this change both statements were no-ops: a
  // renamed column stayed in the derived required set under its OLD name and a
  // dropped one stayed forever, so the next rebuild could not satisfy either.
  expectDerivedColumns(
    'ALTER TABLE … RENAME COLUMN updates the derived set (#3438)',
    'CREATE TABLE t (a TEXT, b TEXT); ALTER TABLE t RENAME COLUMN a TO c;',
    't',
    ['c', 'b'],
  )
  expectDerivedColumns(
    'ALTER TABLE … RENAME <col> TO <col> (no COLUMN keyword) too (#3438)',
    'CREATE TABLE t (a TEXT, b TEXT); ALTER TABLE main.t RENAME a TO c;',
    't',
    ['c', 'b'],
  )
  expectDerivedColumns(
    'ALTER TABLE … DROP COLUMN removes it from the derived set (#3438)',
    'CREATE TABLE t (a TEXT, b TEXT, c TEXT); ALTER TABLE t DROP COLUMN b;',
    't',
    ['a', 'c'],
  )
  expectDerivedColumns(
    'ALTER TABLE … DROP <col> (no COLUMN keyword) too (#3438)',
    'CREATE TABLE t (a TEXT, b TEXT); ALTER TABLE t DROP b;',
    't',
    ['a'],
  )
  // The new column arms must not swallow a TABLE rename.
  expectDerivedColumns(
    'ALTER TABLE … RENAME TO is still a table rename',
    'CREATE TABLE t (a TEXT, b TEXT); ALTER TABLE t RENAME TO u;',
    'u',
    ['a', 'b'],
  )
  expectDerivedColumns(
    'the renamed-away table name is gone',
    'CREATE TABLE t (a TEXT, b TEXT); ALTER TABLE t RENAME TO u;',
    't',
    null,
  )
  expectDerivedColumns(
    'ADD COLUMN still appends',
    'CREATE TABLE t (a TEXT); ALTER TABLE t ADD COLUMN b TEXT;',
    't',
    ['a', 'b'],
  )

  // ── #3438 defect 3: the membership recipe was one hardcoded spelling ───
  // The projection was compared as an exact string, so every one of these
  // equivalent, correct snapshots was REJECTED before this change.
  expect(
    'a reordered membership projection is accepted (#3438)',
    complete.replace('SELECT id AS block_id, space_id', 'SELECT space_id, id AS block_id'),
    true,
  )
  expect(
    'a qualified and self-aliased membership projection is accepted (#3438)',
    complete.replace(
      'SELECT id AS block_id, space_id',
      'SELECT blocks.id AS block_id, blocks.space_id AS space_id',
    ),
    true,
  )
  // …but the BINDING is still load-bearing: the outputs have to come from the
  // block id and its assignment, not from whatever else is lying around.
  expectRejectedFor(
    'a membership projection bound to the wrong source column fails',
    complete.replace(
      'SELECT id AS block_id, space_id',
      'SELECT id AS block_id, page_id AS space_id',
    ),
    'spaces: snapshot memberships',
  )
  expectRejectedFor(
    'a membership snapshot without the non-NULL filter fails',
    complete.replace(
      'SELECT id AS block_id, space_id FROM blocks WHERE space_id IS NOT NULL;',
      'SELECT id AS block_id, space_id FROM blocks;',
    ),
    'spaces: snapshot memberships',
  )

  // ── #3438 defect 4: the first covering snapshot was latched ────────────
  // `INSERT INTO _new_blocks SELECT * FROM blocks` also "provides"
  // block_id/space_id. Placed before the membership snapshot it used to be
  // latched as the membership scratch table, and the correct
  // `keep_members` snapshot later in the file could never be reached.
  const membershipSnapshot = `CREATE TEMP TABLE keep_members AS
      SELECT id AS block_id, space_id FROM blocks WHERE space_id IS NOT NULL;`
  const bulkCopyFirst = complete.replace(
    membershipSnapshot,
    `CREATE TABLE _new_blocks (id TEXT, space_id TEXT);
    INSERT INTO _new_blocks SELECT * FROM blocks;
    ${membershipSnapshot}`,
  )
  check('the bulk-copy fixture substitution actually applied', () => {
    if (bulkCopyFirst === complete) throw new Error('`complete` drifted; the replace was a no-op')
  })
  expect(
    'an earlier bulk blocks copy does not shadow the membership snapshot (#3438)',
    bulkCopyFirst,
    true,
  )
  expectRejectedFor(
    'a bulk blocks copy is not itself a membership snapshot',
    bulkCopyFirst.replace(membershipSnapshot, ''),
    'spaces: snapshot memberships',
  )

  // ── #3438 defect 5: the recipe existed in three uncross-checked copies ──
  // migrations/AGENTS.md's block, the `recipe` format string in the Rust test
  // `agents_md_table_rebuild_recipe_preserves_authoritative_state_606`, and
  // this file's `complete` fixture. `complete` deliberately uses different
  // scratch-table names (to prove the guard is not name-keyed) so it is not
  // compared textually; the other two are the same SQL and now must agree,
  // and the documented one must satisfy the guard that polices it.
  const fixtureName = nextRebuildFixtureName()
  check(`the documented AGENTS.md recipe passes this guard as ${fixtureName} (#3438)`, () => {
    const violations = violationsFor(fixtureName, documentedRecipe())
    if (violations.length > 0) {
      throw new Error(`the documented recipe violates its own guard: ${violations.join('; ')}`)
    }
  })
  check('…and that cross-check is not vacuous', () => {
    const recipe = documentedRecipe()
    const gutted = recipe.replace('INSERT INTO block_drafts SELECT * FROM _keep_block_drafts;', '')
    if (gutted === recipe) {
      throw new Error('the drafts restore is no longer in the documented recipe verbatim')
    }
    if (violationsFor(fixtureName, gutted).length === 0) {
      throw new Error('a recipe with its drafts restore removed still passed')
    }
  })
  check('the executable Rust pin runs exactly the documented recipe (#3438)', () => {
    // Both copies are hand-formatted, so compare them modulo padding INSIDE
    // parens too — `( SELECT …)` and `(SELECT …)` are the same statement, and
    // this check is about SQL drift, not indentation.
    const canonical = (statement) => statement.replaceAll('( ', '(').replaceAll(' )', ')')
    const documented = statementsFor(documentedRecipe()).map(canonical)
    const pinned = statementsFor(executableRecipePin())
      .map(canonical)
      .filter(
        // The pin builds this from `sqlite_schema` at runtime; AGENTS.md
        // describes it in prose because its DDL is whatever head's is.
        (statement) => !/^create\s+table\s+_new_blocks\b/.test(statement),
      )
    if (documented.length === 0) throw new Error('extracted an empty documented recipe')
    if (pinned.join(';\n') !== documented.join(';\n')) {
      const drifted = [
        ...documented
          .filter((statement) => !pinned.includes(statement))
          .map((s) => `  AGENTS.md only: ${s}`),
        ...pinned
          .filter((statement) => !documented.includes(statement))
          .map((s) => `  tests.rs only:  ${s}`),
      ]
      const detail = drifted.join('\n') || '  (same statements, different order)'
      throw new Error(
        `migrations/AGENTS.md §Table-rebuild and the recipe executed by ` +
          `agents_md_table_rebuild_recipe_preserves_authoritative_state_606 have drifted:\n${detail}`,
      )
    }
  })
  check('the executable Rust pin also passes this guard', () => {
    const violations = violationsFor(fixtureName, executableRecipePin())
    if (violations.length > 0) {
      throw new Error(`the executed recipe violates the guard: ${violations.join('; ')}`)
    }
  })

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
