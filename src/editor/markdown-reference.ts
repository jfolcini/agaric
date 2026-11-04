/**
 * The Markdown reference: every piece of syntax the editor reads today, what
 * a user types for it, and what it becomes. The drawer renders this list;
 * `markdown-reference.test.ts` parses every entry and fails when the editor
 * schema gains a mark or node no entry documents.
 */

export const MARKDOWN_REFERENCE_GROUPS = [
  'text',
  'blocks',
  'links',
  'tasks',
  'properties',
  'media',
  'commands',
] as const

export type MarkdownReferenceGroup = (typeof MARKDOWN_REFERENCE_GROUPS)[number]

export interface MarkdownReferenceEntry {
  /** Stable, kebab-case; names the entry's i18n keys. */
  id: string
  group: MarkdownReferenceGroup
  /** What the user types, shown verbatim. */
  typed: string
  /** The Markdown the block stores, when it is not `typed`: a picker's id, a code block's lines. */
  stored?: string
  /**
   * The editor schema types the stored form produces: a mark or node name, or
   * `node.attr` when the syntax only sets that attribute (a task's state).
   */
  covers: readonly string[]
  /**
   * What gives the text its meaning when parsing the block's Markdown alone
   * does not: a `key:: value` line the save commits (`property`), page
   * properties in Edit as Markdown (`frontMatter`), a block holding only that
   * token (`embed`, `query`), or the `:name:` input rule (`emoji`).
   */
  readBy?: 'property' | 'frontMatter' | 'embed' | 'query' | 'emoji'
}

/** A stand-in id: a picker stores the target's ULID in place of the name typed. */
const ID = '01JD3Z8W4M5N6P7Q8R9S0T1V2W'

