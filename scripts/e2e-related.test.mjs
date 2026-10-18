import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { parseSync } from 'vite'

// `scripts/e2e-related.sh` picks the e2e specs a change can affect by their
// area tags, so an untagged spec is one no change ever selects. Every
// top-level test or describe title ends with its `@area` tags, in both lanes;
// Playwright reads title tags as native tags (`--grep @editor`). A node:test
// file so `lint`, which every non-docs PR runs, runs it on a spec-only change.

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts/e2e-related.sh')

const LANES = [
  {
    dir: 'e2e',
    suffix: '.spec.ts',
    callee: /^test(\.describe)?(\.(only|skip|fixme|fail|slow|serial|parallel))*$/,
  },
  { dir: 'e2e-tauri', suffix: '.e2e.ts', callee: /^(describe|it)(\.(only|skip))?$/ },
]

function vocabulary() {
  const table = /^AREA_WORDS=\(\n([\s\S]*?)\n\)$/m.exec(readFileSync(SCRIPT, 'utf8'))
  const areas = [...(table?.[1] ?? '').matchAll(/^\s*'([a-z]+):/gm)].map((m) => m[1])
  if (areas.length === 0) throw new Error(`no AREA_WORDS table in ${SCRIPT}`)
  return new Set(areas)
}

function calleeName(node) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && node.computed !== true) {
    const object = calleeName(node.object)
    return object === null ? null : `${object}.${node.property.name}`
  }
  return null
}

const isFunction = (n) => n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression'

// The text of a title literal; `${…}` parts read as a space.
function titleText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked).join(' ')
  return null
}

// Titles of the declarations no other declaration encloses: those inherit
// nothing, so each must carry its own tags. A loop or helper around them is
// walked through.
function topLevelTitles(program, callee) {
  const titles = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node === null || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      const title = titleText(node.arguments[0])
      if (
        title !== null &&
        node.arguments.some(isFunction) &&
        callee.test(calleeName(node.callee) ?? '')
      ) {
        titles.push(title)
        return
      }
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(program)
  return titles
}

// Every spec file's areas, plus one problem per file that has none, an unknown
// one, or cannot be read.
function scanSpecs() {
  const known = vocabulary()
  const specs = []
  const problems = []
  for (const lane of LANES) {
    const files = readdirSync(join(ROOT, lane.dir)).filter((f) => f.endsWith(lane.suffix))
    if (files.length === 0) problems.push(`${lane.dir}/: no *${lane.suffix} file found`)
    for (const name of files.toSorted()) {
      const file = `${lane.dir}/${name}`
      const source = readFileSync(join(ROOT, file), 'utf8')
      const { program, errors } = parseSync(file, source, { lang: 'ts' })
      if (errors.length > 0) {
        problems.push(`${file}: cannot parse: ${errors[0].message}`)
        continue
      }
      const titles = topLevelTitles(program, lane.callee)
      if (titles.length === 0) {
        problems.push(`${file}: no top-level test or describe with a literal title`)
      }
      const areas = new Set()
      for (const title of titles) {
        const tags = [...title.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => m[1])
        if (tags.length === 0) problems.push(`${file}: "${title}" ends with no @area tag`)
        for (const tag of tags) {
          if (known.has(tag)) areas.add(tag)
          else problems.push(`${file}: "${title}" has @${tag}, not one of ${[...known].join(' ')}`)
        }
      }
      specs.push({ file, areas })
    }
  }
  return { specs, problems }
}

// The spec files each lane's printed command names; `ALL` for a whole lane.
function select(paths) {
  const res = spawnSync('bash', [SCRIPT, '--stdin'], {
    input: paths.join('\n'),
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  const lane = (command) => {
    const line = res.stdout
      .split('\n')
      .find((l) => l === `  ${command}` || l.startsWith(`  ${command} `))
    if (line === undefined) return []
    const files = line.split(' ').filter((w) => /\.(spec|e2e)\.ts$/.test(w))
    return files.length === 0 ? 'ALL' : files
  }
  return { playwright: lane('npx playwright test'), wdio: lane('npm run test:e2e-tauri') }
}

const { specs, problems } = scanSpecs()
const tagged = (dir, area) =>
  specs
    .filter((s) => s.file.startsWith(`${dir}/`) && s.areas.has(area))
    .map((s) => s.file)
    .toSorted()

void test('every spec in both lanes ends its top-level titles with known @area tags', () => {
  assert.deepEqual(problems, [])
})

void test('a change under src/editor/ selects exactly the editor specs of both lanes', () => {
  const editor = { playwright: tagged('e2e', 'editor'), wdio: tagged('e2e-tauri', 'editor') }
  assert.ok(editor.playwright.length > 0 && editor.wdio.length > 0)
  assert.deepEqual(select(['src/editor/use-roving-editor.ts']), editor)
})

void test('a backend change selects only real-backend specs', () => {
  assert.deepEqual(select(['src-tauri/agaric-sync/src/mdns.rs']), {
    playwright: [],
    wdio: tagged('e2e-tauri', 'sync'),
  })
})

for (const { path, playwright, wdio } of [
  { path: 'e2e/helpers.ts', playwright: 'ALL', wdio: [] },
  { path: 'src/lib/tauri-mock/seed.ts', playwright: 'ALL', wdio: [] },
  { path: 'e2e-tauri/helpers.ts', playwright: [], wdio: 'ALL' },
  { path: 'src/components/ui/button.tsx', playwright: 'ALL', wdio: 'ALL' },
  { path: 'src-tauri/tauri.conf.json', playwright: 'ALL', wdio: 'ALL' },
  { path: 'tsconfig.app.json', playwright: 'ALL', wdio: 'ALL' },
]) {
  void test(`${path} runs whole lanes`, () => {
    assert.deepEqual(select([path]), { playwright, wdio })
  })
}

void test('a changed spec runs alone, and a deleted spec or a doc runs nothing', () => {
  const paths = ['e2e/smoke.spec.ts', 'e2e/gone.spec.ts', 'e2e-tauri/gone.e2e.ts', 'docs/BUILD.md']
  assert.deepEqual(select(paths), { playwright: ['e2e/smoke.spec.ts'], wdio: [] })
})
