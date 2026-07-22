/**
 * Content-delta helpers — pure markdown/doc functions with NO TipTap dependency.
 *
 * These were previously defined in `use-roving-editor.ts`, which statically
 * pulls the entire ~50-extension TipTap graph (+ highlight.js) into any module
 * that imports it. `EditableBlock` and `useEditorBlur` only need
 * `shouldSplitOnBlur` / `computeContentDelta`, so hosting them here keeps those
 * hot render-path modules off the editor chunk (#2939 — lazy editor mount).
 *
 * `use-roving-editor.ts` re-exports these names for backward compatibility with
 * its own test suite; the render path imports them directly from here.
 *
 * Depends only on the TipTap-free markdown serializer.
 */

import { notifyUnknownNodeTypeToast } from '@/editor/markdown-serialize-toast'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'

export interface ContentDelta {
  newMarkdown: string
  changed: boolean
  originalMarkdown: string
}

/**
 * Serialize a ProseMirror JSON doc and compare against the original markdown.
 * Pure function — no editor instance required.
 *
 * #711 — canonicalization is not an edit. `mount` parses the stored markdown
 * and `unmount` re-serializes it, and the serializer canonicalizes
 * (`3. item` → `1. item`, `_em_` → `*em*`, `snake_case` → `snake\_case`, …).
 * Comparing the new markdown against the RAW original therefore flagged
 * `changed: true` on a plain focus+blur with zero edits, silently rewriting
 * stored content and polluting the op log / undo history. When the raw
 * strings differ, compare against the canonicalized original
 * (`serialize(parse(original))`) instead: only real document changes count.
 */
export function computeContentDelta(originalMarkdown: string, currentJson: DocNode): ContentDelta {
  const newMarkdown = serialize(currentJson, notifyUnknownNodeTypeToast)
  if (newMarkdown === originalMarkdown) {
    return { newMarkdown, changed: false, originalMarkdown }
  }
  const canonicalOriginal = serialize(parse(originalMarkdown))
  return { newMarkdown, changed: newMarkdown !== canonicalOriginal, originalMarkdown }
}

// #1630 — single-entry parse memo for the blur hot path. The blur flush parses
// the same markdown string more than once (e.g. `useEditorBlur` Step 3's
// early-persist check and Step 5's split decision both call `shouldSplitOnBlur`
// with the identical fresh-block content), duplicating the markdown parse. Since
// `parse` is a pure function of its input string, caching the last
// (string -> DocNode) pair lets back-to-back calls over the same content reuse
// the parse. A one-entry cache is sufficient: the duplicate calls are adjacent,
// and behaviour is identical to re-parsing.
let lastParsedMarkdown: string | null = null
let lastParsedDoc: DocNode | null = null

function parseMemoized(markdown: string): DocNode {
  if (lastParsedMarkdown === markdown && lastParsedDoc !== null) {
    return lastParsedDoc
  }
  const doc = parse(markdown)
  lastParsedMarkdown = markdown
  lastParsedDoc = doc
  return doc
}

/**
 * Return true when the markdown would produce multiple top-level blocks
 * (i.e. contains newlines outside of code fences), meaning the block
 * should be split on blur.
 *
 * Pass an already-parsed `DocNode` as the optional second argument to skip the
 * parse entirely when the caller has the doc in hand (#1630).
 */
export function shouldSplitOnBlur(markdown: string, parsed?: DocNode): boolean {
  if (!markdown.includes('\n')) return false
  const doc = parsed ?? parseMemoized(markdown)
  const blocks = doc.content ?? []
  return blocks.length > 1
}
