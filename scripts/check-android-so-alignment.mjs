#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 16 KB page-alignment guard for the shipped Android native library (#4425).
//
// Android 15+ devices can boot with a 16 KB page size. On those the dynamic
// linker refuses to map a shared library whose ELF `PT_LOAD` segments are
// aligned to 4 KB, and the app does not start — there is no degraded mode.
// Google Play additionally requires 16 KB support for apps targeting Android
// 15+.
//
// The 0.9.9 release APK shipped 4 KB-aligned and nothing said so: the on-device
// "This app isn't 16 KB-compatible" dialog only appears for DEBUGGABLE builds,
// so the release build is silently identical and simply fails to launch on
// hardware we do not test on. That is the regression class this guard closes —
// it runs on the artifact the pipeline is about to upload/sign, so a
// misaligned APK cannot reach a release again.
//
// The fix it protects lives in `src-tauri/build.rs`, which emits
// `cargo::rustc-link-arg=-Wl,-z,max-page-size=16384` when
// `CARGO_CFG_TARGET_OS == "android"`.
//
// ─── What it checks ──────────────────────────────────────────────────────────
//
// For every native library examined, EVERY `PT_LOAD` program header must have
// `p_align >= 0x4000` (16384) and be a power of two. Per-segment, not "the
// biggest one is fine": the linker aligns all LOAD segments together, and a
// single 4 KB segment is the failure the linker rejects.
//
// Evidence comes from `readelf -lW`, the same command the issue used, so the
// guard's verdict and a human's spot check read the identical bytes.
//
// When the artifact is an APK, a second condition applies to any library the
// APK STORES uncompressed (`extractNativeLibs=false`, the AGP default at our
// minSdk — 0.9.9's APK stores it): the loader mmaps that entry in place, so
// its payload must also BEGIN on a 16 KB boundary. That one is zipalign's
// job, not the linker's, and the two are reported separately so a failure is
// never blamed on the wrong step. Note that `zipalign -p` is documented as
// "4kb page-align uncompressed .so files" and cannot be combined with `-P`;
// the 16 KB form is `zipalign -P 16 -f 4`.
//
// Three of this guard's four CI call sites (both `ci.yml` steps, and
// `release.yml`'s pre-signing step) run this ZIP-offset half BEFORE
// zipalign — `ci.yml` never runs it at all. That offset is then whatever
// AGP's own packaging produced, which this pipeline does not control.
// Measured against this repo's actual gradle output (AGP 8.11.0, minSdk 30,
// #4425 review note 2): both the debug and release universal APKs already
// store `libagaric_lib.so` 16 KB-aligned pre-zipalign, so today these steps
// pass on AGP's own alignment, not on anything zipalign does later. This is
// not verified for any earlier AGP version — if a downgrade ever reintroduces
// a pre-zipalign offset finding on one of those three steps, that is a
// packaging-config regression, not a bug in this guard or in zipalign's
// invocation; the `--stage=pre-zipalign` remediation text below says so.
//
// ─── Why it cannot silently pass ─────────────────────────────────────────────
//
// Every path that cannot answer the question is a FAILURE, never a pass:
// no arguments, a path that does not exist, an APK with no `lib/<abi>/*.so`
// entries, a zip shape this reader does not understand (zip64, an unknown
// compression method, a CRC mismatch), no `readelf` on PATH, `readelf`
// exiting non-zero, output with no `Program Headers:` block, a file with zero
// `LOAD` segments, or a `LOAD` line whose column shape is not the one parsed
// here. Classification is POSITIVE throughout: a `LOAD` line is accepted only
// when it matches the full expected column layout, so an unrecognised
// `readelf` output shape reports "could not verify" instead of matching
// nothing and reading as clean. An empty result set is absence of evidence.
//
// ─── Exit codes — deliberately NOT the usual 0/1/2 ───────────────────────────
//
//   0 — VERIFIED CLEAN: every LOAD segment of every library examined is
//       aligned to at least 0x4000.
//   2 — VERIFIED A FINDING: a LOAD segment is aligned below 0x4000. This is
//       an observation about the artifact.
//   3 — VERIFIED NOTHING: the check itself could not run (see the list
//       above). Not a verdict on the artifact — the caller must render it as
//       "could not verify", never as "misaligned".
//   1 — NEVER emitted deliberately. `1` is node's own exit code for an
//       uncaught exception and for a failed module import, so a guard that
//       used `1` for a finding would make a crash indistinguishable from an
//       observation, and the CI step would report a misalignment it never
//       saw. The house `.mjs` convention is 0/1/2; this guard departs from it
//       for exactly that reason, and `--self-test` asserts both that `1` is
//       node's crash code and that no contract code equals it. A caller
//       seeing `1` must say "the guard crashed", not "the library is
//       misaligned".
//
// In `--self-test` mode the codes describe the guard instead of an artifact:
// 0 = every assertion passed, 2 = an assertion failed.
//
// Usage:
//   node scripts/check-android-so-alignment.mjs [--stage=pre-zipalign|post-zipalign] <path>...
//   node scripts/check-android-so-alignment.mjs --self-test
//
// `--stage` only changes the ZIP-offset remediation text on a finding — it
// tells the guard whether zipalign has already run on what it was given, so
// it can point at the right fix (an AGP/packaging setting pre-zipalign, the
// signing step post-zipalign) instead of always blaming release.yml's
// signing step, which three of this repo's four call sites run before.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** Android's 16 KB page size, the minimum acceptable `p_align`. */
export const REQUIRED_ALIGN = 0x4000

