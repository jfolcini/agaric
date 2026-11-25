#!/usr/bin/env node
// Bump and audit pins.txt (AGENTS.md § Supply-chain pinning). Lookups for bash
// and the workflows live in scripts/pins.sh; this file owns the two jobs that
// need the network:
//
//   node scripts/pins.mjs bump <name> <version>   rewrite the version and
//       recompute every asset's sha256 from the new download (fetched, never
//       run). `node` bumps .nvmrc, `npm` package.json's packageManager,
//       `code-review-graph` .mcp.json.
//   node scripts/pins.mjs stale                   list pins behind upstream;
//       exit 1 if any is, or if an upstream could not be read (fail closed).
//       A release younger than COOLDOWN_DAYS is reported, not flagged, the
//       same quarantine Dependabot and .npmrc apply.
//
// Zero dependencies, so it runs before `npm ci`.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, appendFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
export const COOLDOWN_DAYS = 7
export const NIGHTLY_MAX_AGE_DAYS = 28
const DAY_MS = 86_400_000

// Pins whose source of truth is a file a tool reads natively. `read` returns
// the version; `write`, where present, returns the file at a new version
// (rust also has lockstep copies, so it is bumped by hand).
export const FILE_PINS = [
  {
    name: 'node',
    file: '.nvmrc',
    upstream: 'node:24',
    read: (text) => text.trim(),
    write: (_text, version) => `${version}\n`,
  },
  {
    name: 'rust',
    file: 'rust-toolchain.toml',
    upstream: 'rust-stable',
    read: (text) => text.match(/^channel = "([^"]+)"/m)?.[1],
  },
  {
    name: 'npm',
    file: 'package.json',
    upstream: 'npm:npm',
    read: (text) => JSON.parse(text).packageManager?.match(/^npm@(.+)$/)?.[1],
    write: (text, version) =>
      text.replace(/"packageManager": "npm@[^"]+"/, `"packageManager": "npm@${version}"`),
  },
  {
    name: 'code-review-graph',
    file: '.mcp.json',
    upstream: 'pypi:code-review-graph',
    read: (text) => text.match(/"code-review-graph@([^"]+)"/)?.[1],
    write: (text, version) =>
      text.replace(/"code-review-graph@[^"]+"/, `"code-review-graph@${version}"`),
  },
]

/** Parse pins.txt into version and asset records, keeping line numbers. */
export function parsePins(text) {
  const versions = new Map()
  const assets = []
  text.split('\n').forEach((raw, line) => {
    const fields = raw.trim().split(/\s+/)
    if (fields[0] === 'version') {
      if (fields.length !== 4)
        throw new Error(`pins.txt:${line + 1}: want "version <name> <version> <upstream>"`)
      const [, name, version, upstream] = fields
      if (versions.has(name)) throw new Error(`pins.txt:${line + 1}: ${name} has two version lines`)
      versions.set(name, { name, version, upstream, line })
    } else if (fields[0] === 'asset') {
      if (fields.length !== 5)
        throw new Error(`pins.txt:${line + 1}: want "asset <name> <platform> <sha256> <url>"`)
      const [, name, platform, sha256, url] = fields
      if (!/^[0-9a-f]{64}$/.test(sha256))
        throw new Error(`pins.txt:${line + 1}: ${sha256} is not a sha256`)
      if (!url.startsWith('https://')) throw new Error(`pins.txt:${line + 1}: ${url} is not https`)
      assets.push({ name, platform, sha256, url, line })
    } else if (fields[0] !== '' && !fields[0].startsWith('#')) {
      throw new Error(`pins.txt:${line + 1}: unknown line kind "${fields[0]}"`)
    }
  })
  for (const a of assets) {
    if (!versions.has(a.name))
      throw new Error(`pins.txt:${a.line + 1}: asset ${a.name} has no version line`)
  }
  return { versions, assets }
}

export const expandUrl = (url, version) => url.replaceAll('{version}', version)

/**
 * Return pins.txt with `name` at `version` and every one of its assets'
 * sha256 recomputed by `sha256Of(url)`. Other lines are untouched.
 */
