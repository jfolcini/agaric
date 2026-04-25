import { Editor } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckboxInputRule } from '../extensions/checkbox-input-rule'

describe('CheckboxInputRule extension', () => {
  it('creates without error', () => {
    const ext = CheckboxInputRule.configure({})
    expect(ext).toBeDefined()
  })

  it('has name "checkboxInputRule"', () => {
    const ext = CheckboxInputRule.configure({})
    expect(ext.name).toBe('checkboxInputRule')
  })

  it('is an Extension type (not Node or Mark)', () => {
    expect(CheckboxInputRule.type).toBe('extension')
  })

  it('has the expected default options', () => {
    const ext = CheckboxInputRule.configure({})
    expect(ext.options.onCheckbox).toBeNull()
  })

  it('accepts onCheckbox callback', () => {
    const cb = () => {}
    const ext = CheckboxInputRule.configure({ onCheckbox: cb })
    expect(ext.options.onCheckbox).toBe(cb)
  })
})

describe('Checkbox regex patterns', () => {
  const todoRegex = /^- \[ \] $/
  const doneRegex = /^- \[[xX]\] $/

  it('TODO regex matches "- [ ] "', () => {
    expect(todoRegex.test('- [ ] ')).toBe(true)
  })

  it('DONE regex matches "- [x] "', () => {
    expect(doneRegex.test('- [x] ')).toBe(true)
  })

  it('DONE regex matches "- [X] "', () => {
    expect(doneRegex.test('- [X] ')).toBe(true)
  })

  it('TODO regex does not match "- []"', () => {
    expect(todoRegex.test('- []')).toBe(false)
  })

  it('TODO regex does not match "- [ ]x"', () => {
    expect(todoRegex.test('- [ ]x')).toBe(false)
  })

  it('DONE regex does not match "[x]"', () => {
    expect(doneRegex.test('[x]')).toBe(false)
  })

  it('TODO regex does not match partial "- [ ]" (no trailing space)', () => {
    expect(todoRegex.test('- [ ]')).toBe(false)
  })

  it('DONE regex does not match partial "- [x]" (no trailing space)', () => {
    expect(doneRegex.test('- [x]')).toBe(false)
  })

  it('TODO regex does not match with leading text', () => {
    expect(todoRegex.test('text - [ ] ')).toBe(false)
  })

  it('DONE regex does not match with leading text', () => {
    expect(doneRegex.test('text - [x] ')).toBe(false)
  })
})

describe('CheckboxInputRule input rules', () => {
  it('extension has exactly 2 input rules', () => {
    const ext = CheckboxInputRule.configure({ onCheckbox: null })
    // biome-ignore lint/suspicious/noExplicitAny: test-only — TipTap extension `this` context mock
    const rules = ext.config.addInputRules?.call({ options: ext.options } as any)
    expect(rules).toHaveLength(2)
  })

  it('TODO handler calls onCheckbox with TODO', () => {
    const onCheckbox = vi.fn()
    const ext = CheckboxInputRule.configure({ onCheckbox })
    // biome-ignore lint/suspicious/noExplicitAny: test-only — TipTap extension `this` context mock
    const rules = ext.config.addInputRules?.call({ options: ext.options } as any)
    const todoRule = rules?.[0]
    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 1, to: 7 }
    todoRule?.handler({
      state: mockState,
      range: mockRange,
      match: '- [ ] '.match(/^- \[ \] $/) as RegExpMatchArray,
    } as unknown as Parameters<NonNullable<typeof todoRule>['handler']>[0])
    expect(mockState.tr.delete).toHaveBeenCalledWith(1, 7)
    expect(onCheckbox).toHaveBeenCalledWith('TODO')
  })

  it('DONE handler calls onCheckbox with DONE', () => {
    const onCheckbox = vi.fn()
    const ext = CheckboxInputRule.configure({ onCheckbox })
    // biome-ignore lint/suspicious/noExplicitAny: test-only — TipTap extension `this` context mock
    const rules = ext.config.addInputRules?.call({ options: ext.options } as any)
    const doneRule = rules?.[1]
    const mockState = { tr: { delete: vi.fn() } }
    const mockRange = { from: 1, to: 7 }
    doneRule?.handler({
      state: mockState,
      range: mockRange,
      match: '- [x] '.match(/^- \[[xX]\] $/) as RegExpMatchArray,
    } as unknown as Parameters<NonNullable<typeof doneRule>['handler']>[0])
    expect(mockState.tr.delete).toHaveBeenCalledWith(1, 7)
    expect(onCheckbox).toHaveBeenCalledWith('DONE')
  })
})

