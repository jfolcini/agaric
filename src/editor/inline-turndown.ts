/**
 * Turndown configuration for inline HTML → Agaric-Markdown conversion (#1439).
 *
 * Pins Turndown's options to Agaric's markdown subset so the produced inline
 * markdown round-trips through `src/editor/markdown-parse/` unchanged:
 *   - ATX headings (`# `), `-` bullets, `**bold**`, `_italic_`,
 *     fenced ```code, `[text](url)` links;
 *   - the GFM `strikethrough` plugin adds `~~strike~~`.
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
 * This module imports only `turndown` + `turndown-plugin-gfm`; it is itself
 * imported LAZILY (dynamic `import()`) from the paste handler so Turndown stays
 * out of the main bundle chunk (#750) and loads only on the first HTML paste.
 */

import TurndownService from 'turndown'
import { strikethrough } from 'turndown-plugin-gfm'

import { isValidHttpUrl } from './extensions/external-link'
import type { InlineToMarkdown } from './html-to-blocks'

/**
 * Build a Turndown service pinned to Agaric's markdown subset, with the paste
 * security guards applied, plus an {@link InlineToMarkdown} adapter that renders
 * a single element's inline content (used by the DOM walk).
 */
export function createInlineTurndown(): {
  service: TurndownService
  inline: InlineToMarkdown
} {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
    codeBlockStyle: 'fenced',
    fence: '```',
    linkStyle: 'inlined',
  })

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

  // GFM strikethrough support (`<del>`/`<s>`/`<strike>`). The plugin emits a
  // single-tilde `~strike~`, but Agaric's parser only recognises the
  // double-tilde `~~strike~~` (`scanStrike`), so override the rule to emit `~~`.
  service.use(strikethrough)
  service.addRule('strikethrough', {
    // `<strike>` is deprecated and absent from `keyof HTMLElementTagNameMap`, so
    // match by node name with a filter function rather than a typed tag list.
    filter: (node) =>
      node.nodeName === 'DEL' || node.nodeName === 'S' || node.nodeName === 'STRIKE',
    replacement: (content) => `~~${content}~~`,
  })

  const inline: InlineToMarkdown = (el) => service.turndown(el.innerHTML)

  return { service, inline }
}
