/**
 * Parse half of the markdown serializer (Markdown → PM doc).
 *
 * Extracted from the original `markdown-serializer.ts` monolith
 * (MAINT-117), then split again from a single ~1340-line file into a
 * `markdown-parse/` directory of cohesive modules:
 *   - `markdown-parse/vocab.ts`  — constants, the scanner primitive, the
 *     result/state shapes and the parse-independent pure helpers (a leaf the
 *     parser core imports, breaking what would otherwise be an import cycle).
 *   - `markdown-parse/parser.ts` — the co-recursive block + inline parser core.
 *
 * This file is now the public-API barrel for that directory. The public
 * surface is unchanged — every existing
 * `import { parse, parseCodeBlock, scanBold, ... } from './markdown-parse'`
 * (and via the `markdown-serializer.ts` barrel above it) continues to resolve
 * unchanged.
 *
 * Zero external dependencies. O(n) in the input length.
 */

export {
  parse,
  parseBlockquote,
  parseBulletList,
  parseCodeBlock,
  parseHeading,
  parseHorizontalRule,
  parseMathBlock,
  parseOrderedList,
  parseParagraph,
  parseTable,
  parseTask,
  scanAutolink,
  scanBold,
  scanCodeSpan,
  scanEscape,
  scanExternalLinkToken,
  scanHighlight,
  scanImage,
  scanItalic,
  scanMathInline,
  scanStrike,
  scanTokenRef,
  scanUnderline,
} from './markdown-parse/parser'
export { createInlineState, type InlineState } from './markdown-parse/vocab'
