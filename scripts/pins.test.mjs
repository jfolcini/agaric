// Tests for pins.txt, scripts/pins.mjs and scripts/pins.sh.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
// Every `describe()`/`it()` is `void`-ed: node:test's returned promise fulfils
// even when the test fails, so there is nothing to await.

import {
  UPSTREAMS,
  bumpText,
  compareVersions,
  expandUrl,
  parsePins,
  staleMarkdown,
  staleRows,
} from './pins.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const PINS = readFileSync(join(ROOT, 'pins.txt'), 'utf8')
const sha = (c) => c.repeat(64)

const FIXTURE = `# comment kept
version tool 1.0.0 crate:tool
asset   tool linux-x86_64 ${sha('a')} https://example.com/v{version}/tool-linux.tgz
asset   tool darwin-arm64 ${sha('b')} https://example.com/v{version}/tool-mac.tgz
version other 2.0.0 -
asset   other any ${sha('c')} https://example.com/other-{version}.sh
`

void describe('parsePins', () => {
  void it('reads versions and assets with their lines', () => {
    const { versions, assets } = parsePins(FIXTURE)
    assert.deepEqual(versions.get('tool'), {
      name: 'tool',
      version: '1.0.0',
      upstream: 'crate:tool',
      line: 1,
    })
    assert.equal(assets.length, 3)
    assert.equal(assets[1].platform, 'darwin-arm64')
  })

  void it('rejects an asset with no version line, a bad sha256 and a non-https url', () => {
    assert.throws(() => parsePins(`asset x any ${sha('a')} https://e.com/x`), /has no version line/)
    assert.throws(
      () => parsePins(`version x 1 -\nasset x any abc https://e.com/x`),
      /is not a sha256/,
    )
    assert.throws(
      () => parsePins(`version x 1 -\nasset x any ${sha('a')} http://e.com/x`),
      /is not https/,
    )
    assert.throws(() => parsePins('version x 1 -\nversion x 2 -'), /two version lines/)
    assert.throws(() => parsePins('pin x 1 -'), /unknown line kind/)
  })

  void it('accepts the real pins.txt', () => {
    const { versions, assets } = parsePins(PINS)
    assert.ok(versions.size > 0 && assets.length > 0)
  })
})

void describe('bumpText', () => {
  void it('rewrites only the named pin, recomputing each of its assets from the new url', async () => {
    const seen = []
    const out = await bumpText(FIXTURE, 'tool', '1.1.0', (url) => {
      seen.push(url)
      return Promise.resolve(url.endsWith('linux.tgz') ? sha('d') : sha('e'))
    })
    assert.deepEqual(seen, [
      'https://example.com/v1.1.0/tool-linux.tgz',
      'https://example.com/v1.1.0/tool-mac.tgz',
    ])
    const { versions, assets } = parsePins(out)
    assert.equal(versions.get('tool').version, '1.1.0')
    assert.deepEqual(
      assets.map((a) => a.sha256),
      [sha('d'), sha('e'), sha('c')],
    )
    assert.equal(versions.get('other').version, '2.0.0')
    assert.ok(out.startsWith('# comment kept\n'))
  })

  void it('refuses a name pins.txt does not list, and leaves the text alone when the download fails', async () => {
    await assert.rejects(
      bumpText(FIXTURE, 'nope', '1', () => Promise.resolve(sha('a'))),
      /no version line for nope/,
    )
    await assert.rejects(
      bumpText(FIXTURE, 'tool', '9', () => Promise.reject(new Error('GET failed'))),
      /GET failed/,
    )
  })
})

void describe('compareVersions', () => {
  void it('orders numerically across separators', () => {
    assert.equal(compareVersions('0.10.0', '0.9.2'), 1)
    assert.equal(compareVersions('17.0.21+9', '17.0.21+10'), -1)
    assert.equal(compareVersions('2026-11-10', '2026-11-10'), 0)
    assert.equal(compareVersions('16863232', '16740729'), 1)
  })
})

const fakeHttp = (routes) => ({
  json(url) {
    const hit = Object.entries(routes).find(([k]) => url.includes(k))
    return hit ? Promise.resolve(hit[1]) : Promise.reject(new Error(`no route for ${url}`))
  },
  text(url) {
    return this.json(url)
  },
})
const NOW = Date.parse('2026-11-18T00:00:00Z')