/**
 * The `.so` that `src-tauri/build.rs` actually controls the link flags for.
 * Everything else this guard finds under `lib/<abi>/*.so` — a third-party
 * native library pulled in via an AAR, say — arrives through some other
 * build step, and the build.rs remediation text does not apply to it.
 */
export const OUR_SO_BASENAME = 'libagaric_lib.so'

export const EXIT_OK = 0
export const EXIT_FINDING = 2
export const EXIT_UNVERIFIED = 3

/**
 * Thrown for every "the check could not run" case. Distinct from a finding by
 * type, not by a string match, so a new unverifiable case cannot accidentally
 * be reported as a misaligned library.
 */
export class Unverifiable extends Error {}

// ─── ELF ─────────────────────────────────────────────────────────────────────

/**
 * Locate a `readelf` capable of printing program headers.
 *
 * `readelf` (binutils) is present on the GitHub `ubuntu-*` images; `llvm-readelf`
 * is the NDK's equivalent and is accepted so the guard also runs on a machine
 * that only has the Android toolchain. `READELF` overrides both.
 */
export function findReadelf(env = process.env) {
  const candidates = [
    env.READELF,
    'readelf',
    'llvm-readelf',
    env.NDK_HOME && join(env.NDK_HOME, 'toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf'),
  ].filter(Boolean)
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return bin
  }
  throw new Unverifiable(
    `no usable readelf found (tried: ${candidates.join(', ')}). Install binutils, or set ` +
      'READELF to an llvm-readelf. Without it this guard verifies nothing.',
  )
}

/**
 * A `readelf -lW` LOAD row, matched in full rather than by "take the last
 * column". Five hex fields (Offset, VirtAddr, PhysAddr, FileSiz, MemSiz), the
 * flag letters, then Align. A row that does not match this exactly is reported
 * as an unrecognised shape rather than skipped.
 */
const LOAD_LINE =
  /^\s*LOAD\s+(?:0x[0-9a-fA-F]+\s+){5}[RWEX](?:\s?[RWEX])*\s+(?<align>0x[0-9a-fA-F]+)\s*$/

/**
 * Extract the `p_align` of every `PT_LOAD` header from `readelf -lW` output.
 *
 * @param {string} out  raw readelf stdout
 * @param {string} label  what to name in error messages
 * @returns {number[]} one alignment per LOAD segment, in file order
 */
export function parseLoadAlignments(out, label) {
  if (!out.includes('Program Headers:')) {
    throw new Unverifiable(
      `${label}: readelf printed no "Program Headers:" block — not an ELF file with ` +
        'program headers, or an unrecognised readelf output shape. Verified nothing.',
    )
  }
  const aligns = []
  for (const line of out.split('\n')) {
    if (!/^\s*LOAD\b/.test(line)) continue
    const m = line.match(LOAD_LINE)
    if (!m?.groups) {
      throw new Unverifiable(
        `${label}: unrecognised LOAD row shape from readelf, refusing to guess:\n  ${line.trim()}`,
      )
    }
    aligns.push(Number.parseInt(m.groups.align, 16))
  }
  if (aligns.length === 0) {
    throw new Unverifiable(
      `${label}: readelf reported zero LOAD segments. A library with no LOAD segment is not ` +
        'the artifact this guard was pointed at. Verified nothing.',
    )
  }
  return aligns
}

/**
 * Check one on-disk ELF file.
 *
 * @param {string} path
 * @param {string} label
 * @param {string} readelfBin
 * @param {{own?: boolean}} [opts]  `own: true` when this is
 *   {@link OUR_SO_BASENAME}, i.e. the library `src-tauri/build.rs`'s linker
 *   flag actually reaches — carried through so the caller can attribute an
 *   ELF finding correctly instead of always blaming our own build script.
 * @returns {{label: string, aligns: number[], bad: {index: number, align: number}[], own: boolean}}
 */
