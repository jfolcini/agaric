#!/usr/bin/env node
// Counts the Status column of a comparison matrix (COMPARISON-*-MATRIX.md) per
// section and writes the table between its scorecard markers, so the counts in
// the document are never typed by hand.
//
//   node scripts/comparison-scorecard.mjs            # print both tables
//   node scripts/comparison-scorecard.mjs --write    # rewrite the marked blocks
//   node scripts/comparison-scorecard.mjs --check    # exit 1 if a block is stale

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..')
const FILES = ['COMPARISON-LOGSEQ-MATRIX.md', 'COMPARISON-OBSIDIAN-MATRIX.md']
const START = '<!-- scorecard:start -->'
const END = '<!-- scorecard:end -->'

// A status is read by its first word; a qualifier after it ("Better vs core",
// "Done (opt-in)") narrows the claim without moving the row to another bucket.
const BUCKET_OF = {
  better: 'ahead',
  done: 'level',
  tie: 'level',
  partial: 'behind',
  gap: 'behind',
  design: 'unranked',
  unverified: 'unranked',
}
const BUCKETS = ['ahead', 'level', 'behind', 'unranked']

function cellsOf(line) {
  // Split on pipes that are not escaped; drop the empty ends.
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim())
}

function countSections(text, file) {
  const sections = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), ahead: 0, level: 0, behind: 0, unranked: 0 }
      sections.push(current)
      continue
    }
    if (current === null || !line.startsWith('|')) continue
    const cells = cellsOf(line)
    if (cells.length !== 4 || cells[3] === 'Status' || /^-+$/.test(cells[3])) continue
    const word = cells[3]
      .replaceAll('*', '')
      .trim()
      .split(/[\s(;,]/)[0]
      .toLowerCase()
    const bucket = BUCKET_OF[word]
    if (bucket === undefined) {
      throw new Error(`${file}: unknown status "${cells[3]}" in row "${cells[0]}"`)
    }
    current[bucket] += 1
  }
  return sections.filter((s) => BUCKETS.some((b) => s[b] > 0))
}

function render(sections) {
  const total = { ahead: 0, level: 0, behind: 0, unranked: 0 }
  const rows = sections.map((s) => {
    for (const b of BUCKETS) total[b] += s[b]
    return `| ${s.title} | ${s.ahead} | ${s.level} | ${s.behind} | ${s.unranked} |`
  })
  const rowCount = BUCKETS.reduce((sum, b) => sum + total[b], 0)
  return [
    '| Section | Ahead | Level | Behind | Not ranked |',
    '| --- | :---: | :---: | :---: | :---: |',
    ...rows,
    `| **Total (${rowCount} rows)** | **${total.ahead}** | **${total.level}** | **${total.behind}** | **${total.unranked}** |`,
  ].join('\n')
}

const mode = process.argv[2] ?? '--print'
let stale = false
for (const file of FILES) {
  const path = join(REPO_ROOT, file)
  const text = readFileSync(path, 'utf8')
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${file}: scorecard markers ${START} … ${END} not found`)
  }
  const table = render(countSections(text.slice(0, start), file))
  const next = `${text.slice(0, start + START.length)}\n${table}\n${text.slice(end)}`
  if (mode === '--write') {
    if (next !== text) writeFileSync(path, next)
  } else if (mode === '--check') {
    if (next !== text) {
      stale = true
      console.error(
        `${file}: scorecard is stale; run node scripts/comparison-scorecard.mjs --write`,
      )
    }
  } else {
    console.log(`${file}\n${table}\n`)
  }
}
if (stale) process.exit(1)