// ── Real-editor integration ─────────────────────────────────────────────
//
// These tests boot a real TipTap Editor with the CheckboxInputRule wired
// up and drive the input rule by typing/inserting text via the official
// `applyInputRules: true` option on `insertContent`. The TipTap input
// rule plugin schedules its `run()` via setTimeout(0), so each test
// awaits a microtask flush before asserting.
//
// We cover:
//   1. Type `- [ ] ` at the start of a paragraph  → onCheckbox(TODO)
//   2. Type `- [x] ` at the start                 → onCheckbox(DONE)
//   3. Type `- [X] ` (uppercase X)                → onCheckbox(DONE)
//   4. Mid-line typing of `- [ ] `                → does NOT trigger
//   5. Inside an existing checkbox-prefixed paragraph (not at start) →
//      does NOT re-trigger
//   6. Inside a code block                        → does NOT trigger
//   7. Pasting `- [ ] ` (no applyInputRules meta) → does NOT trigger
//   8. Undo after the rule fires                  → text is restored
//   9. With onCheckbox null (default), text is still deleted, no crash
//  10. Plugin is registered on the editor view
//  11. Boot does not leave orphaned popups (Pitfall 23)

describe('CheckboxInputRule real-editor integration', () => {
  let editor: Editor | undefined

  afterEach(() => {
    editor?.destroy()
    editor = undefined
  })

  /**
   * Build a minimal editor with the rule wired up. Includes History so
   * we can drive Ctrl+Z (`editor.commands.undo()`) tests, and CodeBlock
   * so we can verify the rule does NOT fire inside code blocks.
   */
  function buildEditor(
    onCheckbox: ((state: 'TODO' | 'DONE') => void) | null,
    initialText = '',
  ): Editor {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        History,
        CodeBlock,
        CheckboxInputRule.configure({ onCheckbox }),
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: initialText ? [{ type: 'text', text: initialText }] : [],
          },
        ],
      },
    })
  }

  /**
   * The input rule plugin defers `run()` via setTimeout(0) when fired
   * from the `applyInputRules` meta path. Flush both microtasks and the
   * timer queue so assertions see the post-rule state.
   */
  async function flushInputRule(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('typing "- [ ] " at the start of a paragraph fires onCheckbox(TODO) and removes the trigger', async () => {
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox)
    // Cursor sits at start of empty paragraph (position 1).
    editor.commands.insertContent('- [ ] ', { applyInputRules: true })
    await flushInputRule()

    expect(onCheckbox).toHaveBeenCalledTimes(1)
    expect(onCheckbox).toHaveBeenCalledWith('TODO')
    // After the input rule deletes the trigger, the paragraph is empty.
    expect(editor.state.doc.child(0).textContent).toBe('')
  })

  it('typing "- [x] " fires onCheckbox(DONE)', async () => {
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox)
    editor.commands.insertContent('- [x] ', { applyInputRules: true })
    await flushInputRule()

    expect(onCheckbox).toHaveBeenCalledTimes(1)
    expect(onCheckbox).toHaveBeenCalledWith('DONE')
    expect(editor.state.doc.child(0).textContent).toBe('')
  })

  it('typing "- [X] " (uppercase) fires onCheckbox(DONE)', async () => {
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox)
    editor.commands.insertContent('- [X] ', { applyInputRules: true })
    await flushInputRule()

    expect(onCheckbox).toHaveBeenCalledTimes(1)
    expect(onCheckbox).toHaveBeenCalledWith('DONE')
    expect(editor.state.doc.child(0).textContent).toBe('')
  })

  it('typing "- [ ] " mid-line does NOT trigger the rule (regex anchors at start of textblock)', async () => {
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox, 'hello ')
    // Move cursor to end of 'hello ' so the next insert is mid-line.
    editor.commands.focus('end')
    editor.commands.insertContent('- [ ] ', { applyInputRules: true })
    await flushInputRule()

    // textBefore = 'hello - [ ] ' which does NOT match /^- \[ \] $/.
    expect(onCheckbox).not.toHaveBeenCalled()
    expect(editor.state.doc.child(0).textContent).toBe('hello - [ ] ')
  })

  it('appending after a paragraph that already starts with "- [ ] " does NOT re-trigger', async () => {
    // Initial paragraph already contains "- [ ] task". The cursor is at
    // the end; typing a single space should not refire the input rule
    // because textBefore = "- [ ] task " does not match.
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox, '- [ ] task')
    editor.commands.focus('end')
    editor.commands.insertContent(' ', { applyInputRules: true })
    await flushInputRule()

    expect(onCheckbox).not.toHaveBeenCalled()
    expect(editor.state.doc.child(0).textContent).toBe('- [ ] task ')
  })

  it('typing "- [ ] " inside a code block does NOT trigger', async () => {
    const onCheckbox = vi.fn()
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        History,
        CodeBlock,
        CheckboxInputRule.configure({ onCheckbox }),
      ],
      content: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [] }],
      },
    })
    editor.commands.focus('end')
    editor.commands.insertContent('- [ ] ', { applyInputRules: true })
    await flushInputRule()

    // The InputRule plugin's run() bails out for code-marked / code-block
    // contexts ($from.parent.type.spec.code), so the rule must not fire.
    expect(onCheckbox).not.toHaveBeenCalled()
    expect(editor.state.doc.child(0).textContent).toBe('- [ ] ')
  })

  it('pasting (no applyInputRules meta) does NOT trigger the rule', async () => {
    // Default insertContent does not set the applyInputRules meta —
    // mirrors paste behavior, which dispatches text without going through
    // handleTextInput. The rule must remain inert.
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox)
    editor.commands.insertContent('- [ ] ') // no { applyInputRules: true }
    await flushInputRule()

    expect(onCheckbox).not.toHaveBeenCalled()
    expect(editor.state.doc.child(0).textContent).toBe('- [ ] ')
  })

  it('undoInputRule restores the typed text in a single step', async () => {
    // ProseMirror's standard "undo input rule" command (bound to
    // Backspace by default, immediately after a rule fires) restores
    // the user's literal typed text. This is the behaviour the user
    // sees when they hit Ctrl+Z / Backspace right after `- [ ] `
    // disappears: the trigger comes back so they can correct it.
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox)
    editor.commands.insertContent('- [ ] ', { applyInputRules: true })
    await flushInputRule()

    // Pre-undo: rule fired, paragraph is empty.
    expect(onCheckbox).toHaveBeenCalledWith('TODO')
    expect(editor.state.doc.child(0).textContent).toBe('')

    const undid = editor.commands.undoInputRule()
    expect(undid).toBe(true)

    // After undoInputRule, the typed text reappears.
    expect(editor.state.doc.child(0).textContent).toBe('- [ ] ')
  })

  it('rule with onCheckbox=null still deletes the trigger text without crashing', async () => {
    // Default options have `onCheckbox: null`. The handler uses optional
    // chaining (`this.options.onCheckbox?.(...)`) so the deletion still
    // runs even when no callback is registered.
    editor = buildEditor(null)
    editor.commands.insertContent('- [ ] ', { applyInputRules: true })
    await flushInputRule()

    expect(editor.state.doc.child(0).textContent).toBe('')
  })

  it('extension registers an inputRules ProseMirror plugin on the editor view', () => {
    editor = buildEditor(vi.fn())
    // The TipTap input-rules plugin sets `isInputRules: true` on its
    // PluginSpec (see core/src/InputRule.ts).
    const hasInputRulesPlugin = editor.view.state.plugins.some(
      (p) => (p as unknown as { spec: { isInputRules?: boolean } }).spec.isInputRules === true,
    )
    expect(hasInputRulesPlugin).toBe(true)
  })

  it('booting the extension does not leave orphaned suggestion-popup elements (Pitfall 23)', () => {
    // CheckboxInputRule has no popup / portal — it's a pure text rule.
    // This regression-guards against a future change accidentally
    // wiring a portal in without registering it via
    // EDITOR_PORTAL_SELECTORS.
    editor = buildEditor(vi.fn())
    expect(document.querySelectorAll('.suggestion-popup').length).toBe(0)
    expect(document.querySelectorAll('[data-editor-portal]').length).toBe(0)
  })

  it('rule fires only once for a single matching insert (no double-fire)', async () => {
    const onCheckbox = vi.fn()
    editor = buildEditor(onCheckbox)
    editor.commands.insertContent('- [ ] ', { applyInputRules: true })
    await flushInputRule()
    // A single matching insert must produce exactly one onCheckbox call.
    expect(onCheckbox).toHaveBeenCalledTimes(1)
  })
})
