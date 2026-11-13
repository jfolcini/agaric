#!/usr/bin/env node
// What an attachment upload costs the webview before the bytes leave it (#6539): the old wire
// shape, one JSON number per byte (`Array.from(bytes)`), against the base64 string
// `blobToBase64` (`src/lib/file-utils.ts`) sends now. Chromium is Android's WebView engine, and
// on Android Tauri sends every invoke as one JSON string through `postMessage`, so the
// `JSON.stringify` below is the IPC message itself.
//
// Usage, from the repo root:
//   node scripts/measure-upload-encoding.mjs
//
// Env: SIZE_MB (default 30), REPEATS (3).
//
// Per shape, in a fresh page each repeat: `encode` is bytes to the IPC argument, `stringify` the
// message's JSON, `json` its length, `heap` the JS heap's growth with both still held. Prints
// median [min–max]; read a difference whose ranges overlap as none.
import { loadavg } from 'node:os'

import { chromium } from 'playwright'

const SIZE_MB = Number(process.env.SIZE_MB ?? 30)
const REPEATS = Number(process.env.REPEATS ?? 3)

async function measure({ shape, sizeMb }) {
  const bytes = new Uint8Array(sizeMb * 1024 * 1024)
  // `getRandomValues` fills at most 64 KiB a call.
  for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536))
  const heapBefore = performance.memory.usedJSHeapSize
  const start = performance.now()
  const argument =
    shape === 'numbers'
      ? Array.from(bytes)
      : await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.addEventListener('load', () => {
            resolve(reader.result.slice(reader.result.indexOf(',') + 1))
          })
          reader.addEventListener('error', () => reject(reader.error))
          reader.readAsDataURL(new Blob([bytes]))
        })
  const encoded = performance.now()
  const json = JSON.stringify({ cmd: 'add_attachment_with_bytes', payload: { bytes: argument } })
  const done = performance.now()
  return {
    encode: encoded - start,
    stringify: done - encoded,
    json: json.length / 1048576,
    heap: (performance.memory.usedJSHeapSize - heapBefore) / 1048576,
  }
}

function summary(samples, key, unit) {
  const sorted = samples.map((s) => s[key]).toSorted((a, b) => a - b)
  const [min, median, max] = [0, Math.floor(sorted.length / 2), sorted.length - 1].map((i) =>
    Math.round(sorted[i]),
  )
  return `${key} ${median} ${unit} [${min}–${max}]`
}

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] })
console.log(`${SIZE_MB} MB, ${REPEATS} repeats, load average ${loadavg()[0].toFixed(1)}`)
for (const shape of ['numbers', 'base64']) {
  const samples = []
  for (let i = 0; i < REPEATS; i++) {
    const page = await browser.newPage()
    samples.push(await page.evaluate(measure, { shape, sizeMb: SIZE_MB }))
    await page.close()
  }
  console.log(
    shape.padEnd(8),
    [
      summary(samples, 'encode', 'ms'),
      summary(samples, 'stringify', 'ms'),
      summary(samples, 'json', 'MB'),
      summary(samples, 'heap', 'MB'),
    ].join(', '),
  )
}
await browser.close()
