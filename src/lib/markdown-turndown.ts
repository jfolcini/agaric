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
  // Turndown pads a marker to four columns (`-   x`, `1.  x`), and the readers
  // keep spacing past a marker's one space as the item's text.
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const list = node.parentNode as Element
      const index = Array.prototype.indexOf.call(list.children, node)
      const start = Number(list.getAttribute('start') || 1)
      const prefix = list.nodeName === 'OL' ? `${start + index}. ` : '- '
      const text = content.replace(/^\n+/, '').replace(/\n+$/, '\n')
      return (
        prefix +
        text.replace(/\n/g, `\n${' '.repeat(prefix.length)}`) +
        (node.nextSibling ? '\n' : '')
      )
    },
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