void describe('upstream readers', () => {
  void it('taiki reads the manifest at the pinned action sha, mapping taplo-cli/typos-cli', async () => {
    const http = fakeHttp({ 'abc/manifests/taplo.json': { latest: { version: '0.11.0' } } })
    assert.deepEqual(await UPSTREAMS.taiki('taplo-cli', http, { taikiSha: 'abc' }), {
      version: '0.11.0',
    })
  })

  void it('github strips the tag prefix and rejects a tag without it', async () => {
    const http = fakeHttp({
      'repos/o/r/releases/latest': {
        tag_name: 'lychee-v0.25.0',
        published_at: '2026-11-01T00:00:00Z',
      },
    })
    assert.equal((await UPSTREAMS.github('o/r@lychee-v', http)).version, '0.25.0')
    await assert.rejects(UPSTREAMS.github('o/r@v', http), /lacks prefix/)
  })

  void it('crate, temurin, node, rust-stable and the emulator parse their payloads', async () => {
    const http = fakeHttp({
      'crates.io/api/v1/crates/just': {
        crate: { max_stable_version: '1.60.0' },
        versions: [{ num: '1.60.0', created_at: '2026-10-01T00:00:00Z' }],
      },
      'feature_releases/17': [
        {
          version_data: { semver: '17.0.22+7' },
          binaries: [{ updated_at: '2026-11-01T00:00:00Z' }],
        },
      ],
      'nodejs.org': [
        { version: 'v25.0.0', date: '2026-10-01' },
        { version: 'v24.23.0', date: '2026-11-01' },
      ],
      'channel-rust-stable.toml':
        'date = "2026-11-01"\n[pkg.rust]\nversion = "1.100.0 (abc 2026-10-30)"\n',
      'repository2-3.xml':
        '<remotePackage path="emulator"><channelRef ref="channel-2"/><url>emulator-linux_x64-999.zip</url></remotePackage>' +
        '<remotePackage path="emulator"><channelRef ref="channel-0"/><url>emulator-linux_x64-123.zip</url></remotePackage>',
    })
    assert.equal((await UPSTREAMS.crate('just', http)).version, '1.60.0')
    assert.equal((await UPSTREAMS.temurin('17', http)).version, '17.0.22+7')
    assert.equal((await UPSTREAMS.node('24', http)).version, '24.23.0')
    assert.equal((await UPSTREAMS['rust-stable']('', http)).version, '1.100.0')
    assert.equal((await UPSTREAMS['android-emulator']('', http)).version, '123')
  })

  void it('lock reads the highest version of the crate in Cargo.lock', () => {
    const cargoLock = 'name = "sqlx"\nversion = "0.8.6"\n\nname = "sqlx"\nversion = "0.9.0"\n'
    assert.equal(UPSTREAMS.lock('sqlx', null, { cargoLock }).version, '0.9.0')
    assert.throws(() => UPSTREAMS.lock('nope', null, { cargoLock }), /has no nope/)
  })
})

void describe('staleRows', () => {
  const http = fakeHttp({
    'crates/old': {
      crate: { max_stable_version: '2.0.0' },
      versions: [{ num: '2.0.0', created_at: '2026-10-01T00:00:00Z' }],
    },
    'crates/fresh': {
      crate: { max_stable_version: '2.0.0' },
      versions: [{ num: '2.0.0', created_at: '2026-11-15T00:00:00Z' }],
    },
    'crates/same': { crate: { max_stable_version: '1.0.0' }, versions: [] },
    'nightly-date.txt': '2026-11-17\n',
  })
  void it('flags a release past the cooldown, holds one inside it, and fails closed on errors', async () => {
    const rows = await staleRows(
      [
        { name: 'old', version: '1.0.0', upstream: 'crate:old' },
        { name: 'fresh', version: '1.0.0', upstream: 'crate:fresh' },
        { name: 'same', version: '1.0.0', upstream: 'crate:same' },
        { name: 'tauri', version: 'x', upstream: '-' },
        { name: 'broken', version: '1', upstream: 'crate:missing' },
        { name: 'bogus', version: '1', upstream: 'nope:x' },
        { name: 'nightly-old', version: '2026-10-01', upstream: 'rust-nightly' },
        { name: 'nightly-new', version: '2026-11-10', upstream: 'rust-nightly' },
      ],
      http,
      { now: NOW },
    )
    assert.deepEqual(
      rows.map((r) => [r.name, r.status]),
      [
        ['old', 'stale'],
        ['fresh', 'cooling'],
        ['same', 'current'],
        ['tauri', 'unchecked'],
        ['broken', 'error'],
        ['bogus', 'error'],
        ['nightly-old', 'stale'],
        ['nightly-new', 'current'],
      ],
    )
    assert.match(staleMarkdown(rows), /Pins behind upstream: 4/)
  })
})

void describe('pins.sh agrees with pins.mjs on the real pins.txt', () => {
  const { versions, assets } = parsePins(PINS)
  const sh = (...args) =>
    execFileSync('bash', [join(ROOT, 'scripts/pins.sh'), ...args], { encoding: 'utf8' }).trim()
  void it('for every version and asset', () => {
    for (const v of versions.values()) assert.equal(sh('version', v.name), v.version, v.name)
    for (const a of assets.filter((x) => x.platform !== 'any')) {
      const version = versions.get(a.name).version
      assert.equal(
        sh('asset', a.name, a.platform),
        `${a.sha256} ${expandUrl(a.url, version)}`,
        `${a.name} ${a.platform}`,
      )
    }
  })
  void it('fails for an unknown name', () => {
    assert.throws(() => sh('version', 'no-such-pin'), /no `version no-such-pin` line/)
  })
})

void describe('workflows read versions from pins.txt', () => {
  const { versions } = parsePins(PINS)
  const outputs = new Set([...versions.keys()].map((n) => n.replaceAll('-', '_')))
  const dirs = [
    '.github/workflows',
    ...readdirSync(join(ROOT, '.github/actions')).map((d) => `.github/actions/${d}`),
  ]
  const files = dirs.flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => join(d, f)),
  )
  void it('names only pins that exist in `steps.pins.outputs.*`', () => {
    for (const f of files) {
      for (const [, name] of readFileSync(join(ROOT, f), 'utf8').matchAll(
        /steps\.pins\.outputs\.([\w]+)/g,
      )) {
        assert.ok(outputs.has(name), `${f}: steps.pins.outputs.${name} is not a pin in pins.txt`)
      }
    }
  })
  void it('hard-codes no version of a pinned tool in a `tool:` list, java-version or emulator-build', () => {
    for (const f of files) {
      for (const line of readFileSync(join(ROOT, f), 'utf8').split('\n')) {
        const tool = line.match(/^\s*tool:\s*(.*)$/)?.[1]
        for (const entry of tool?.split(',') ?? []) {
          const [name, version] = entry.split('@')
          if (versions.has(name))
            assert.match(version ?? '', /steps\.pins\.outputs/, `${f}: ${entry.trim()}`)
        }
        if (/^\s*(java-version|emulator-build):/.test(line))
          assert.match(line, /steps\.pins\.outputs/, `${f}: ${line.trim()}`)
      }
    }
  })
})
