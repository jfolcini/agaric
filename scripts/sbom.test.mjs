// Tests for scripts/sbom.mjs and scripts/generate-vex.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildVex,
  isAffected,
  justificationOf,
  parseDenyIgnores,
  parseNsprc,
} from './generate-vex.mjs'
import {
  MIN_NPM,
  augmentCycloneDX,
  augmentSPDX,
  checkCycloneDX,
  npmComponents,
  productPurl,
  rustComponents,
} from './sbom.mjs'

// Every `describe()`/`it()` is `void`-ed: node:test's returned promise fulfils
// even when the test fails, so there is nothing to await.

const ROOT = resolve(import.meta.dirname, '..')
const REG = 'registry+https://github.com/rust-lang/crates.io-index'
const pkg = (name, version, { source = REG, kind = ['lib'] } = {}) => ({
  id: `${name} ${version}`,
  name,
  version,
  source,
  targets: [{ kind }],
})
const dep = (id, kind = null) => ({ pkg: id, dep_kinds: [{ kind }] })
const METADATA = {
  packages: [
    pkg('agaric', '0.25.0', { source: null }),
    pkg('agaric-core', '0.1.0', { source: null }),
    pkg('tauri', '2.12.5'),
    pkg('serde', '1.0.0'),
    pkg('serde_derive', '1.0.0', { kind: ['proc-macro'] }),
    pkg('syn', '2.0.0'),
    pkg('cc', '1.0.0'),
    pkg('criterion', '0.5.0'),
  ],
  resolve: {
    nodes: [
      {
        id: 'agaric 0.25.0',
        deps: [
          dep('agaric-core 0.1.0'),
          dep('tauri 2.12.5'),
          dep('cc 1.0.0', 'build'),
          dep('criterion 0.5.0', 'dev'),
        ],
      },
      { id: 'agaric-core 0.1.0', deps: [dep('serde 1.0.0'), dep('serde_derive 1.0.0')] },
      { id: 'tauri 2.12.5', deps: [dep('serde 1.0.0')] },
      { id: 'serde 1.0.0', deps: [] },
      { id: 'serde_derive 1.0.0', deps: [dep('syn 2.0.0')] },
      { id: 'syn 2.0.0', deps: [] },
      { id: 'cc 1.0.0', deps: [] },
      { id: 'criterion 0.5.0', deps: [] },
    ],
  },
}
const LOCK = `name = "tauri"\nversion = "2.12.5"\nsource = "${REG}"\nchecksum = "${'a'.repeat(64)}"\n`

void describe('rustComponents', () => {
  void it('keeps registry crates reached through normal dependencies, with their Cargo.lock sha256', () => {
    const out = rustComponents(METADATA, LOCK)
    assert.deepEqual(
      out.map((c) => c.purl),
      ['pkg:cargo/serde@1.0.0', 'pkg:cargo/tauri@2.12.5'],
    )
    assert.equal(out.find((c) => c.name === 'tauri').sha256, 'a'.repeat(64))
  })
  void it('drops build, dev and proc-macro dependencies and what only they pull in', () => {
    const names = new Set(rustComponents(METADATA, LOCK).map((c) => c.name))
    for (const gone of ['cc', 'criterion', 'serde_derive', 'syn', 'agaric-core'])
      assert.ok(!names.has(gone), gone)
  })
})

