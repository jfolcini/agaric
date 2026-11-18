#!/usr/bin/env node
// Make a release SBOM describe what ships. syft scans the bundle, but a
// compiled Tauri binary carries no package metadata, so syft alone lists the
// installer and a few bundled OS libraries and none of the Rust crates or npm
// packages inside the app. This script adds them:
//
//   Rust: every crate the `agaric` package compiles for <target>, from
//         `cargo metadata --filter-platform <target>`: normal dependencies
//         only (build scripts and proc-macros run at build time and do not
//         ship), with each crate's Cargo.lock sha256.
//   npm:  every non-dev package-lock.json entry, the frontend's runtime
//         dependency tree, with its lockfile integrity hash.
//
//   node scripts/sbom.mjs augment --target <triple> --cyclonedx <file> --spdx <file>
//   node scripts/sbom.mjs check --cyclonedx <file>
//
// `augment` rewrites both syft documents in place and names the product
// `pkg:github/jfolcini/agaric@<package.json version>`, the identifier the
// per-platform OpenVEX document (scripts/generate-vex.mjs) refers to.
// `check` fails a document missing the Rust or npm half, the defect it
// exists to stop recurring.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
export const PRODUCT = 'pkg:github/jfolcini/agaric'
// Well under every target's real count (each compiles several hundred crates
// and ships a few hundred npm packages), far above what a broken scan yields.
export const MIN_CARGO = 200
export const MIN_NPM = 100
const REQUIRED = ['pkg:cargo/tauri@', 'pkg:cargo/loro@', 'pkg:npm/react@']

export const productPurl = (version) => `${PRODUCT}@${version}`

/** Registry crates `root` compiles for the metadata's platform. */
export function rustComponents(metadata, lockText, root = 'agaric') {
  const packages = new Map(metadata.packages.map((p) => [p.id, p]))
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]))
  const start = metadata.packages.find((p) => p.name === root)
  if (!start) throw new Error(`cargo metadata has no package ${root}`)
  const checksums = new Map(
    [
      ...lockText.matchAll(
        /^name = "([^"]+)"\nversion = "([^"]+)"\nsource = "[^"]+"\nchecksum = "([0-9a-f]{64})"/gm,
      ),
    ].map(([, n, v, c]) => [`${n}@${v}`, c]),
  )
  const seen = new Set()
  const stack = [start.id]
  while (stack.length > 0) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      const pkg = packages.get(dep.pkg)
      const runtime = dep.dep_kinds.some((k) => k.kind === null)
      const procMacro = pkg?.targets.some((t) => t.kind.includes('proc-macro'))
      if (runtime && !procMacro) stack.push(dep.pkg)
    }
  }
  const out = []
  for (const id of seen) {
    const p = packages.get(id)
    if (!p.source?.startsWith('registry+')) continue
    const component = {
      kind: 'cargo',
      name: p.name,
      version: p.version,
      purl: `pkg:cargo/${p.name}@${p.version}`,
    }
    const sha256 = checksums.get(`${p.name}@${p.version}`)
    if (sha256) component.sha256 = sha256
    out.push(component)
  }
  return out.toSorted((a, b) => a.purl.localeCompare(b.purl))
}

/** Non-dev package-lock.json entries. */
export function npmComponents(lock) {
  const out = []
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || entry.dev || entry.devOptional || !entry.version)
      continue
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const component = {
      kind: 'npm',
      name,
      version: entry.version,
      purl: `pkg:npm/${name.replace(/^@/, '%40')}@${entry.version}`,
    }
    const sri = entry.integrity?.match(/^sha512-(.+)$/)
    if (sri) component.sha512 = Buffer.from(sri[1], 'base64').toString('hex')
    out.push(component)
  }
  // A package hoisted once and nested elsewhere at the same version is one
  // component; keep the first (top-level) entry, which carries the integrity.
  const unique = new Map()
  for (const c of out) if (!unique.has(c.purl)) unique.set(c.purl, c)
  return [...unique.values()].toSorted((a, b) => a.purl.localeCompare(b.purl))
}

/** Add the product and the components to a syft CycloneDX JSON document. */
export function augmentCycloneDX(doc, version, components) {
  const product = productPurl(version)
  doc.metadata ??= {}
  doc.metadata.component = {
    type: 'application',
    'bom-ref': product,
    name: 'agaric',
    version,
    purl: product,
  }
  const existing = new Set((doc.components ?? []).map((c) => c.purl).filter(Boolean))
  const added = components
    .filter((c) => !existing.has(c.purl))
    .map((c) => {
      const out = {
        type: 'library',
        'bom-ref': c.purl,
        name: c.name,
        version: c.version,
        purl: c.purl,
      }
      const hashes = []
      if (c.sha256) hashes.push({ alg: 'SHA-256', content: c.sha256 })
      if (c.sha512) hashes.push({ alg: 'SHA-512', content: c.sha512 })
      if (hashes.length > 0) out.hashes = hashes
      return out
    })
  doc.components = [...(doc.components ?? []), ...added]
  doc.dependencies = [
    ...(doc.dependencies ?? []).filter((d) => d.ref !== product),
    { ref: product, dependsOn: added.map((c) => c.purl) },
  ]
  return doc
}

