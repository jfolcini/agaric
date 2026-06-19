/**
 * Regression tests for the math input-rule code-context guard (#1537).
 *
 * #1537: typing `$…$` (math_inline) or a whole-line `$$…$$` (math_block) while
 * inside a code context — the inline `code` mark, or a fenced code block —
 * should stay LITERAL, never convert to a math atom, since the user is writing
 * verbatim source.
 *
 * There are TWO layers that enforce this, and the tests pin both:
 *
 *   1. TipTap's own input-rule plugin (`@tiptap/core/src/InputRule.ts`, the
 *      `run()` guard) already bails BEFORE any handler runs when
 *      `$from.parent.type.spec.code` or an adjacent node carries a code-spec
 *      mark. So through the real typing path the math handlers are never even
 *      invoked in a code context — this is what makes the end-to-end behaviour
 *      correct, and what `realEditor*` tests below assert.
 *
 *   2. The #1537 fix ALSO adds a defensive guard at the top of each math
 *      handler (`doc.resolve(range.from)` → code block / `code` mark check).
 *      Because layer 1 backstops it, this handler guard is effectively
 *      unreachable via the plugin path — but it is real code with real intent,
 *      so the `handlerGuard*` tests call the handler directly to prove the
 *      guard short-circuits (no `state.tr` mutation) for a code-marked /
 *      code-block resolved position, and mints the atom otherwise.
 *
 * NOTE on the original task framing: because of layer 1, the end-to-end
 * "code mark" case does NOT flip to a math node if the handler guard alone is
 * removed (the plugin guard still stops it). The handler-level unit tests are
 * what actually exercise — and would fail without — the added guard code.
 */

import { createChainableState, Editor, InputRule } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { MathBlock, MathInline } from '../extensions/math'

// The real math node views render React + KaTeX, irrelevant to the input-rule
// logic and awkward under happy-dom. Drop the node views so the atoms mount
// cleanly; the input rules and `type.create` are untouched. (Returning null =
// no node view; the key can't be undefined under exactOptionalPropertyTypes.)
const MathInlineNoView = MathInline.extend({ addNodeView: () => null })
const MathBlockNoView = MathBlock.extend({ addNodeView: () => null })

function makeEditor(): Editor {
  return new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      History,
      Code,
      CodeBlock,
      MathInlineNoView,
      MathBlockNoView,
    ],
    content: '<p></p>',
  })
}

const editors: Editor[] = []
afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy()
})

function freshEditor(): Editor {
  const e = makeEditor()
  editors.push(e)
  return e
}

/**
 * Drive the closing `$` of a `$…$` run through ProseMirror's real typing path.
 * The math input rules are anchored with a trailing literal `$` and fire on the
 * just-typed terminating `$` via the `handleTextInput` view prop — NOT via a
 * plain `insertContent` transaction. So we type the final `$` through
 * `handleTextInput`; on no-match (rule declined / plugin guard) we insert it
 * literally, mirroring the browser inserting the unmatched char, so the literal
 * assertions see the full text.
 */
function typeClosingDollar(editor: Editor): void {
  const { from } = editor.state.selection
  const handled = editor.view.someProp('handleTextInput', (f) =>
    f(editor.view, from, from, '$', () => editor.state.tr.insertText('$', from)),
  )
  if (!handled) editor.commands.insertContent('$')
}

/** Count the math nodes of a given type in the doc. */
function countNodes(editor: Editor, typeName: 'math_inline' | 'math_block'): number {
  let n = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) n += 1
  })
  return n
}

/** Pull the single math input rule registered by an extension. */
function inputRuleOf(editor: Editor, name: 'math_inline' | 'math_block'): InputRule {
  const type = editor.schema.nodes[name]
  const node = name === 'math_inline' ? MathInlineNoView : MathBlockNoView
  // addInputRules is defined on the extension config; bind a minimal `this`
  // exposing `type` (the only field the math rules read).
  const rules = node.config.addInputRules?.call({ type } as never) as InputRule[]
  return rules[0] as InputRule
}

/**
 * Invoke a math input-rule handler against a chainable state (so `state.tr` is
 * the SAME transaction across the handler and our inspection — mirroring how
 * TipTap's plugin calls handlers). Returns the transaction the handler built;
 * if the guard fired, it has no steps.
 */
function runHandler(
  editor: Editor,
  rule: InputRule,
  range: { from: number; to: number },
  match: RegExpMatchArray,
): import('@tiptap/pm/state').Transaction {
  const tr = editor.state.tr
  const state = createChainableState({ state: editor.state, transaction: tr })
  rule.handler({
    state,
    range,
    match,
    commands: editor.commands as never,
    chain: editor.chain as never,
    can: editor.can as never,
  })
  return tr
}

