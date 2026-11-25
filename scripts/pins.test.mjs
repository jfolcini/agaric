// Tests for pins.txt, scripts/pins.mjs and scripts/pins.sh.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
// Every `describe()`/`it()` is `void`-ed: node:test's returned promise fulfils
// even when the test fails, so there is nothing to await.

import {
  FILE_PINS,
  UPSTREAMS,
  bumpText,
  compareVersions,
  expandUrl,
  filePinVersion,
  httpClient,
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
version other 2.0.0 crate:other
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
      () => parsePins(`version x 1 crate:x\nasset x any abc https://e.com/x`),
      /is not a sha256/,
    )
    assert.throws(
      () => parsePins(`version x 1 crate:x\nasset x any ${sha('a')} http://e.com/x`),
      /is not https/,
    )
    assert.throws(() => parsePins('version x 1 crate:x\nversion x 2 crate:x'), /two version lines/)
    assert.throws(() => parsePins('pin x 1 -'), /unknown line kind/)
  })

  void it('accepts the real pins.txt', () => {
    const { versions, assets } = parsePins(PINS)
    assert.ok(versions.size > 0 && assets.length > 0)
  })

  void it('gives every real pin an upstream the stale lane can read', () => {
    const { versions } = parsePins(PINS)
    for (const p of [...versions.values(), ...FILE_PINS]) {
      assert.ok(p.upstream.split(':')[0] in UPSTREAMS, `${p.name}: upstream ${p.upstream}`)
    }
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

  void it('tauri-bundler reads the AppImage tool names prepare_tools pins at the Tauri CLI tag', async () => {
    const packageLock = { packages: { 'node_modules/@tauri-apps/cli': { version: '2.12.4' } } }
    const http = fakeHttp({
      'tauri/@tauri-apps/cli-v2.12.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs':
        '  const LINUXDEPLOY_COMMIT_HASH: &str = "abc1234";\n' +
        '  "https://github.com/tauri-apps/binary-releases/releases/download/apprun-new/AppRun-{arch}"\n',
    })
    assert.deepEqual(await UPSTREAMS['tauri-bundler']('linuxdeploy', http, { packageLock }), {
      version: 'abc1234',
      exact: true,
    })
    assert.equal((await UPSTREAMS['tauri-bundler']('apprun', http, { packageLock })).version, 'new')
    await assert.rejects(UPSTREAMS['tauri-bundler']('nope', http, { packageLock }), /nope/)
  })

  void it('android-sdk takes the newest stable release of the package line, skipping release candidates', async () => {
    const pkg = (path, channel = 0) =>
      `<remotePackage path="${path}"><channelRef ref="channel-${channel}"/></remotePackage>`
    const http = fakeHttp({
      'repository2-3.xml':
        pkg('ndk;28.0.1') +
        pkg('ndk;27.3.1375', 2) +
        pkg('ndk;27.2.1247') +
        pkg('ndk;27.10.1') +
        pkg('build-tools;36.2.0-rc1') +
        pkg('build-tools;36.1.0'),
    })
    assert.equal((await UPSTREAMS['android-sdk']('ndk;27', http)).version, '27.10.1')
    assert.equal((await UPSTREAMS['android-sdk']('build-tools;36', http)).version, '36.1.0')
    await assert.rejects(UPSTREAMS['android-sdk']('ndk;26', http), /no stable ndk;26/)
  })

  void it('npm reads the latest dist-tag and its publish time', async () => {
    const http = fakeHttp({
      'registry.npmjs.org/npm': {
        'dist-tags': { latest: '12.3.0', next: '13.0.0-pre' },
        time: { '12.3.0': '2026-10-01T00:00:00Z' },
      },
    })
    assert.deepEqual(await UPSTREAMS.npm('npm', http), {
      version: '12.3.0',
      publishedAt: '2026-10-01T00:00:00Z',
    })
  })

  void it('pypi reads the newest version and its upload time', async () => {
    const http = fakeHttp({
      'pypi.org/pypi/tool/json': {
        info: { version: '2.4.0' },
        releases: { '2.4.0': [{ upload_time_iso_8601: '2026-10-01T00:00:00Z' }] },
      },
    })
    assert.deepEqual(await UPSTREAMS.pypi('tool', http), {
      version: '2.4.0',
      publishedAt: '2026-10-01T00:00:00Z',
    })
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
    'cli-v2.0.0/crates/tauri-bundler': 'const LINUXDEPLOY_COMMIT_HASH: &str = "0abc";',
  })
  const ctx = {
    packageLock: { packages: { 'node_modules/@tauri-apps/cli': { version: '2.0.0' } } },
  }
  void it('flags a release past the cooldown, holds one inside it, and fails closed on errors', async () => {
    const rows = await staleRows(
      [
        { name: 'old', version: '1.0.0', upstream: 'crate:old' },
        { name: 'fresh', version: '1.0.0', upstream: 'crate:fresh' },
        { name: 'same', version: '1.0.0', upstream: 'crate:same' },
        { name: 'ld-moved', version: '9fff', upstream: 'tauri-bundler:linuxdeploy' },
        { name: 'ld-same', version: '0abc', upstream: 'tauri-bundler:linuxdeploy' },
        { name: 'broken', version: '1', upstream: 'crate:missing' },
        { name: 'bogus', version: '1', upstream: 'nope:x' },
        { name: 'nightly-old', version: '2026-10-01', upstream: 'rust-nightly' },
        { name: 'nightly-new', version: '2026-11-10', upstream: 'rust-nightly' },
      ],
      http,
      { now: NOW, ctx },
    )
    assert.deepEqual(
      rows.map((r) => [r.name, r.status]),
      [
        ['old', 'stale'],
        ['fresh', 'cooling'],
        ['same', 'current'],
        ['ld-moved', 'stale'],
        ['ld-same', 'current'],
        ['broken', 'error'],
        ['bogus', 'error'],
        ['nightly-old', 'stale'],
        ['nightly-new', 'current'],
      ],
    )
    const md = staleMarkdown(rows)
    assert.match(md, /Pins behind upstream: 5/)
    assert.match(md, /^just pin-bump old 2\.0\.0$/m)
    assert.match(md, /^just pin-bump ld-moved 0abc$/m)
    assert.doesNotMatch(md, /pin-bump (fresh|same|ld-same|broken) /)
  })

  void it('names the file to edit for a stale pin pin-bump cannot write', () => {
    const md = staleMarkdown([
      { name: 'rust', pinned: '1.0.0', latest: '1.1.0', upstream: 'rust-stable', status: 'stale' },
    ])
    assert.match(md, /^# rust: edit rust-toolchain\.toml and its lockstep copies to 1\.1\.0$/m)
  })
})

void describe('httpClient', () => {
  void it('sends GITHUB_TOKEN to api.github.com only, not to a url that merely contains it', async () => {
    const sent = []
    const { fetch } = globalThis
    const token = process.env.GITHUB_TOKEN
    globalThis.fetch = (url, init) => {
      sent.push([url, init.headers.authorization])
      return Promise.resolve(new Response('{}'))
    }
    process.env.GITHUB_TOKEN = 't0k'
    try {
      const http = httpClient()
      await http.json('https://api.github.com/repos/o/r/releases/latest')
      await http.json('https://example.com/api.github.com/x')
      await http.json('https://api.github.com.example.com/x')
    } finally {
      globalThis.fetch = fetch
      if (token === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = token
    }
    assert.deepEqual(sent, [
      ['https://api.github.com/repos/o/r/releases/latest', 'Bearer t0k'],
      ['https://example.com/api.github.com/x', undefined],
      ['https://api.github.com.example.com/x', undefined],
    ])
  })
})

void describe('file pins', () => {
  void it('read the version each tool reads natively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-file-'))
    try {
      writeFileSync(join(dir, '.nvmrc'), '24.1.0\n')
      writeFileSync(join(dir, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.90.0"\n')
      writeFileSync(join(dir, 'package.json'), '{"name":"x","packageManager":"npm@12.2.0"}')
      writeFileSync(
        join(dir, '.mcp.json'),
        '{"mcpServers":{"g":{"command":"uvx","args":["code-review-graph@2.3.8","serve"]}}}',
      )
      assert.deepEqual(
        FILE_PINS.map((p) => [p.name, filePinVersion(p, dir)]),
        [
          ['node', '24.1.0'],
          ['rust', '1.90.0'],
          ['npm', '12.2.0'],
          ['code-review-graph', '2.3.8'],
        ],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

void describe('pins.sh fetch', () => {
  void it('accepts a download whose destination path holds a backslash, as on Windows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-fetch-'))
    try {
      const bytes = 'tool bytes'
      const digest = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(
        join(dir, 'pins.txt'),
        `version tool 1.0.0 -\nasset tool any ${digest} https://example.com/tool\n`,
      )
      // A curl stand-in that writes the bytes to its `-o` argument.
      const curl = join(dir, 'curl')
      writeFileSync(
        curl,
        `#!/usr/bin/env bash\nwhile [ "$1" != -o ]; do shift; done\nprintf %s '${bytes}' >"$2"\n`,
      )
      chmodSync(curl, 0o755)
      execFileSync(
        'bash',
        [join(ROOT, 'scripts/pins.sh'), 'fetch', 'tool', 'any', join(dir, 'a\\b')],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            PINS_FILE: join(dir, 'pins.txt'),
          },
          encoding: 'utf8',
        },
      )
      assert.equal(readFileSync(join(dir, 'a\\b'), 'utf8'), bytes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
  void it('hard-codes no version of a pinned tool in a `tool:` list, java-version, emulator-build or Android SDK package', () => {
    for (const f of files) {
      for (const line of readFileSync(join(ROOT, f), 'utf8').split('\n')) {
        const tool = line.match(/^\s*tool:\s*(.*)$/)?.[1]
        for (const entry of tool?.split(',') ?? []) {
          const [name, version] = entry.split('@')
          if (versions.has(name))
            assert.match(version ?? '', /steps\.pins\.outputs/, `${f}: ${entry.trim()}`)
        }
        if (/^\s*(java-version|emulator-build):|\b(ndk|build-tools)[;/]\d/.test(line))
          assert.match(line, /steps\.pins\.outputs/, `${f}: ${line.trim()}`)
      }
    }
  })
})
