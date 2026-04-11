import { describe, expect, it, vi } from 'vitest'
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
