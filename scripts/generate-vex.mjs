#!/usr/bin/env node
// Write the OpenVEX 0.2.0 document for one release SBOM, from the advisories
// this repo has decided do not affect it: src-tauri/deny.toml
// `[advisories].ignore` (RustSec) and .nsprc (npm, by GHSA).
//
//   node scripts/generate-vex.mjs --sbom <cyclonedx.json> --output <openvex.json>
//
// Each statement names the SBOM's own product purl (scripts/sbom.mjs sets it)
// and, as subcomponents, the purls of the affected package in that SBOM, so a
// scanner reading the pair can match it. The affected package comes from the
// advisory's OSV record. Every waiver is a decision, so every statement is
// `not_affected`: `component_not_present` when this platform does not ship
// the package, else the justification a `[vex:<justification>]` tag in the
// waiver names, or `vulnerable_code_not_in_execute_path`. The waiver text is
// the impact statement. An advisory OSV cannot resolve fails the run: a VEX
// that silently drops a waiver is the defect this replaces.
//
// Source of truth: deny.toml and .nsprc (never written here). Run by
// .github/actions/syft-sbom right after the SBOM it describes.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CONTEXT = 'https://openvex.dev/ns/v0.2.0'
const AUTHOR = 'Agaric maintainers'
export const JUSTIFICATIONS = [
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]
const DEFAULT_JUSTIFICATION = 'vulnerable_code_not_in_execute_path'
const ECOSYSTEM_PURL = { 'crates.io': 'pkg:cargo/', npm: 'pkg:npm/' }

/** `{ id, reason }` for every deny.toml `[advisories].ignore` entry. */
export function parseDenyIgnores(text) {
  const entries = []
  let inArray = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!inArray) {
      inArray = /^ignore\s*=\s*\[/.test(line)
      continue
    }
    if (line === ']') break
    if (line === '' || line.startsWith('#')) continue
    const m = line.match(/^\{\s*id\s*=\s*"([^"]+)"\s*,\s*reason\s*=\s*"([^"]*)"\s*\},?$/)
    if (!m) throw new Error(`deny.toml [advisories].ignore: unrecognised entry: ${raw}`)
    entries.push({ id: m[1], reason: m[2] })
  }
  if (entries.length === 0) throw new Error('deny.toml [advisories].ignore parsed to 0 entries')
  return entries
}

/** `{ id: GHSA, reason }` for every active .nsprc waiver, one per GHSA. */
export function parseNsprc(json) {
  const byId = new Map()
  for (const [key, entry] of Object.entries(json)) {
    if (entry.active === false) continue
    const ghsa = entry.notes?.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/)?.[0]
    if (!ghsa) throw new Error(`.nsprc ${key}: notes name no GHSA id`)
    byId.set(ghsa, { id: ghsa, reason: entry.notes })
  }
  return [...byId.values()]
}

/** Split an optional `[vex:<justification>]` tag off a waiver reason. */
export function justificationOf(reason) {
  const m = reason.match(/\[vex:([a-z_]+)\]/)
  if (!m) return { justification: DEFAULT_JUSTIFICATION, impact: reason.trim() }
  if (!JUSTIFICATIONS.includes(m[1]))
    throw new Error(`unknown OpenVEX justification "${m[1]}" in: ${reason}`)
  return { justification: m[1], impact: reason.replace(m[0], '').trim() }
}

/** Numeric comparison of dotted versions; prerelease tags are ignored. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[-+]/)[0].split('.').map(Number)
  const pb = String(b).split(/[-+]/)[0].split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

/** Whether `version` falls in an OSV `affected` entry (versions list or ranges). */
export function isAffected(affected, version) {
  if (affected.versions?.includes(version)) return true
  for (const range of affected.ranges ?? []) {
    if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue
    let introduced = null
    for (const event of range.events ?? []) {
      if ('introduced' in event) introduced = event.introduced
      const end = event.fixed ?? event.last_affected
      if (end !== undefined && introduced !== null) {
        const below =
          event.fixed !== undefined
            ? compareVersions(version, end) < 0
            : compareVersions(version, end) <= 0
        if (compareVersions(version, introduced) >= 0 && below) return true
        introduced = null
      }
    }
    if (introduced !== null && compareVersions(version, introduced) >= 0) return true
  }
  return false
}

const advisoryUrl = (id) =>
  id.startsWith('RUSTSEC-')
    ? `https://rustsec.org/advisories/${id}.html`
    : `https://github.com/advisories/${id}`

/**
 * Build the document. `osv(id)` returns the advisory's OSV record; `sbom` is
 * the platform's CycloneDX document.
 */
export async function buildVex({ waivers, sbom, osv, timestamp = new Date().toISOString() }) {
  const product = sbom.metadata?.component?.purl
  if (!product)
    throw new Error('the SBOM has no metadata.component.purl; run scripts/sbom.mjs augment first')
  const purls = (sbom.components ?? []).map((c) => c.purl).filter(Boolean)
  const statements = []
  for (const { id, reason } of waivers) {
    const record = await osv(id)
    const affected = (record.affected ?? []).filter((a) => ECOSYSTEM_PURL[a.package?.ecosystem])
    if (affected.length === 0) throw new Error(`${id}: OSV names no crates.io or npm package`)
    const subcomponents = purls.filter((p) =>
      affected.some((a) => {
        const prefix = `${ECOSYSTEM_PURL[a.package.ecosystem]}${a.package.name.replace(/^@/, '%40')}@`
        return p.startsWith(prefix) && isAffected(a, p.slice(prefix.length))
      }),
    )
    const { justification, impact } = justificationOf(reason)
    const statement = {
      vulnerability: {
        name: id,
        '@id': advisoryUrl(id),
        ...(record.aliases?.length ? { aliases: record.aliases } : {}),
      },
      products: [
        {
          '@id': product,
          ...(subcomponents.length > 0
            ? { subcomponents: subcomponents.map((p) => ({ '@id': p })) }
            : {}),
        },
      ],
      status: 'not_affected',
      justification: subcomponents.length > 0 ? justification : 'component_not_present',
      impact_statement: impact,
    }
    statements.push(statement)
  }
  return {
    '@context': CONTEXT,
    '@id': `https://openvex.dev/docs/${product.replace(/^pkg:/, '').replaceAll('/', '-')}`,
    author: AUTHOR,
    timestamp,
    version: 1,
    statements,
  }
}

async function osvFetch(id) {
  const res = await fetch(`https://api.osv.dev/v1/vulns/${id}`)
  if (!res.ok) throw new Error(`OSV ${id}: HTTP ${res.status}`)
  return res.json()
}

async function main(argv) {
  const get = (name) => {
    const i = argv.indexOf(name)
    if (i === -1 || !argv[i + 1])
      throw new Error(`usage: generate-vex.mjs --sbom <cyclonedx.json> --output <file>`)
    return argv[i + 1]
  }
  const waivers = [
    ...parseDenyIgnores(readFileSync(join(ROOT, 'src-tauri/deny.toml'), 'utf8')),
    ...parseNsprc(JSON.parse(readFileSync(join(ROOT, '.nsprc'), 'utf8'))),
  ]
  const sbom = JSON.parse(readFileSync(get('--sbom'), 'utf8'))
  const doc = await buildVex({ waivers, sbom, osv: osvFetch })
  writeFileSync(get('--output'), `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`openvex: ${doc.statements.length} statements for ${sbom.metadata.component.purl}`)
  return 0
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`generate-vex.mjs: ${e.message}`)
      process.exit(1)
    },
  )
}
