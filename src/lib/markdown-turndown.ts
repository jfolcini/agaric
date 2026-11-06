/**
 * The Turndown both HTML readers build on, paste (`createInlineTurndown`) and
 * the Evernote and Joplin imports (`createHtmlTurndown`), so an HTML construct
 * reads the same through either (#6277 E5).
 */

import TurndownService from 'turndown'

/**
 * A Turndown writing Agaric's Markdown: ATX headings, `-` bullets, fenced code,
 * `---` rules and `~~strike~~`, with `plugin` applied before the strikethrough
 * rule so the rule wins.
 */
export function createMarkdownTurndown(plugin: TurndownService.Plugin): TurndownService {
  const service = new TurndownService({
    // Any value but `'setext'` behaves identically — every Turndown check is
    // against that one (#4815).
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    // The readers take a rule only when every character is the same, so
    // Turndown's `* * *` would land as a list item.
    hr: '---',
  })
  service.use(plugin)
  // The GFM plugin writes `~x~`, and the editor strikes only `~~x~~`.
  service.addRule('strikethrough', {
    // The tag-name filter type omits the obsolete `<strike>`.
    filter: (node) => ['del', 's', 'strike'].includes(node.nodeName.toLowerCase()),
    replacement: (text) => `~~${text}~~`,
  })
  return service
}