export async function bumpText(text, name, version, sha256Of) {
  const { versions, assets } = parsePins(text)
  const pin = versions.get(name)
  if (!pin) throw new Error(`pins.txt has no version line for ${name}`)
  const lines = text.split('\n')
  lines[pin.line] = lines[pin.line].replace(/^(\s*version\s+\S+\s+)\S+/, `$1${version}`)
  for (const a of assets.filter((x) => x.name === name)) {
    const sha = await sha256Of(expandUrl(a.url, version))
    lines[a.line] = lines[a.line].replace(a.sha256, sha)
  }
  return lines.join('\n')
}

/** Compare dotted/dashed versions numerically ("17.0.21+9", "2026-11-10"). */
export function compareVersions(a, b) {
  const pa = String(a)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
  const pb = String(b)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

// --- upstream readers: each takes the scheme argument and an `http` with
// `json(url)` / `text(url)`, and returns { version, publishedAt? } ----------

export function taikiShaFromWorkflows(root = ROOT) {
  const dir = join(root, '.github/workflows')
  for (const f of readdirSync(dir)) {
    const m = readFileSync(join(dir, f), 'utf8').match(/taiki-e\/install-action@([0-9a-f]{40})/)
    if (m) return m[1]
  }
  throw new Error('no taiki-e/install-action@<sha> in .github/workflows')
}

export const UPSTREAMS = {
  async taiki(tool, http, ctx) {
    const manifest = tool.replace(/^(taplo|typos)-cli$/, '$1')
    const sha = ctx.taikiSha ?? taikiShaFromWorkflows()
    const m = await http.json(
      `https://raw.githubusercontent.com/taiki-e/install-action/${sha}/manifests/${manifest}.json`,
    )
    return { version: m.latest.version }
  },
  async github(arg, http) {
    const [repo, prefix = ''] = arg.split('@')
    const r = await http.json(`https://api.github.com/repos/${repo}/releases/latest`)
    if (!r.tag_name.startsWith(prefix))
      throw new Error(`${repo}: tag ${r.tag_name} lacks prefix "${prefix}"`)
    return { version: r.tag_name.slice(prefix.length), publishedAt: r.published_at }
  },
  async crate(name, http) {
    const r = await http.json(`https://crates.io/api/v1/crates/${name}`)
    const version = r.crate.max_stable_version
    const v = r.versions?.find((x) => x.num === version)
    return { version, publishedAt: v?.created_at }
  },
  lock(crate, _http, ctx) {
    const lock = ctx.cargoLock ?? readFileSync(join(ROOT, 'src-tauri/Cargo.lock'), 'utf8')
    const found = [...lock.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"/gm)]
      .filter(([, n]) => n === crate)
      .map(([, , v]) => v)
      .toSorted(compareVersions)
    if (found.length === 0) throw new Error(`Cargo.lock has no ${crate}`)
    return { version: found.at(-1) }
  },
  // The AppImage tools tauri-bundler's `prepare_tools` downloads, as named at
  // the tag of the Tauri CLI package-lock.json resolves. Not a version line:
  // any difference means the CLI now fetches a file pins.txt does not verify.
  async 'tauri-bundler'(tool, http, ctx) {
    const lock =
      ctx.packageLock ?? JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
    const cli = lock.packages['node_modules/@tauri-apps/cli'].version
    const src = await http.text(
      `https://raw.githubusercontent.com/tauri-apps/tauri/@tauri-apps/cli-v${cli}/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs`,
    )
    const pattern = {
      apprun: /binary-releases\/releases\/download\/apprun-([^/]+)\//,
      linuxdeploy: /LINUXDEPLOY_COMMIT_HASH: &str = "([^"]+)"/,
    }[tool]
    const version = pattern && src.match(pattern)?.[1]
    if (!version) throw new Error(`no ${tool} in tauri-bundler's linuxdeploy.rs at CLI ${cli}`)
    return { version, exact: true }
  },
  // `ndk;27` is the newest stable 27.x NDK; release candidates share the
  // stable channel, so only all-numeric versions count.
  async 'android-sdk'(line, http) {
    const xml = await http.text('https://dl.google.com/android/repository/repository2-3.xml')
    const [pkg, major] = line.split(';')
    const found = [...xml.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)]
      .filter(
        ([, path, body]) =>
          path.startsWith(`${pkg};`) && body.includes('channelRef ref="channel-0"'),
      )
      .map(([, path]) => path.slice(pkg.length + 1))
      .filter((v) => v.startsWith(`${major}.`) && /^[0-9.]+$/.test(v))
      .toSorted(compareVersions)
    if (found.length === 0) throw new Error(`no stable ${line}.x in repository2-3.xml`)
    return { version: found.at(-1) }
  },
  async npm(name, http) {
    const r = await http.json(`https://registry.npmjs.org/${name}`)
    const version = r['dist-tags'].latest
    return { version, publishedAt: r.time[version] }
  },
  async pypi(name, http) {
    const r = await http.json(`https://pypi.org/pypi/${name}/json`)
    const version = r.info.version
    return { version, publishedAt: r.releases[version]?.[0]?.upload_time_iso_8601 }
  },
  async temurin(major, http) {
    const r = await http.json(
      `https://api.adoptium.net/v3/assets/feature_releases/${major}/ga?image_type=jdk&os=linux&architecture=x64&jvm_impl=hotspot&page_size=1&sort_order=DESC`,
    )
    return { version: r[0].version_data.semver, publishedAt: r[0].binaries[0].updated_at }
  },
  async 'android-emulator'(_arg, http) {
    const xml = await http.text('https://dl.google.com/android/repository/repository2-3.xml')
    for (const m of xml.matchAll(/<remotePackage path="emulator">([\s\S]*?)<\/remotePackage>/g)) {
      if (m[1].includes('channelRef ref="channel-0"')) {
        const build = m[1].match(/emulator-linux_x64-(\d+)\.zip/)
        if (build) return { version: build[1] }
      }
    }
    throw new Error('no stable-channel emulator in repository2-3.xml')
  },
  async 'rust-nightly'(_arg, http) {
    const date = (
      await http.text('https://static.rust-lang.org/dist/channel-rust-nightly-date.txt')
    ).trim()
    return { version: date, publishedAt: `${date}T00:00:00Z` }
  },
  async node(major, http) {
    const index = await http.json('https://nodejs.org/dist/index.json')
    const r = index.find((x) => x.version.startsWith(`v${major}.`))
    return { version: r.version.slice(1), publishedAt: r.date }
  },
  async 'rust-stable'(_arg, http) {
    const toml = await http.text('https://static.rust-lang.org/dist/channel-rust-stable.toml')
    const date = toml.match(/^date = "([^"]+)"/m)?.[1]
    const version = toml.match(/\[pkg\.rust\]\nversion = "([0-9.]+)/)?.[1]
    if (!version) throw new Error('no [pkg.rust] version in channel-rust-stable.toml')
    return { version, publishedAt: date && `${date}T00:00:00Z` }
  },
}

