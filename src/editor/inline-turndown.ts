/**
 * Turndown configuration for inline HTML → Agaric-Markdown conversion (#1439).
 *
 * Built on {@link createMarkdownTurndown}, the rule set the Evernote and Joplin
 * imports share, so the produced inline markdown round-trips through
 * `src/editor/markdown-parse/` unchanged: `**bold**`, `_italic_`, `` `code` ``,
 * `[text](url)` links and the GFM `strikethrough` plugin's `~~strike~~`.
 *
 * Security (the paste path has NO sanitizer and the HTML is UNTRUSTED):
 *   - `script` / `style` / `noscript` elements are removed (their text content
 *     must never leak into a block);
 *   - link hrefs are clamped to http(s) via `isValidHttpUrl` — a
 *     `javascript:`/`data:`/other-scheme link is de-linked to its plain text;
 *   - image `src` is clamped to http(s) via the SAME `isValidHttpUrl` (#1439
 *     Phase 2) — an inline `<img>` with a `javascript:`/`data:`/other-scheme
 *     src is reduced to its alt text rather than emitting `![alt](badsrc)`.
 *
 * This module is imported LAZILY (dynamic `import()`) from the paste handler
 * so Turndown stays out of the main bundle chunk (#750) and loads only on the
 * first HTML paste.
 */

import type TurndownService from 'turndown'
import { strikethrough } from 'turndown-plugin-gfm'

import { isValidHttpUrl } from '@/editor/extensions/external-link'
import type { InlineToMarkdown } from '@/editor/html-to-blocks'
import { createMarkdownTurndown } from '@/lib/markdown-turndown'

/**
 * Build a Turndown service pinned to Agaric's markdown subset, with the paste
 * security guards applied, plus an {@link InlineToMarkdown} adapter that renders
 * a single element's inline content (used by the DOM walk).
 */
export function createInlineTurndown(): {
  service: TurndownService
  inline: InlineToMarkdown
} {
  const service = createMarkdownTurndown(strikethrough)

  // Strip executable / presentational elements entirely (untrusted HTML).
  service.remove(['script', 'style', 'noscript'])

  // Clamp link hrefs to http(s). Turndown's default anchor rule emits
  // `[text](href)` for any href; here a non-http(s) scheme (`javascript:`,
  // `data:`, `vbscript:`, …) or an empty href is de-linked to its inner text so
  // a malicious link can never round-trip into a block.
  service.addRule('safeLink', {
    filter: (node) =>
      node.nodeName === 'A' && Boolean((node as HTMLAnchorElement).getAttribute('href')),
    replacement: (content, node) => {
      const href = (node as HTMLAnchorElement).getAttribute('href') ?? ''
      if (!isValidHttpUrl(href)) return content
      return `[${content}](${href})`
    },
  })

  // Clamp inline image `src` to http(s) (#1439 Phase 2). Turndown's default
  // image rule emits `![alt](src)` for ANY src; an untrusted `javascript:` /
  // `data:` / other-scheme src must never round-trip into a block, so a
  // non-http(s) src is reduced to the bare alt text instead.
  service.addRule('safeImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLImageElement
      const src = el.getAttribute('src') ?? ''
      // Escape `]` and `\` in the alt text BEFORE interpolating into
      // `![alt](src)` — same as the block-level imageMarkdown(). Without this a
      // crafted alt like `](javascript:xss) ![fake` would break out of the alt
      // span and inject an image whose src bypasses isValidHttpUrl. Escaping is
      // applied to the alt-only fallback too so an unsafe-src image cannot
      // smuggle markdown (e.g. a `]`-based link) through its alt text.
      const alt = (el.getAttribute('alt') ?? '').replace(/([\\\]])/g, '\\$1')
      if (!isValidHttpUrl(src)) return alt
      return `![${alt}](${src})`
    },
  })

  const inline: InlineToMarkdown = (el) => service.turndown(el.innerHTML)

  return { service, inline }
}
