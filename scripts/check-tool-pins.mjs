#!/usr/bin/env node
// CI installs prek, zizmor, taplo-cli, typos-cli and sqruff from the
// `taiki-e/install-action` `tool:` lists under .github/workflows/; a dev box
// installs the versions in scripts/setup-hooks.sh (`pinned_version_for`) and
// scripts/zizmor-hook.sh (`ZIZMOR_PINNED_VERSION`). Dependabot bumps action
// refs, not tool strings, so nothing else keeps those copies equal (#3523,
// #3742). This check fails on any tool named with two versions, a pinned tool
// installed unpinned, and a source it cannot read.
//
// Usage: node scripts/check-tool-pins.mjs
// Exit:  0 = every copy agrees, 1 = a mismatch or an unreadable source.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const WORKFLOWS = '.github/workflows'
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const pins = new Map() // tool -> Map(version -> [where])
const problems = []

function record(tool, version, where) {
  if (!pins.has(tool)) pins.set(tool, new Map())
  const versions = pins.get(tool)
  if (!versions.has(version)) versions.set(version, [])
  versions.get(version).push(where)
}

const table = read('scripts/setup-hooks.sh').match(/^pinned_version_for\(\) \{\n([\s\S]*?)\n\}$/m)
const tableRows = table ? [...table[1].matchAll(/^\s*([\w-]+)\) echo "([^"]+)" ;;$/gm)] : []
if (tableRows.length === 0) {
  problems.push(
    'scripts/setup-hooks.sh: found no `<tool>) echo "<version>" ;;` row in pinned_version_for()',
  )
}
for (const [, tool, version] of tableRows) record(tool, version, 'scripts/setup-hooks.sh')

const zizmor = read('scripts/zizmor-hook.sh').match(/^ZIZMOR_PINNED_VERSION="([^"]+)"$/m)
if (zizmor) record('zizmor', zizmor[1], 'scripts/zizmor-hook.sh')
else problems.push('scripts/zizmor-hook.sh: found no `ZIZMOR_PINNED_VERSION="<version>"` line')

const pinnedInScripts = new Set(pins.keys())
const installedByCi = new Set()
const workflows = readdirSync(join(ROOT, WORKFLOWS)).filter((name) => /\.ya?ml$/.test(name))
for (const name of workflows) {
  const rel = `${WORKFLOWS}/${name}`
  for (const [i, line] of read(rel).split('\n').entries()) {
    const value = line.match(/^\s*tool:\s*(.*)$/)?.[1]
    if (value === undefined) continue
    const where = `${rel}:${i + 1}`
    if (!/^[\w.@-]+(,[\w.@-]+)*$/.test(value)) {
      problems.push(
        `${where}: \`tool:\` is not a one-line \`name@version,…\` list, so it cannot be read`,
      )
      continue
    }
    for (const entry of value.split(',')) {
      const [tool, version] = entry.split('@')
      if (!pinnedInScripts.has(tool)) continue
      installedByCi.add(tool)
      if (version) record(tool, version, where)
      else problems.push(`${where}: \`${tool}\` has no @version, but the scripts pin it`)
    }
  }
}

for (const tool of pinnedInScripts) {
  if (!installedByCi.has(tool)) {
    problems.push(`${WORKFLOWS}/: no \`tool:\` list installs \`${tool}\`, which the scripts pin`)
  }
}
for (const [tool, versions] of pins) {
  if (versions.size < 2) continue
  const spread = [...versions].map(([v, where]) => `    ${v}: ${where.join(', ')}`).join('\n')
  problems.push(`\`${tool}\` is pinned to ${versions.size} versions:\n${spread}`)
}

if (problems.length > 0) {
  console.error(`tool pins disagree:\n${problems.map((p) => `  ${p}`).join('\n')}
  Fix: give the tool one version in every place listed above.`)
  process.exit(1)
}
const copies = [...pins.values()].reduce((n, versions) => n + [...versions.values()][0].length, 0)
console.log(`tool pins OK: ${pins.size} tools, ${copies} copies agree`)