const spdxId = (c) =>
  `SPDXRef-Package-${c.kind}-${c.name}-${c.version}`.replace(/[^A-Za-z0-9.-]/g, '-')

/** Add the product and the components to a syft SPDX JSON document. */
export function augmentSPDX(doc, version, components) {
  const product = productPurl(version)
  const productId = 'SPDXRef-Package-agaric'
  const purlRef = (purl) => ({
    referenceCategory: 'PACKAGE-MANAGER',
    referenceType: 'purl',
    referenceLocator: purl,
  })
  const known = new Set(
    (doc.packages ?? []).flatMap((p) => (p.externalRefs ?? []).map((r) => r.referenceLocator)),
  )
  const packages = [
    {
      name: 'agaric',
      SPDXID: productId,
      versionInfo: version,
      downloadLocation: 'https://github.com/jfolcini/agaric',
      externalRefs: [purlRef(product)],
      primaryPackagePurpose: 'APPLICATION',
    },
  ]
  const relationships = [
    {
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: productId,
    },
  ]
  for (const c of components) {
    if (known.has(c.purl)) continue
    const pkg = {
      name: c.name,
      SPDXID: spdxId(c),
      versionInfo: c.version,
      downloadLocation: 'NOASSERTION',
      externalRefs: [purlRef(c.purl)],
    }
    const checksums = []
    if (c.sha256) checksums.push({ algorithm: 'SHA256', checksumValue: c.sha256 })
    if (c.sha512) checksums.push({ algorithm: 'SHA512', checksumValue: c.sha512 })
    if (checksums.length > 0) pkg.checksums = checksums
    packages.push(pkg)
    relationships.push({
      spdxElementId: productId,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: pkg.SPDXID,
    })
  }
  doc.packages = [...(doc.packages ?? []), ...packages]
  doc.relationships = [...(doc.relationships ?? []), ...relationships]
  return doc
}

/** Problems that make a CycloneDX document unfit to ship; empty when fine. */
export function checkCycloneDX(doc) {
  const purls = (doc.components ?? []).map((c) => c.purl ?? '')
  const cargo = purls.filter((p) => p.startsWith('pkg:cargo/')).length
  const npm = purls.filter((p) => p.startsWith('pkg:npm/')).length
  const problems = []
  if (!doc.metadata?.component?.purl?.startsWith(`${PRODUCT}@`))
    problems.push(`metadata.component is not ${PRODUCT}@<version>`)
  if (cargo < MIN_CARGO) problems.push(`${cargo} Rust crates (want at least ${MIN_CARGO})`)
  if (npm < MIN_NPM) problems.push(`${npm} npm packages (want at least ${MIN_NPM})`)
  for (const prefix of REQUIRED)
    if (!purls.some((p) => p.startsWith(prefix))) problems.push(`no ${prefix}* component`)
  return problems
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || !argv[i + 1]) throw new Error(`missing ${name}`)
  return argv[i + 1]
}

function main(argv) {
  const [cmd] = argv
  const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
  const writeJson = (f, d) => writeFileSync(f, `${JSON.stringify(d, null, 2)}\n`)
  if (cmd === 'augment') {
    const target = arg(argv, '--target')
    const version = readJson(join(ROOT, 'package.json')).version
    const metadata = JSON.parse(
      execFileSync(
        'cargo',
        ['metadata', '--format-version', '1', '--locked', '--filter-platform', target],
        {
          cwd: join(ROOT, 'src-tauri'),
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        },
      ),
    )
    const components = [
      ...rustComponents(metadata, readFileSync(join(ROOT, 'src-tauri/Cargo.lock'), 'utf8')),
      ...npmComponents(readJson(join(ROOT, 'package-lock.json'))),
    ]
    const cdx = arg(argv, '--cyclonedx')
    const spdx = arg(argv, '--spdx')
    writeJson(cdx, augmentCycloneDX(readJson(cdx), version, components))
    writeJson(spdx, augmentSPDX(readJson(spdx), version, components))
    console.log(`sbom: added ${components.length} components for ${target} to ${cdx} and ${spdx}`)
    return 0
  }
  if (cmd === 'check') {
    const file = arg(argv, '--cyclonedx')
    const problems = checkCycloneDX(readJson(file))
    for (const p of problems) console.error(`::error file=scripts/sbom.mjs::${file}: ${p}`)
    return problems.length > 0 ? 1 : 0
  }
  throw new Error(
    'usage: sbom.mjs augment --target <triple> --cyclonedx <file> --spdx <file> | check --cyclonedx <file>',
  )
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (e) {
    console.error(`sbom.mjs: ${e.message}`)
    process.exit(1)
  }
}
