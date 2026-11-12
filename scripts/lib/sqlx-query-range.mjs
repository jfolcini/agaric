// Does the range <base>..<head> need pre-push Phase E, the
// `cargo sqlx prepare --check` run (#6560)? Prints exactly one line, `skip`
// or `run: <reason>`, and exits 0; any error goes to stderr with a non-zero
// exit, which `scripts/verify-ci-equivalent.sh` reads as "run".
//
//   node scripts/lib/sqlx-query-range.mjs <base> <head>
//
// Runs when the range touches a path the cache depends on (`.sqlx/`, `.sql`,
// a Cargo manifest or lockfile, `sqlx.toml`), when any `macro_rules!` at
// <head> wraps a query macro, or when a `.rs` hunk overlaps a query macro's
// lines before or after the change. Misses a `cfg` / `mod` / feature edit
// that newly compiles an unchanged query; CI's `lint` job is the gate.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

import { stripRustComments } from './rust-scan.mjs'

const PATH_TRIGGERS = [
  /^src-tauri\/\.sqlx\//,
  /^src-tauri\/.*\.sql$/,
  /^src-tauri\/(.*\/)?Cargo\.(toml|lock)$/,
  /(^|\/)sqlx\.toml$/,
]

const MACRO_RE = /(?:\b\w+\s*::\s*)*\bquery(?:_file)?(?:_as|_scalar)?(?:_unchecked)?\s*!\s*[([{]/g
const MACRO_RULES_RE = /\bmacro_rules\s*!\s*(\w+)\s*[([{]/g

// The offset just past the delimiter that closes the one at `open`, or
// `text.length` when it never closes. `text` has its literals blanked.
function closeOffset(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

function lineOf(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

// Each query macro in `text` as { start, end, name }, 1-based inclusive lines.
function queryMacros(text) {
  const code = stripRustComments(text)
  const line = lineOf(code)
  const macros = []
  for (const match of code.matchAll(MACRO_RE)) {
    const open = match.index + match[0].length - 1
    macros.push({
      start: line(match.index),
      end: line(Math.max(open, closeOffset(code, open) - 1)),
      name: match[0].slice(0, -1).replace(/\s+/g, ''),
    })
  }
  return macros
}

/** `[[startLine, endLine]]` of every query macro in Rust `text`, 1-based. */
export function querySpans(text) {
  return queryMacros(text).map(({ start, end }) => [start, end])
}

/** The name of the first `macro_rules!` in `text` whose body holds a query macro, or null. */
export function wrapperMacro(text) {
  const code = stripRustComments(text)
  for (const match of code.matchAll(MACRO_RULES_RE)) {
    const open = match.index + match[0].length - 1
    const body = code.slice(open, closeOffset(code, open))
    if (new RegExp(MACRO_RE.source).test(body)) return match[1]
  }
  return null
}

/**
 * The verdict line, `skip` or `run: <reason>`.
 *
 * @param {object} range
 * @param {string[]} range.paths every changed path, old and new names alike.
 * @param {{oldPath: string|null, newPath: string|null, oldText: string|null,
 *   newText: string|null, hunks: {oldStart: number, oldCount: number,
 *   newStart: number, newCount: number}[]}[]} range.files the `.rs` diff sections.
 * @param {string|null} range.wrapper a `macro_rules!` at head that wraps a query macro.
 */
export function decide({ paths, files, wrapper }) {
  const trigger = paths.find((path) => PATH_TRIGGERS.some((re) => re.test(path)))
  if (trigger !== undefined) return `run: ${trigger} changed`
  if (wrapper) return `run: wrapper macro ${wrapper}`
  for (const file of files) {
    const sides = [
      [file.newPath, file.newText, 'newStart', 'newCount', ''],
      [file.oldPath, file.oldText, 'oldStart', 'oldCount', ' before the change'],
    ]
    for (const [path, text, startKey, countKey, when] of sides) {
      if (text === null) continue
      const macros = queryMacros(text)
      for (const hunk of file.hunks) {
        if (hunk[countKey] === 0) continue
        const first = hunk[startKey]
        const last = first + hunk[countKey] - 1
        const hit = macros.find((m) => m.start <= last && first <= m.end)
        if (hit) return `run: ${path}:${Math.max(first, hit.start)}${when} is inside ${hit.name}`
      }
    }
  }
  return 'skip'
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const HEADER_RE =
  /^(index |old mode |new mode |similarity index |dissimilarity index |new file mode |deleted file mode )/

function sidePath(rest, prefix) {
  if (rest === '/dev/null') return null
  if (!rest.startsWith(prefix)) throw new Error(`unparseable diff path: ${rest}`)
  return rest.slice(prefix.length)
}

// `diff --git a/P b/P` names P only when both sides are the same path.
function samePath(header) {
  const rest = header.slice('diff --git '.length)
  const path = rest.slice(2, (rest.length - 1) / 2)
  if (rest !== `a/${path} b/${path}`) throw new Error(`unparseable diff header: ${header}`)
  return path
}

/** The sections of a `git diff -U0` patch: paths and hunk ranges. */
export function parsePatch(patch) {
  const sections = []
  let current = null
  let inHunks = false
  const finish = () => {
    if (current === null) return
    const named = current.oldPath ?? current.newPath
    if (named === undefined) {
      const path = samePath(current.header)
      current.oldPath = current.created ? null : path
      current.newPath = current.deleted ? null : path
    }
    current.oldPath ??= null
    current.newPath ??= null
    sections.push(current)
  }
  const lines = patch.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finish()
      current = { header: line, hunks: [] }
      inHunks = false
      continue
    }
    if (current === null) throw new Error(`unparseable diff line: ${line}`)
    const hunk = HUNK_RE.exec(line)
    if (hunk) {
      inHunks = true
      current.hunks.push({
        oldStart: Number(hunk[1]),
        oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newCount: hunk[4] === undefined ? 1 : Number(hunk[4]),
      })
    } else if (inHunks) {
      if (!/^[-+\\]/.test(line)) throw new Error(`unparseable diff line: ${line}`)
    } else if (line.startsWith('--- ')) {
      current.oldPath = sidePath(line.slice(4), 'a/')
    } else if (line.startsWith('+++ ')) {
      current.newPath = sidePath(line.slice(4), 'b/')
    } else if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length)
    } else if (HEADER_RE.test(line)) {
      if (line.startsWith('new file mode ')) current.created = true
      if (line.startsWith('deleted file mode ')) current.deleted = true
    } else {
      throw new Error(`unparseable diff line: ${line}`)
    }
  }
  finish()
  return sections
}

// `git diff -z --name-status` → every path named, old and new.
function parseNameStatus(out) {
  const fields = out.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const paths = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i]
    const count = /^[RC]/.test(status) ? 2 : 1
    if (!/^[ACDMRTU]\d*$/.test(status) || i + count >= fields.length) {
      throw new Error(`unparseable name-status entry: ${status}`)
    }
    paths.push(...fields.slice(i + 1, i + 1 + count))
    i += 1 + count
  }
  return paths
}

/** `(args) => stdout` of `git <args>` run in `cwd`; throws on a non-zero exit. */
export function gitRunner({ cwd, env } = {}) {
  return (args) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
}

/** The verdict for `<base> <head>`, reading the repository through `git`. */
export function rangeVerdict(base, head, git = gitRunner()) {
  const paths = parseNameStatus(
    git(['diff', '-z', '--no-color', '--name-status', '-M', base, head]),
  )
  const patch = git([
    'diff',
    '-U0',
    '-M',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    base,
    head,
    '--',
    '*.rs',
  ])
  const sections = parsePatch(patch)
  const seen = new Set(sections.flatMap((s) => [s.oldPath, s.newPath]))
  const missing = paths.find((path) => path.endsWith('.rs') && !seen.has(path))
  if (missing !== undefined) throw new Error(`${missing} is listed as changed but has no diff`)
  const show = (rev, path) => (path === null ? null : git(['show', `${rev}:${path}`]))
  for (const section of sections) {
    section.oldText = show(base, section.oldPath)
    section.newText = show(head, section.newPath)
  }
  return decide({ paths, files: sections, wrapper: findWrapper(head, git) })
}

function findWrapper(head, git) {
  let listed
  try {
    listed = git(['grep', '--no-color', '-lF', 'macro_rules!', head, '--', 'src-tauri/*.rs'])
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if (error.status === 1 && error.stdout === '') return null
    throw error
  }
  for (const entry of listed.split('\n').filter(Boolean)) {
    // Each line is `<head>:<path>`.
    const path = entry.slice(head.length + 1)
    const name = wrapperMacro(git(['show', `${head}:${path}`]))
    if (name !== null) return `${name} (${path})`
  }
  return null
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])

if (isMainModule) {
  const [base, head, ...extra] = process.argv.slice(2)
  if (!base || !head || extra.length > 0) {
    process.stderr.write('usage: sqlx-query-range.mjs <base> <head>\n')
    process.exit(2)
  }
  try {
    process.stdout.write(`${rangeVerdict(base, head)}\n`)
  } catch (error) {
    process.stderr.write(`sqlx-query-range: ${error.stderr || error.message}\n`)
    process.exit(1)
  }
}
