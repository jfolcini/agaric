import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '../../scripts/check-migrations-strict.mjs')

describe('check-migrations-strict.mjs', () => {
  it('passes when STRICT is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agaric-test-'))
    const file = join(dir, '0042_test.sql')
    writeFileSync(
      file,
      `CREATE TABLE foo (
    id TEXT NOT NULL,
    PRIMARY KEY (id)
) STRICT;\n`,
    )
    expect(() => execFileSync('node', [SCRIPT, file])).not.toThrow()
  })

  it('fails when STRICT is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agaric-test-'))
    const file = join(dir, '0042_test.sql')
    writeFileSync(
      file,
      `CREATE TABLE foo (
    id TEXT NOT NULL,
    PRIMARY KEY (id)
);\n`,
    )
    expect(() => execFileSync('node', [SCRIPT, file])).toThrow(/must use STRICT mode/)
  })

  it('does not false-positive on semicolon inside a line comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agaric-test-'))
    const file = join(dir, '0042_test.sql')
    writeFileSync(
      file,
      `CREATE TABLE foo (
    id TEXT NOT NULL,  -- example: id; this column holds the id
    PRIMARY KEY (id)
) STRICT;\n`,
    )
    expect(() => execFileSync('node', [SCRIPT, file])).not.toThrow()
  })

  it('does not false-positive on semicolon inside a block comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agaric-test-'))
    const file = join(dir, '0042_test.sql')
    writeFileSync(
      file,
      `CREATE TABLE foo (
    id TEXT NOT NULL /* primary; key */,
    PRIMARY KEY (id)
) STRICT;\n`,
    )
    expect(() => execFileSync('node', [SCRIPT, file])).not.toThrow()
  })
})