void describe('npmComponents', () => {
  void it('keeps non-dev entries, encodes scopes, converts the integrity to hex', () => {
    const out = npmComponents({
      packages: {
        '': { name: 'agaric' },
        'node_modules/react': {
          version: '19.0.0',
          integrity: `sha512-${Buffer.from('xy').toString('base64')}`,
        },
        'node_modules/@scope/pkg': { version: '1.0.0' },
        'node_modules/a/node_modules/react': { version: '19.0.0' },
        'node_modules/vitest': { version: '4.0.0', dev: true },
        'node_modules/fsevents': { version: '2.0.0', devOptional: true },
      },
    })
    assert.deepEqual(
      out.map((c) => c.purl),
      ['pkg:npm/%40scope/pkg@1.0.0', 'pkg:npm/react@19.0.0'],
    )
    assert.equal(out[1].sha512, Buffer.from('xy').toString('hex'))
  })
  void it('finds the frontend runtime tree in the real package-lock.json', () => {
    const out = npmComponents(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')))
    assert.ok(out.length >= MIN_NPM, `${out.length} npm components`)
    assert.ok(out.some((c) => c.name === 'react'))
    assert.ok(!out.some((c) => c.name === 'vitest'), 'a dev dependency leaked in')
  })
})

void describe('augment and check', () => {
  const components = [
    ...Array.from({ length: 200 }, (_, i) => ({
      kind: 'cargo',
      name: `c${i}`,
      version: '1.0.0',
      purl: `pkg:cargo/c${i}@1.0.0`,
    })),
    {
      kind: 'cargo',
      name: 'tauri',
      version: '2.0.0',
      purl: 'pkg:cargo/tauri@2.0.0',
      sha256: 'b'.repeat(64),
    },
    { kind: 'cargo', name: 'loro', version: '1.0.0', purl: 'pkg:cargo/loro@1.0.0' },
    ...Array.from({ length: 100 }, (_, i) => ({
      kind: 'npm',
      name: `n${i}`,
      version: '1.0.0',
      purl: `pkg:npm/n${i}@1.0.0`,
    })),
    {
      kind: 'npm',
      name: 'react',
      version: '19.0.0',
      purl: 'pkg:npm/react@19.0.0',
      sha512: 'c'.repeat(128),
    },
  ]
  void it('a syft-only document fails the check; the augmented one passes', () => {
    const syft = {
      components: [{ type: 'library', name: 'agaric', purl: 'pkg:deb/agaric@0.25.0' }],
    }
    assert.equal(checkCycloneDX(structuredClone(syft)).length, 6)
    const doc = augmentCycloneDX(structuredClone(syft), '0.25.0', components)
    assert.deepEqual(checkCycloneDX(doc), [])
    assert.equal(doc.metadata.component.purl, productPurl('0.25.0'))
    assert.deepEqual(doc.components.find((c) => c.name === 'tauri').hashes, [
      { alg: 'SHA-256', content: 'b'.repeat(64) },
    ])
    assert.equal(doc.dependencies.at(-1).dependsOn.length, components.length)
  })
  void it('SPDX gains the product, a CONTAINS per component, and no duplicates', () => {
    const syft = {
      packages: [
        {
          name: 'react',
          SPDXID: 'x',
          externalRefs: [{ referenceLocator: 'pkg:npm/react@19.0.0' }],
        },
      ],
      relationships: [],
    }
    const doc = augmentSPDX(syft, '0.25.0', components)
    assert.equal(doc.packages.filter((p) => p.name === 'react').length, 1)
    assert.equal(
      doc.relationships.filter((r) => r.relationshipType === 'CONTAINS').length,
      components.length - 1,
    )
    assert.ok(
      doc.relationships.some(
        (r) =>
          r.relationshipType === 'DESCRIBES' && r.relatedSpdxElement === 'SPDXRef-Package-agaric',
      ),
    )
  })
})

void describe('generate-vex', () => {
  const sbom = {
    metadata: { component: { purl: 'pkg:github/jfolcini/agaric@0.25.0' } },
    components: [
      { purl: 'pkg:cargo/quick-xml@0.41.0' },
      { purl: 'pkg:cargo/chrono@0.4.45' },
      { purl: 'pkg:npm/picomatch@4.0.7' },
    ],
  }
  const OSV = {
    'RUSTSEC-1': {
      affected: [
        {
          package: { ecosystem: 'crates.io', name: 'quick-xml' },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.41.0' }] }],
        },
      ],
    },
    'RUSTSEC-2': {
      affected: [
        {
          package: { ecosystem: 'crates.io', name: 'chrono' },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
        },
      ],
    },
    'GHSA-aaaa-bbbb-cccc': {
      aliases: ['CVE-1'],
      affected: [
        {
          package: { ecosystem: 'npm', name: 'picomatch' },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '4.0.7' }] }],
        },
      ],
    },
    'RUSTSEC-3': { affected: [{ package: { ecosystem: 'PyPI', name: 'x' } }] },
  }
  const osv = (id) =>
    OSV[id] ? Promise.resolve(OSV[id]) : Promise.reject(new Error(`OSV ${id}: HTTP 404`))

  void it('names the SBOM product and only the affected versions it ships', async () => {
    const doc = await buildVex({
      waivers: [
        { id: 'RUSTSEC-1', reason: 'build-time only' },
        { id: 'RUSTSEC-2', reason: 'unmaintained [vex:vulnerable_code_not_present]' },
        { id: 'GHSA-aaaa-bbbb-cccc', reason: 'own globs only' },
      ],
      sbom,
      osv,
      timestamp: 'T',
    })
    const [xml, chrono, pico] = doc.statements
    assert.equal(
      xml.justification,
      'component_not_present',
      'quick-xml 0.41.0 is the fix, not affected',
    )
    assert.equal(xml.products[0].subcomponents, undefined)
    assert.deepEqual(chrono.products[0], {
      '@id': 'pkg:github/jfolcini/agaric@0.25.0',
      subcomponents: [{ '@id': 'pkg:cargo/chrono@0.4.45' }],
    })
    assert.equal(chrono.justification, 'vulnerable_code_not_present')
    assert.equal(chrono.impact_statement, 'unmaintained')
    assert.equal(pico.justification, 'vulnerable_code_not_in_execute_path')
    assert.deepEqual(pico.vulnerability.aliases, ['CVE-1'])
    assert.ok(doc.statements.every((s) => s.status === 'not_affected'))
  })

  void it('fails closed on an unresolvable advisory or an SBOM without a product', async () => {
    await assert.rejects(
      buildVex({ waivers: [{ id: 'RUSTSEC-9', reason: 'r' }], sbom, osv }),
      /HTTP 404/,
    )
    await assert.rejects(
      buildVex({ waivers: [{ id: 'RUSTSEC-3', reason: 'r' }], sbom, osv }),
      /names no crates.io or npm package/,
    )
    await assert.rejects(
      buildVex({ waivers: [], sbom: { components: [] }, osv }),
      /no metadata.component.purl/,
    )
  })

  void it('reads OSV ranges: introduced/fixed, last_affected, open-ended, explicit versions', () => {
    const fixed = {
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0.2.0' }, { fixed: '0.4.1' }] }],
    }
    assert.equal(isAffected(fixed, '0.4.0'), true)
    assert.equal(isAffected(fixed, '0.4.1'), false)
    assert.equal(isAffected(fixed, '0.1.9'), false)
    assert.equal(
      isAffected(
        { ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '4.0.7' }] }] },
        '4.0.7',
      ),
      true,
    )
    assert.equal(
      isAffected({ ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }] }] }, '9.9.9'),
      true,
    )
    assert.equal(isAffected({ versions: ['1.2.3'] }, '1.2.3'), true)
  })

  void it('validates the [vex:] tag and parses the real waiver files', () => {
    assert.throws(() => justificationOf('x [vex:not_a_thing]'), /unknown OpenVEX justification/)
    const deny = parseDenyIgnores(readFileSync(join(ROOT, 'src-tauri/deny.toml'), 'utf8'))
    assert.ok(deny.length > 0 && deny.every((e) => /^RUSTSEC-\d{4}-\d{4}$/.test(e.id) && e.reason))
    const npm = parseNsprc(JSON.parse(readFileSync(join(ROOT, '.nsprc'), 'utf8')))
    assert.equal(new Set(npm.map((e) => e.id)).size, npm.length, 'one statement per GHSA')
    assert.throws(() => parseNsprc({ 1: { active: true, notes: 'no id here' } }), /name no GHSA id/)
  })
})