export const MARKDOWN_REFERENCE: readonly MarkdownReferenceEntry[] = [
  { id: 'bold', group: 'text', typed: '**bold**', covers: ['bold'] },
  { id: 'italic', group: 'text', typed: '*italic*', covers: ['italic'] },
  { id: 'highlight', group: 'text', typed: '==highlight==', covers: ['highlight'] },
  { id: 'strike', group: 'text', typed: '~~strike~~', covers: ['strike'] },
  { id: 'underline', group: 'text', typed: '<u>underline</u>', covers: ['underline'] },
  { id: 'inline-code', group: 'text', typed: '`code`', covers: ['code'] },
  { id: 'line-break', group: 'text', typed: 'First line\nSecond line', covers: ['hardBreak'] },
  { id: 'escape', group: 'text', typed: String.raw`\*not italic\*`, covers: [] },

  { id: 'heading', group: 'blocks', typed: '# Heading', covers: ['heading'] },
  { id: 'bullet-list', group: 'blocks', typed: '- Item', covers: ['bulletList'] },
  { id: 'numbered-list', group: 'blocks', typed: '1. Item', covers: ['orderedList'] },
  { id: 'quote', group: 'blocks', typed: '> Quote', covers: ['blockquote'] },
  { id: 'callout', group: 'blocks', typed: '> [!NOTE] Title', covers: ['blockquote.calloutType'] },
  {
    id: 'code-block',
    group: 'blocks',
    typed: '```',
    stored: '```\ncode\n```',
    covers: ['codeBlock'],
  },
  {
    id: 'code-language',
    group: 'blocks',
    typed: '```js',
    stored: '```js\nconst x = 1\n```',
    covers: ['codeBlock.language'],
  },
  {
    id: 'diagram',
    group: 'blocks',
    typed: '```mermaid',
    stored: '```mermaid\ngraph TD\n  A --> B\n```',
    covers: ['codeBlock.language'],
  },
  {
    id: 'table',
    group: 'blocks',
    typed: '| Name | Count |\n| --- | --- |\n| Apples | 3 |',
    covers: ['table', 'tableHeader'],
  },
  { id: 'divider', group: 'blocks', typed: '---', covers: ['horizontalRule'] },
  {
    id: 'query',
    group: 'blocks',
    typed: '{{query tag:project}}',
    covers: [],
    readBy: 'query',
  },

  { id: 'link', group: 'links', typed: '[text](https://example.com)', covers: ['link'] },
  { id: 'web-address', group: 'links', typed: 'https://example.com', covers: ['link'] },
  {
    id: 'page-link',
    group: 'links',
    typed: '[[Page name]]',
    stored: `[[${ID}]]`,
    covers: ['block_link'],
  },
  {
    id: 'page-link-label',
    group: 'links',
    typed: '[[Page name|shown text]]',
    stored: `[[${ID}|shown text]]`,
    covers: ['block_link.label'],
  },
  {
    id: 'block-ref',
    group: 'links',
    typed: '((Block text))',
    stored: `((${ID}))`,
    covers: ['block_ref'],
  },
  { id: 'tag', group: 'links', typed: '#project', stored: `#[${ID}]`, covers: ['tag_ref'] },
  {
    id: 'tag-with-spaces',
    group: 'links',
    typed: '#[[two words]]',
    stored: `#[${ID}]`,
    covers: ['tag_ref'],
  },
  {
    id: 'page-embed',
    group: 'links',
    typed: '{{embed [[Page name]]}}',
    stored: `{{embed [[${ID}]]}}`,
    covers: ['block_link'],
    readBy: 'embed',
  },
  {
    id: 'block-embed',
    group: 'links',
    typed: '{{embed ((Block text))}}',
    stored: `{{embed ((${ID}))}}`,
    covers: ['block_ref'],
    readBy: 'embed',
  },

  { id: 'task-todo', group: 'tasks', typed: '- [ ] Task', covers: ['paragraph.todoState'] },
  { id: 'task-doing', group: 'tasks', typed: '- [/] Task', covers: ['paragraph.todoState'] },
  { id: 'task-done', group: 'tasks', typed: '- [x] Task', covers: ['paragraph.todoState'] },
  { id: 'task-cancelled', group: 'tasks', typed: '- [-] Task', covers: ['paragraph.todoState'] },
  { id: 'priority', group: 'tasks', typed: 'priority:: 1', covers: [], readBy: 'property' },
  {
    id: 'due-date',
    group: 'tasks',
    typed: 'due_date:: 2026-11-10',
    covers: [],
    readBy: 'property',
  },
  {
    id: 'scheduled-date',
    group: 'tasks',
    typed: 'scheduled_date:: 2026-11-10',
    covers: [],
    readBy: 'property',
  },

  {
    id: 'block-property',
    group: 'properties',
    typed: 'author:: Ana',
    covers: [],
    readBy: 'property',
  },
  {
    id: 'page-properties',
    group: 'properties',
    typed: '---\nauthor: Ana\n---',
    covers: [],
    readBy: 'frontMatter',
  },

  {
    id: 'image',
    group: 'media',
    typed: '![A cat](https://example.com/cat.png)',
    covers: ['image'],
  },
  {
    id: 'image-width',
    group: 'media',
    typed: '![A cat|300](https://example.com/cat.png)',
    covers: ['image'],
  },
  {
    id: 'pasted-image',
    group: 'media',
    typed: `![photo.png](attachment:${ID})`,
    covers: ['image'],
  },
  { id: 'math-inline', group: 'media', typed: '$E = mc^2$', covers: ['math_inline'] },
  { id: 'math-block', group: 'media', typed: '$$\nE = mc^2\n$$', covers: ['math_block'] },

  { id: 'commands', group: 'commands', typed: '/', covers: [] },
  { id: 'emoji', group: 'commands', typed: ':joy:', stored: '😂', covers: [], readBy: 'emoji' },
]

/** Entry `id`'s i18n key; i18n keys are camelCase, ids kebab-case. */
export function markdownReferenceKey(id: string, part: 'title' | 'description'): string {
  const segment = id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  return `markdownReference.${segment}.${part}`
}

export function markdownReferenceGroupKey(group: MarkdownReferenceGroup): string {
  return `markdownReference.group.${group}`
}
