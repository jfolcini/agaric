/**
 * Shared `lowlight` instance with a curated set of `highlight.js` grammars.
 *
 * The `common` preset from `lowlight` bundles 37 language grammars (~70-100 KB
 * post-gzip), most of which are never used in this app's code blocks. This
 * module hand-picks the subset that matches the languages users actually write
 * (engineering / note-taking workloads — JS/TS/Python/Rust/Go, common config
 * formats, shell, docs).
 *
 * Both `RichContentRenderer` (render path) and `useRovingEditor` (edit path)
 * import the same instance from here so the grammars are not duplicate-bundled.
 *
 * Code blocks whose `language` attribute isn't in this set still render — they
 * just fall back to plain text (no syntax colors), which is preferable to
 * shipping 25 unused grammars on the critical path.
 *
 * Tier 1 item 3, sub-point 4 of the 2026-05-09 design-system perf review.
 */

import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { createLowlight } from 'lowlight'

/**
 * Curated language grammars registered with `lowlight`.
 *
 * Exported so unit tests can assert the expected set without reaching into
 * `lowlight`'s internals. Order matters only for readability — the underlying
 * `createLowlight` call iterates the object.
 *
 * - `xml` covers HTML (`highlight.js` registers HTML under the `xml` grammar).
 * - `shell` and `bash` are both included because `shell` is the canonical name
 *   for generic POSIX shell sessions in `highlight.js` and is distinct from
 *   `bash`.
 * - `plaintext` is the explicit "no highlighting" marker; including it avoids
 *   `highlightAuto` heuristics when a user writes ```plaintext fences.
 */
export const CURATED_LANGUAGES = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  javascript,
  json,
  markdown,
  plaintext,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
} as const

/**
 * Shared `lowlight` instance preloaded with `CURATED_LANGUAGES`.
 *
 * Import this from both the render-path (`RichContentRenderer`) and edit-path
 * (`useRovingEditor`) call sites so bundlers can dedupe the grammar imports.
 */
export const curatedLowlight = createLowlight(CURATED_LANGUAGES)