// ── End-to-end: real editor, real typing path (layer 1 + observable behaviour)

describe('math input rules — end-to-end behaviour (#1537)', () => {
  it('typing `$x$` in PLAIN text converts to a math_inline node (rule still works — no over-block)', () => {
    const editor = freshEditor()
    editor.chain().focus().insertContent('$x').run()
    typeClosingDollar(editor)

    expect(countNodes(editor, 'math_inline')).toBe(1)
    let latex: string | null = null
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'math_inline') latex = n.attrs['latex'] as string
    })
    expect(latex).toBe('x')
    expect(editor.state.doc.textContent).not.toContain('$')
  })

  it('typing `$x$` while the inline `code` mark is active stays literal (no math node)', () => {
    const editor = freshEditor()
    editor.chain().focus().setMark('code').insertContent('$x').run()
    expect(editor.isActive('code')).toBe(true)
    typeClosingDollar(editor)

    expect(countNodes(editor, 'math_inline')).toBe(0)
    expect(editor.state.doc.textContent).toBe('$x$')
  })

  it('typing `$$x$$` as the whole line inside a code block stays literal (no math_block)', () => {
    const editor = freshEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: '$$x$' }] }],
    })
    editor.commands.focus('end')
    typeClosingDollar(editor)

    expect(countNodes(editor, 'math_block')).toBe(0)
    expect(editor.state.doc.child(0).type.name).toBe('codeBlock')
    expect(editor.state.doc.child(0).textContent).toBe('$$x$$')
  })
})

// ── Handler-level: directly exercise the #1537 guard the fix added ──────────
//
// These call the math input-rule handler with a synthetic resolved-position
// context so the guard branch is actually executed (the TipTap plugin guard,
// which would otherwise stop the rule first, is bypassed by calling the handler
// directly). A handler that mutated `state.tr` would have a non-empty
// transaction step list; the guard must leave it untouched.

const INLINE_RE = /\$([^\s$0-9][^$]*?)\$$/
const BLOCK_RE = /^\$\$\s*([^$]+?)\s*\$\$$/

describe('math_inline handler guard (#1537)', () => {
  it('no-ops (no tr step) when the resolved position carries the inline `code` mark', () => {
    const editor = freshEditor()
    // A paragraph holding code-marked text `$x$`; range.from (pos 1) resolves
    // inside the code-marked run, so the guard's `code` mark check trips.
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', marks: [{ type: 'code' }], text: '$x$' }],
        },
      ],
    })
    const rule = inputRuleOf(editor, 'math_inline')
    const tr = runHandler(
      editor,
      rule,
      { from: 1, to: 4 },
      '$x$'.match(INLINE_RE) as RegExpMatchArray,
    )
    // Guard hit → handler returned early, no replacement queued.
    expect(tr.steps.length).toBe(0)
  })

  it('mints a math_inline atom for the same match in PLAIN (unmarked) text', () => {
    const editor = freshEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '$x$' }] }],
    })
    const rule = inputRuleOf(editor, 'math_inline')
    const tr = runHandler(
      editor,
      rule,
      { from: 1, to: 4 },
      '$x$'.match(INLINE_RE) as RegExpMatchArray,
    )
    // No guard → the handler queued a replaceWith step that produces the atom.
    expect(tr.steps.length).toBeGreaterThan(0)
    editor.view.dispatch(tr)
    expect(countNodes(editor, 'math_inline')).toBe(1)
  })
})

describe('math_block handler guard (#1537)', () => {
  it('no-ops (no tr step) when the resolved position is inside a code block', () => {
    const editor = freshEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: '$$x$$' }] }],
    })
    const rule = inputRuleOf(editor, 'math_block')
    // Resolve at position 1 (inside the code block's text) → parent.type.spec.code.
    const tr = runHandler(
      editor,
      rule,
      { from: 1, to: 6 },
      '$$x$$'.match(BLOCK_RE) as RegExpMatchArray,
    )
    expect(tr.steps.length).toBe(0)
  })

  it('mints a math_block atom for the same match in a plain paragraph', () => {
    const editor = freshEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '$$x$$' }] }],
    })
    const rule = inputRuleOf(editor, 'math_block')
    const tr = runHandler(
      editor,
      rule,
      { from: 1, to: 6 },
      '$$x$$'.match(BLOCK_RE) as RegExpMatchArray,
    )
    expect(tr.steps.length).toBeGreaterThan(0)
    editor.view.dispatch(tr)
    expect(countNodes(editor, 'math_block')).toBe(1)
  })
})
