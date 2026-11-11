import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { assetName } from '@/lib/export-graph'

interface AssetNameCase {
  name: string
  filename: string
  asset: string
}

const { cases } = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../conformance/asset-names.vectors.json'),
    'utf8',
  ),
) as { cases: AssetNameCase[] }

// The rows `asset_names_match_the_export_vectors` reads in Rust: the export's
// asset names and the Markdown mirror's copies' names cannot drift (#5363).
describe('assetName names an attachment in assets/<id>/ as the mirror does', () => {
  it('reads every row', () => {
    expect(cases.length).toBeGreaterThan(20)
  })

  it.each(cases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(assetName(row.filename)).toBe(row.asset)
  })
})