export function checkElfFile(path, label, readelfBin, { own = true } = {}) {
  if (!existsSync(path)) {
    throw new Unverifiable(`${label}: no such file: ${path}. Verified nothing.`)
  }
  const res = spawnSync(readelfBin, ['-lW', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.error) {
    throw new Unverifiable(`${label}: could not run ${readelfBin}: ${res.error.message}`)
  }
  if (res.status !== 0) {
    throw new Unverifiable(
      `${label}: ${readelfBin} exited ${res.status}:\n${(res.stderr || '').trim()}`,
    )
  }
  const aligns = parseLoadAlignments(res.stdout ?? '', label)
  const bad = []
  aligns.forEach((align, index) => {
    const isPowerOfTwo = align > 0 && (align & (align - 1)) === 0
    if (!isPowerOfTwo || align < REQUIRED_ALIGN) bad.push({ index, align })
  })
  return { label, aligns, bad, own }
}

// ─── Minimal zip reader (APKs) ───────────────────────────────────────────────
//
// Pure Node so the guard needs no `unzip` on the runner, and so `--self-test`
// can build its own APK fixtures without a `zip` binary. Store (0) and deflate
// (8) only; anything else, and every zip64 marker, is "verified nothing".

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const SIG_EOCD = 0x06054b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50
const ZIP64_SENTINEL_16 = 0xffff
const ZIP64_SENTINEL_32 = 0xffffffff

/** Parse the central directory. Returns one record per entry. */
export function zipEntries(buf, label) {
  // Scan back for the end-of-central-directory record (a trailing comment is
  // legal, so its offset is not fixed).
  let eocd = -1
  const floor = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new Unverifiable(`${label}: no zip end-of-central-directory record — not an APK/zip.`)
  }
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (
    count === ZIP64_SENTINEL_16 ||
    cdSize === ZIP64_SENTINEL_32 ||
    cdOffset === ZIP64_SENTINEL_32
  ) {
    throw new Unverifiable(
      `${label}: zip64 container — this reader does not support it, so it verified nothing. ` +
        'Extract the libraries and point the guard at the .so files instead.',
    )
  }

  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) {
      throw new Unverifiable(`${label}: malformed central directory at entry ${i}.`)
    }
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (
      compSize === ZIP64_SENTINEL_32 ||
      uncompSize === ZIP64_SENTINEL_32 ||
      localOffset === ZIP64_SENTINEL_32
    ) {
      throw new Unverifiable(`${label}: entry "${name}" uses zip64 fields — verified nothing.`)
    }
    entries.push({ name, method, crc, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Byte offset of an entry's payload, i.e. where the loader would mmap it. */
export function zipDataOffset(buf, entry, label) {
  const p = entry.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOC) {
    throw new Unverifiable(`${label}: entry "${entry.name}" has no local file header.`)
  }
  return p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
}

/** Read one entry's bytes, verifying its CRC. */
export function zipRead(buf, entry, label) {
  const start = zipDataOffset(buf, entry, label)
  const raw = buf.subarray(start, start + entry.compSize)
  let data
  if (entry.method === 0) data = raw
  else if (entry.method === 8) data = inflateRawSync(raw)
  else {
    throw new Unverifiable(
      `${label}: entry "${entry.name}" uses compression method ${entry.method}; this reader ` +
        'understands only store (0) and deflate (8). Verified nothing.',
    )
  }
  if (data.length !== entry.uncompSize || crc32(data) !== entry.crc) {
    throw new Unverifiable(`${label}: entry "${entry.name}" failed its CRC/size check.`)
  }
  return data
}

/** `lib/<abi>/<name>.so` — the layout Android loads native code from. */
export const NATIVE_LIB_ENTRY = /^lib\/[^/]+\/[^/]+\.so$/

/** Check every native library packaged inside an APK. */
export function checkApk(path, readelfBin) {
  const label = basename(path)
  if (!existsSync(path)) {
    throw new Unverifiable(`${label}: no such file: ${path}. Verified nothing.`)
  }
  const buf = readFileSync(path)
  const libs = zipEntries(buf, label).filter((e) => NATIVE_LIB_ENTRY.test(e.name))
  if (libs.length === 0) {
    throw new Unverifiable(
      `${label}: contains no lib/<abi>/*.so entries. Either this is not the APK that ships ` +
        'the native library, or the packaging changed — either way nothing was verified.',
    )
  }
  const tmp = mkdtempSync(join(tmpdir(), 'so-align-'))
  try {
    return libs.map((entry) => {
      // `NATIVE_LIB_ENTRY`'s `[^/]+` ABI/name segments admit a backslash, so
      // an untrusted APK's entry name could contain `..\` — inert on Linux,
      // where `\` is just another filename byte, but a `\`-aware `join`
      // (Windows) would climb out of `tmp`. Strip BOTH separators so the
      // written basename can never contain one, `..` included: with no `/`
      // or `\` left, `..` is an ordinary three-byte filename component, not
      // a traversal.
      const out = join(tmp, entry.name.replaceAll(/[/\\]/g, '_'))
      writeFileSync(out, zipRead(buf, entry, label))
      const result = checkElfFile(out, `${label}!${entry.name}`, readelfBin, {
        own: basename(entry.name) === OUR_SO_BASENAME,
      })
      // The second half of 16 KB compatibility. A STORED (uncompressed) native
      // library is mmap'd straight out of the APK — `extractNativeLibs=false`,
      // the AGP default at our minSdk — so the loader needs its payload to
      // START on a 16 KB boundary as well as to be internally 16 KB-aligned.
      // A DEFLATED entry is extracted to the filesystem first, where its
      // position in the zip is irrelevant, so it is not judged here.
      if (entry.method === 0) {
        const offset = zipDataOffset(buf, entry, label)
        result.zipOffset = offset
        if (offset % REQUIRED_ALIGN !== 0) result.zipMisaligned = true
      }
      return result
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const hex = (n) => `0x${n.toString(16)}`

/**
 * Optional `--stage=` values a caller may pass so the ZIP-offset
 * remediation text can name what actually ran, instead of always pointing
 * at `release.yml`'s signing step regardless of which of the four call
 * sites hit it. `checkApk`'s offset check runs on whatever bytes it is
 * given; only the *caller* knows whether zipalign has touched them yet.
 */
const ZIP_STAGES = new Set(['pre-zipalign', 'post-zipalign'])

export function main(argv) {
  const flags = argv.filter((a) => a.startsWith('--'))
  const paths = argv.filter((a) => !a.startsWith('--'))
  const stageFlags = flags.filter((a) => a.startsWith('--stage='))
  const unknown = flags.filter((a) => !a.startsWith('--stage='))
  if (unknown.length > 0) {
    throw new Unverifiable(`unknown option(s): ${unknown.join(' ')}`)
  }
  if (stageFlags.length > 1) {
    throw new Unverifiable(`--stage may be given at most once, got: ${stageFlags.join(' ')}`)
  }
  const stage = stageFlags[0]?.slice('--stage='.length)
  if (stage !== undefined && !ZIP_STAGES.has(stage)) {
    throw new Unverifiable(
      `unknown --stage value "${stage}" (expected one of: ${[...ZIP_STAGES].join(', ')})`,
    )
  }
  if (paths.length === 0) {
    throw new Unverifiable(
      'no paths given. Usage: check-android-so-alignment.mjs <app.apk|lib.so>... — a run with ' +
        'nothing to examine verifies nothing and is never a pass.',
    )
  }

  const readelfBin = findReadelf()
  const results = []
  for (const path of paths) {
    if (path.endsWith('.apk')) results.push(...checkApk(path, readelfBin))
    else {
      results.push(
        checkElfFile(path, basename(path), readelfBin, {
          own: basename(path) === OUR_SO_BASENAME,
        }),
      )
    }
  }

  const failed = results.filter((r) => r.bad.length > 0 || r.zipMisaligned)
  if (failed.length > 0) {
    console.error(`ERROR: 16 KB page-alignment check FAILED for ${failed.length} library(ies):`)
    let anyOwnElf = false
    let anyOtherElf = false
    let anyZip = false
    for (const r of failed) {
      console.error(`  ${r.label}`)
      for (const { index, align } of r.bad) {
        if (r.own) anyOwnElf = true
        else anyOtherElf = true
        console.error(
          `    ELF: LOAD[${index}] p_align ${hex(align)} (${align}) — needs >= ` +
            `${hex(REQUIRED_ALIGN)} (${REQUIRED_ALIGN})`,
        )
      }
      if (r.zipMisaligned) {
        anyZip = true
        console.error(
          `    ZIP: stored at APK offset ${hex(r.zipOffset)} (${r.zipOffset}), not a multiple of ` +
            `${hex(REQUIRED_ALIGN)} — the loader mmaps this entry in place`,
        )
      }
    }
    console.error(
      '\nAndroid 15+ devices can boot with a 16 KB page size. The dynamic linker refuses to\n' +
        'map a 4 KB-aligned library, so the app does not start at all on those devices, and\n' +
        'Google Play requires 16 KB support for apps targeting Android 15+ (#4425).',
    )
    // `own` (this run's own libagaric_lib.so) and "other" (anything else
    // under lib/<abi>/*.so — e.g. a third-party library arriving via an
    // AAR) are attributed separately: src-tauri/build.rs's linker flag has
    // no influence over a library it never links.
    if (anyOwnElf) {
      console.error(
        `\nELF alignment for ${OUR_SO_BASENAME} is set by the flag src-tauri/build.rs emits:\n` +
          '  cargo::rustc-link-arg=-Wl,-z,max-page-size=16384   (when target_os == "android")\n' +
          "If that is still in place, the Android link is no longer going through this crate's\n" +
          'build script — check what changed about how the .so is produced.',
      )
    }
    if (anyOtherElf) {
      console.error(
        `\nAt least one misaligned library above is not ${OUR_SO_BASENAME}, so src-tauri/` +
          "build.rs's linker flag has no effect on it — it most likely arrived through a Gradle " +
          "dependency or AAR rather than this crate's own build. Check whatever brings that " +
          'library into the APK for its own 16 KB alignment support.',
      )
    }
    if (anyZip) {
      const mechanism =
        '\nAPK offset alignment is set by zipalign. `zipalign -p` page-aligns .so entries to\n' +
        '4 KB and CANNOT be combined with `-P`; the 16 KB form is `zipalign -P 16 -f 4 …`\n' +
        '(build-tools 35+).'
      if (stage === 'pre-zipalign') {
        console.error(
          `${mechanism}\nThis check ran BEFORE zipalign (or on a workflow that never runs it) — ` +
            "the offset here is whatever AGP's own packaging produced, not something any step " +
            'in this pipeline set. Look at the AGP version / packaging config that built this ' +
            'APK, not at a signing step.',
        )
      } else if (stage === 'post-zipalign') {
        console.error(
          `${mechanism}\nThis check ran on the zipalign/signing output — see the "Sign Android ` +
            'APK" step in .github/workflows/release.yml.',
        )
      } else {
        console.error(
          `${mechanism}\nThis guard was not told which stage it ran at (no --stage flag) — check ` +
            'whichever step packages, zipaligns, or signs this exact artifact.',
        )
      }
    }
    return EXIT_FINDING
  }

  const segments = results.reduce((n, r) => n + r.aligns.length, 0)
  console.log(
    `OK: ${results.length} native library(ies), ${segments} LOAD segment(s), every one aligned ` +
      `>= ${hex(REQUIRED_ALIGN)} (16 KB)`,
  )
  for (const r of results) {
    const distinct = [...new Set(r.aligns)].map(hex).join(', ')
    const zip =
      r.zipOffset === undefined ? '' : `, stored 16 KB-aligned at APK offset ${hex(r.zipOffset)}`
    console.log(`  ${r.label}: ${r.aligns.length} LOAD segment(s), p_align ${distinct}${zip}`)
  }
  return EXIT_OK
}

// ─── Self-test ───────────────────────────────────────────────────────────────

/**
 * Build a valid little-endian ELF64 shared object carrying `aligns.length`
 * PT_LOAD program headers with the given `p_align` values, so readelf parses it
 * for real. Synthetic rather than a checked-in fixture: the fixture is the
 * exact variable under test, and a binary blob in git would drift.
 */
export function synthElf(aligns, { machine = 183 } = {}) {
  const EHSIZE = 64
  const PHENTSIZE = 56
  const eh = Buffer.alloc(EHSIZE)
  eh.write('\x7FELF', 0, 'binary')
  eh[4] = 2 // ELFCLASS64
  eh[5] = 1 // ELFDATA2LSB
  eh[6] = 1 // EV_CURRENT
  eh.writeUInt16LE(3, 16) // e_type = ET_DYN
  eh.writeUInt16LE(machine, 18) // e_machine (183 = EM_AARCH64)
  eh.writeUInt32LE(1, 20) // e_version
  eh.writeBigUInt64LE(BigInt(EHSIZE), 32) // e_phoff
  eh.writeUInt16LE(EHSIZE, 52) // e_ehsize
  eh.writeUInt16LE(PHENTSIZE, 54) // e_phentsize
  eh.writeUInt16LE(aligns.length, 56) // e_phnum
  eh.writeUInt16LE(64, 58) // e_shentsize

  const phdrs = aligns.map((align, i) => {
    const ph = Buffer.alloc(PHENTSIZE)
    ph.writeUInt32LE(1, 0) // p_type = PT_LOAD
    ph.writeUInt32LE(i === 0 ? 4 : 5, 4) // p_flags: R, then R+E
    ph.writeBigUInt64LE(0n, 8) // p_offset
    ph.writeBigUInt64LE(BigInt(i * 0x10000), 16) // p_vaddr
    ph.writeBigUInt64LE(BigInt(i * 0x10000), 24) // p_paddr
    ph.writeBigUInt64LE(0x100n, 32) // p_filesz
    ph.writeBigUInt64LE(0x100n, 40) // p_memsz
    ph.writeBigUInt64LE(BigInt(align), 48) // p_align
    return ph
  })
  return Buffer.concat([eh, ...phdrs, Buffer.alloc(0x200)])
}

/**
 * Build a store-only zip from `[name, Buffer]` pairs.
 *
 * `alignSo` reproduces what zipalign does for uncompressed native libraries:
 * pad the local header's extra field so the payload starts on a 16 KB
 * boundary. Off, it reproduces an APK that was never page-aligned.
 */
export function synthZip(files, { alignSo = true } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    let extra = Buffer.alloc(0)
    if (alignSo && NATIVE_LIB_ENTRY.test(name)) {
      let pad =
        (REQUIRED_ALIGN - ((offset + 30 + nameBuf.length) % REQUIRED_ALIGN)) % REQUIRED_ALIGN
      // An extra field needs its own 4-byte header, so a shortfall borrows a
      // whole further page rather than emitting a truncated field.
      while (pad !== 0 && pad < 4) pad += REQUIRED_ALIGN
      if (pad > 0) {
        extra = Buffer.alloc(pad)
        extra.writeUInt16LE(0xd935, 0) // the id zipalign itself uses
        extra.writeUInt16LE(pad - 4, 2)
      }
    }
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(SIG_LOC, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(0, 8) // method = store
    loc.writeUInt32LE(crc, 14)
    loc.writeUInt32LE(data.length, 18)
    loc.writeUInt32LE(data.length, 22)
    loc.writeUInt16LE(nameBuf.length, 26)
    loc.writeUInt16LE(extra.length, 28)
    locals.push(loc, nameBuf, extra, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(SIG_CEN, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 10) // method = store
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += 30 + nameBuf.length + extra.length + data.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function runSelfTest() {
  const failures = []
  let skipped = 0
  const check = (cond, name, detail) => {
    if (cond) return console.log(`  ok   - ${name}`)
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const skip = (name, reason) => {
    skipped++
    console.log(`  skip - ${name}: ${reason}`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'so-align-selftest-'))
  const self = realpathSync(import.meta.filename)
  // Run through a real child process so the assertions are about the exit
  // codes the CI step actually observes, not about a return value.
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [self, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })

  const write = (name, buf) => {
    const p = join(dir, name)
    writeFileSync(p, buf)
    return p
  }

  // Most assertions below run the guard against real ELF/APK fixtures, which
  // needs a real `readelf` on THIS machine — a self-test convenience, and a
  // different question from whether the guard has one when it runs for
  // real. macOS ships neither `readelf` nor `llvm-readelf` on the default
  // PATH, and this hook's *other* trigger paths are ci.yml/release.yml —
  // files with nothing to do with Android — so a contributor editing only
  // those would otherwise hard-fail a self-test that has nothing to say
  // about their change. When none is found here, the fixture assertions are
  // SKIPPED (counted separately, never as a pass) instead of failing the
  // hook. This does NOT touch the guard's own contract: `findReadelf()` is
  // unchanged, and `main()` still throws `Unverifiable` → exit 3 ("verified
  // nothing") whenever IT cannot find a readelf, self-test or not. The "no
  // readelf on PATH" assertion below is what proves that contract, and it
  // always runs — it forces a readelf-less environment onto the CHILD
  // process regardless of what this machine has, so the skip here can never
  // launder into "the guard passes with no readelf".
  let readelfBin = null
  try {
    readelfBin = findReadelf()
  } catch (err) {
    console.warn(`\nself-test: ${err.message}`)
    console.warn('self-test: skipping the assertions that need a real readelf.\n')
  }

  try {
    // ── the contract's codes cannot alias node's own crash code ──────────────
    const crash = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "import 'node:definitely-not-a-real-module'"],
      { encoding: 'utf8' },
    )
    check(
      crash.status === 1,
      'node exits 1 on a failed import, so 1 is unusable for a finding',
      `got ${crash.status}`,
    )
    check(
      EXIT_FINDING !== 1 && EXIT_UNVERIFIED !== 1 && EXIT_OK !== 1,
      "no contract exit code equals node's crash code",
      `finding=${EXIT_FINDING} unverified=${EXIT_UNVERIFIED} ok=${EXIT_OK}`,
    )

    const good = write('good.so', synthElf([0x4000, 0x4000, 0x4000, 0x4000]))

    // Split out of runSelfTest's own body (rather than inlined under the
    // `if` below) so eslint's per-function complexity count does not lump
    // these branches in with the rest of the self-test.
    function runElfFixtureAssertions() {
      // ── verified clean ─────────────────────────────────────────────────────
      let r = run([good])
      check(r.status === EXIT_OK, 'a 16 KB-aligned .so exits 0', `${r.status}: ${r.stderr}`)
      check(
        r.stdout.includes('0x4000') && r.stdout.includes('4 LOAD segment'),
        'the clean report names the alignment and the segment count it saw',
        r.stdout,
      )

      // ── verified a finding ─────────────────────────────────────────────────
      const bad = write('bad.so', synthElf([0x1000, 0x1000]))
      r = run([bad])
      check(
        r.status === EXIT_FINDING,
        'a 4 KB-aligned .so exits 2, not 1',
        `${r.status}: ${r.stderr}`,
      )
      check(
        r.stderr.includes('p_align 0x1000') && r.stderr.includes('#4425'),
        'the finding names the observed alignment and the issue',
        r.stderr,
      )

      // A single bad segment among good ones must still fail: the linker
      // aligns all LOAD segments, and "the largest is fine" is exactly the
      // check that would have waved 0.9.9 through if it looked only at the
      // maximum.
      const mixed = write('mixed.so', synthElf([0x4000, 0x1000, 0x4000]))
      r = run([mixed])
      check(
        r.status === EXIT_FINDING && r.stderr.includes('LOAD[1]'),
        'one 4 KB segment among 16 KB ones is still a finding, and is named by index',
        `${r.status}: ${r.stderr}`,
      )

      // A power-of-two check, so a nonsense p_align cannot pass by being large.
      r = run([write('odd.so', synthElf([0x5000]))])
      check(
        r.status === EXIT_FINDING,
        'a non-power-of-two p_align above 0x4000 is a finding, not a pass',
        `${r.status}: ${r.stderr}`,
      )

      // ── verified nothing (fixture-dependent cases) ───────────────────────────
      r = run([join(dir, 'absent.so')])
      check(
        r.status === EXIT_UNVERIFIED,
        'a missing file is exit 3, not a pass',
        `${r.status}: ${r.stderr}`,
      )
      r = run([write('garbage.so', Buffer.from('not an elf at all'))])
      check(
        r.status === EXIT_UNVERIFIED,
        'a non-ELF file is exit 3, not a pass',
        `${r.status}: ${r.stderr}`,
      )
      r = run([write('noload.so', synthElf([]))])
      check(
        r.status === EXIT_UNVERIFIED && /Verified nothing/.test(r.stderr),
        'an ELF with zero LOAD segments is exit 3, not a vacuous pass',
        `${r.status}: ${r.stderr}`,
      )
    }

    if (readelfBin) {
      runElfFixtureAssertions()
    } else {
      skip(
        'verified-clean / verified-finding / fixture-dependent verified-nothing assertions',
        'no readelf on this machine',
      )
    }

    // ── verified nothing (readelf-independent cases) ───────────────────────────
    // These fail before the guard ever looks for readelf, so they hold
    // regardless of whether this machine has one.
    let r = run([])
    check(
      r.status === EXIT_UNVERIFIED && /verifies nothing/.test(r.stderr),
      'no arguments is exit 3 (verified nothing), never a pass',
      `${r.status}: ${r.stderr}`,
    )
    r = run(['--bogus', good])
    check(
      r.status === EXIT_UNVERIFIED,
      'an unknown option is exit 3, not silently ignored',
      `${r.status}`,
    )
    // The same emptiness one layer in: a real "Program Headers:" table that
    // happens to contain no LOAD row (only NOTE/DYNAMIC/…). Exercised directly
    // because readelf omits the whole table when e_phnum is 0.
    let noLoadErr = null
    try {
      parseLoadAlignments(
        'Program Headers:\n' +
          '  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align\n' +
          '  NOTE           0x000200 0x0000000000000200 0x0000000000000200 0x000020 0x000020 R   0x4\n',
        'x',
      )
    } catch (err) {
      noLoadErr = err
    }
    check(
      noLoadErr instanceof Unverifiable && /zero LOAD segments/.test(noLoadErr.message),
      'a program-header table with no LOAD row is Unverifiable, not an empty clean pass',
      String(noLoadErr),
    )
    r = run([good], { PATH: dir, READELF: '', NDK_HOME: '' })
    check(
      r.status === EXIT_UNVERIFIED && /no usable readelf/.test(r.stderr),
      'no readelf on PATH is exit 3, not a pass',
      `${r.status}: ${r.stderr}`,
    )

    // Unrecognised readelf output shape — checked directly, since producing
    // one requires a readelf that does not exist.
    let threw = null
    try {
      parseLoadAlignments('Program Headers:\n  LOAD  something entirely different\n', 'x')
    } catch (err) {
      threw = err
    }
    check(
      threw instanceof Unverifiable,
      'a LOAD row whose columns are not the expected shape is Unverifiable, not skipped',
      String(threw),
    )
    check(
      parseLoadAlignments(
        'Program Headers:\n' +
          '  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x001000 0x001000 R   0x4000\n' +
          '  LOAD           0x001000 0x0000000000001000 0x0000000000001000 0x001000 0x001000 R E 0x4000\n',
        'x',
      ).length === 2,
      'both the "R" and the "R E" flag shapes parse',
      'expected 2 alignments',
    )

    // ── APKs ─────────────────────────────────────────────────────────────────
    // Same reasoning as runElfFixtureAssertions above: its own function so
    // eslint counts its branches separately from runSelfTest's.
    function runApkFixtureAssertions() {
      const okApk = write(
        'ok.apk',
        synthZip([
          ['AndroidManifest.xml', Buffer.from('<manifest/>')],
          ['lib/arm64-v8a/libagaric_lib.so', synthElf([0x4000, 0x4000])],
        ]),
      )
      let apkR = run([okApk])
      check(
        apkR.status === EXIT_OK && apkR.stdout.includes('lib/arm64-v8a/libagaric_lib.so'),
        'an APK whose native lib is 16 KB-aligned exits 0 and names the entry',
        `${apkR.status}: ${apkR.stdout}${apkR.stderr}`,
      )
      const badApk = write(
        'bad.apk',
        synthZip([
          ['lib/arm64-v8a/libagaric_lib.so', synthElf([0x4000])],
          ['lib/x86_64/libagaric_lib.so', synthElf([0x1000])],
        ]),
      )
      apkR = run([badApk])
      check(
        apkR.status === EXIT_FINDING && apkR.stderr.includes('lib/x86_64/libagaric_lib.so'),
        'one misaligned ABI inside an APK is a finding, and the ABI is named',
        `${apkR.status}: ${apkR.stderr}`,
      )
      // The zip half: a perfectly 16 KB-aligned ELF that the loader still
      // cannot map, because the STORED entry does not begin on a 16 KB
      // boundary.
      const offApk = write(
        'offset.apk',
        synthZip([['lib/arm64-v8a/libagaric_lib.so', synthElf([0x4000, 0x4000])]], {
          alignSo: false,
        }),
      )
      apkR = run([offApk])
      check(
        apkR.status === EXIT_FINDING && /ZIP: stored at APK offset/.test(apkR.stderr),
        'a 16 KB-aligned ELF stored at a non-16 KB APK offset is still a finding',
        `${apkR.status}: ${apkR.stderr}`,
      )
      check(
        /zipalign -P 16/.test(apkR.stderr) && !/max-page-size/.test(apkR.stderr),
        'the zip finding points at zipalign, and does not misattribute it to the link flag',
        apkR.stderr,
      )

      // No `--stage` given: the guard says it was not told, rather than
      // guessing at a specific step.
      check(
        /not told which stage/.test(apkR.stderr),
        'with no --stage flag, the zip finding says it was not told the stage',
        apkR.stderr,
      )
      // `--stage=pre-zipalign`: three of this repo's four call sites run
      // before zipalign, so the default text (blaming release.yml's signing
      // step) would be wrong for them. #4425 review note 2/3.
      apkR = run(['--stage=pre-zipalign', offApk])
      check(
        apkR.status === EXIT_FINDING &&
          /ran BEFORE zipalign/.test(apkR.stderr) &&
          !/Sign Android APK/.test(apkR.stderr),
        '--stage=pre-zipalign blames AGP packaging, not the signing step',
        apkR.stderr,
      )
      apkR = run(['--stage=post-zipalign', offApk])
      check(
        apkR.status === EXIT_FINDING &&
          /Sign Android APK/.test(apkR.stderr) &&
          !/ran BEFORE zipalign/.test(apkR.stderr),
        '--stage=post-zipalign blames the signing step',
        apkR.stderr,
      )
      apkR = run(['--stage=sideways', offApk])
      check(
        apkR.status === EXIT_UNVERIFIED && /unknown --stage value/.test(apkR.stderr),
        'an unrecognised --stage value is exit 3, not silently accepted',
        `${apkR.status}: ${apkR.stderr}`,
      )
      apkR = run(['--stage=pre-zipalign', '--stage=post-zipalign', offApk])
      check(
        apkR.status === EXIT_UNVERIFIED && /at most once/.test(apkR.stderr),
        'a repeated --stage flag is exit 3, not "last one wins"',
        `${apkR.status}: ${apkR.stderr}`,
      )

      // A misaligned library that is NOT libagaric_lib.so — e.g. a
      // third-party .so arriving via an AAR — must not be blamed on
      // src-tauri/build.rs, which never links it. #4425 review note 3.
      const thirdPartyApk = write(
        'thirdparty.apk',
        synthZip([
          ['lib/arm64-v8a/libagaric_lib.so', synthElf([0x4000, 0x4000])],
          ['lib/arm64-v8a/libsomevendor.so', synthElf([0x1000])],
        ]),
      )
      apkR = run([thirdPartyApk])
      check(
        apkR.status === EXIT_FINDING &&
          /libsomevendor\.so/.test(apkR.stderr) &&
          /Gradle dependency or AAR/.test(apkR.stderr) &&
          !/build.rs's linker flag has no influence over it/.test(apkR.stderr),
        'a misaligned non-own .so is attributed to its own build step, not src-tauri/build.rs',
        apkR.stderr,
      )
      check(
        !new RegExp(`ELF alignment for ${OUR_SO_BASENAME} is set`).test(apkR.stderr),
        'the own-library remediation is not printed when only a third-party .so is misaligned',
        apkR.stderr,
      )

      apkR = run([
        write('nolibs.apk', synthZip([['AndroidManifest.xml', Buffer.from('<manifest/>')]])),
      ])
      check(
        apkR.status === EXIT_UNVERIFIED && /no lib\/<abi>/.test(apkR.stderr),
        'an APK with no native libraries is exit 3 — an empty result set is not a pass',
        `${apkR.status}: ${apkR.stderr}`,
      )
      apkR = run([write('notzip.apk', Buffer.from('PK-ish but not really'))])
      check(
        apkR.status === EXIT_UNVERIFIED,
        'a file that is not a zip is exit 3',
        `${apkR.status}: ${apkR.stderr}`,
      )

      // zip64: flip the EOCD entry count to the sentinel.
      const z64 = synthZip([['lib/arm64-v8a/libagaric_lib.so', synthElf([0x4000])]])
      z64.writeUInt16LE(ZIP64_SENTINEL_16, z64.length - 22 + 10)
      apkR = run([write('zip64.apk', z64)])
      check(
        apkR.status === EXIT_UNVERIFIED && /zip64/.test(apkR.stderr),
        'a zip64 container is exit 3, not a pass on the entries it could still see',
        `${apkR.status}: ${apkR.stderr}`,
      )

      // A corrupted payload must not read as a clean library.
      const tampered = synthZip([['lib/arm64-v8a/libagaric_lib.so', synthElf([0x4000])]])
      tampered[tampered.length - 22 - 200] ^= 0xff
      apkR = run([write('tampered.apk', tampered)])
      check(
        apkR.status !== EXIT_OK,
        'a payload that fails its CRC never reports clean',
        `${apkR.status}: ${apkR.stdout}${apkR.stderr}`,
      )
    }

    if (readelfBin) {
      runApkFixtureAssertions()
    } else {
      skip('APK assertions', 'no readelf on this machine')
    }

    // ── the CI wiring actually calls this guard ──────────────────────────────
    const repoRoot = join(import.meta.dirname, '..')
    for (const wf of ['ci.yml', 'release.yml']) {
      const p = join(repoRoot, '.github/workflows', wf)
      const src = existsSync(p) ? readFileSync(p, 'utf8') : ''
      check(
        src.includes('check-android-so-alignment.mjs'),
        `${wf} invokes the guard (a guard nothing runs is a guard that cannot fail)`,
        `not referenced in ${p}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    return 2
  }
  if (skipped > 0) {
    console.warn(
      `\nself-test: ${skipped} assertion group(s) skipped (no readelf on this machine) — ` +
        'the rest passed. This is NOT full coverage; install binutils (or point READELF at an ' +
        'llvm-readelf, e.g. the one under $NDK_HOME) to run the fixture and APK assertions too. ' +
        'The guard\'s own no-readelf behaviour is still covered above regardless (see "no ' +
        'readelf on PATH is exit 3").',
    )
  }
  console.log('self-test: all assertions passed')
  return 0
}

// Entry-point detection in the one sanctioned form (#3373): both sides
// realpath'd, so a symlinked scripts/ directory cannot turn this into a no-op.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    process.exit(runSelfTest())
  } else {
    try {
      process.exit(main(args))
    } catch (err) {
      if (err instanceof Unverifiable) {
        console.error(`check-android-so-alignment: COULD NOT VERIFY — ${err.message}`)
        process.exit(EXIT_UNVERIFIED)
      }
      // An unexpected internal error is still "verified nothing", never a
      // verdict about the artifact. Reported as such, with the stack, so the
      // caller is never told a library is misaligned on the strength of a bug
      // in this file.
      console.error(
        `check-android-so-alignment: COULD NOT VERIFY — the guard itself failed:\n${err.stack ?? err}`,
      )
      process.exit(EXIT_UNVERIFIED)
    }
  }
}