export function filePinVersion(pin, root = ROOT) {
  const version = pin.read(readFileSync(join(root, pin.file), 'utf8'))
  if (!version) throw new Error(`${pin.file}: no ${pin.name} version`)
  return version
}

/**
 * One row per pin: `status` is `current`, `stale`, `cooling` (newer release
 * younger than the cooldown) or `error`.
 */
export async function staleRows(pins, http, { now = Date.now(), ctx = {} } = {}) {
  const rows = []
  for (const pin of pins) {
    const row = { name: pin.name, pinned: pin.version, upstream: pin.upstream }
    rows.push(row)
    const [scheme, ...rest] = pin.upstream.split(':')
    const reader = UPSTREAMS[scheme]
    if (!reader) {
      row.status = 'error'
      row.note = `unknown upstream scheme "${scheme}"`
      continue
    }
    try {
      const latest = await reader(rest.join(':'), http, ctx)
      row.latest = latest.version
      const ageDays = latest.publishedAt
        ? (now - Date.parse(latest.publishedAt)) / DAY_MS
        : Infinity
      if (latest.exact) {
        row.status = latest.version === pin.version ? 'current' : 'stale'
      } else if (scheme === 'rust-nightly') {
        const pinAge = (now - Date.parse(`${pin.version}T00:00:00Z`)) / DAY_MS
        row.status = pinAge > NIGHTLY_MAX_AGE_DAYS ? 'stale' : 'current'
      } else if (compareVersions(latest.version, pin.version) <= 0) {
        row.status = 'current'
      } else {
        row.status = ageDays < COOLDOWN_DAYS ? 'cooling' : 'stale'
      }
    } catch (e) {
      row.status = 'error'
      row.note = e.message
    }
  }
  return rows
}

/** The command that bumps a stale row, or what to edit by hand. */
function bumpLine(r) {
  const file = FILE_PINS.find((p) => p.name === r.name)
  if (file && !file.write)
    return `# ${r.name}: edit ${file.file} and its lockstep copies to ${r.latest}`
  return `just pin-bump ${r.name} ${r.latest}`
}

export function staleMarkdown(rows) {
  const flagged = rows.filter((r) => r.status === 'stale' || r.status === 'error')
  const stale = rows.filter((r) => r.status === 'stale')
  const lines = [
    `## Pins behind upstream: ${flagged.length}`,
    '',
    'Bump with `just pin-bump <name> <version>` (it recomputes the sha256s); see AGENTS.md § Supply-chain pinning.',
    '',
    '| pin | pinned | upstream | status |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.name}\` | ${r.pinned} | ${r.latest ?? '—'} (${r.upstream}) | ${r.status}${r.note ? `: ${r.note}` : ''} |`,
    ),
    ...(stale.length > 0 ? ['', '```sh', ...stale.map(bumpLine), '```'] : []),
  ]
  return `${lines.join('\n')}\n`
}

// --- CLI --------------------------------------------------------------------

export function httpClient() {
  const headers = { 'user-agent': 'agaric-pins (https://github.com/jfolcini/agaric)' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const get = async (url) => {
    const res = await fetch(url, {
      headers:
        new URL(url).hostname === 'api.github.com'
          ? headers
          : { 'user-agent': headers['user-agent'] },
    })
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
    return res
  }
  return {
    json: async (url) => (await get(url)).json(),
    text: async (url) => (await get(url)).text(),
  }
}

async function sha256OfUrl(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
  return createHash('sha256')
    .update(Buffer.from(await res.arrayBuffer()))
    .digest('hex')
}

async function main(argv) {
  const pinsPath = join(ROOT, 'pins.txt')
  const [cmd, name, version] = argv
  if (cmd === 'bump') {
    if (!name || !version) throw new Error('usage: pins.mjs bump <name> <version>')
    const file = FILE_PINS.find((p) => p.name === name)
    if (file) {
      if (!file.write)
        throw new Error(
          `${name} is pinned in ${file.file} and its lockstep copies; bump it by hand`,
        )
      const path = join(ROOT, file.file)
      writeFileSync(path, file.write(readFileSync(path, 'utf8'), version))
      console.log(`${file.file}: ${version}`)
      return 0
    }
    const before = readFileSync(pinsPath, 'utf8')
    const after = await bumpText(before, name, version, sha256OfUrl)
    writeFileSync(pinsPath, after)
    console.log(`pins.txt: ${name} -> ${version}; review the sha256 diff before committing`)
    return 0
  }
  if (cmd === 'stale') {
    const { versions } = parsePins(readFileSync(pinsPath, 'utf8'))
    const pins = [...versions.values()]
    for (const p of FILE_PINS) pins.push(Object.assign({}, p, { version: filePinVersion(p) }))
    const rows = await staleRows(pins, httpClient())
    const md = staleMarkdown(rows)
    process.stdout.write(md)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
    return rows.some((r) => r.status === 'stale' || r.status === 'error') ? 1 : 0
  }
  throw new Error('usage: pins.mjs bump <name> <version> | stale')
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`pins.mjs: ${e.message}`)
      process.exit(1)
    },
  )
}
