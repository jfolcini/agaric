import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { applyCustomCss, CUSTOM_CSS_ELEMENT_ID, useCustomCss } from '@/hooks/useCustomCss'

const sheet = () => document.getElementById(CUSTOM_CSS_ELEMENT_ID)

afterEach(() => {
  localStorage.clear()
  sheet()?.remove()
})

describe('applyCustomCss', () => {
  it('writes one style element, last in the head, and rewrites it in place', () => {
    document.head.append(document.createElement('link'))
    applyCustomCss('a { color: red }', true)
    expect(document.head.lastElementChild).toBe(sheet())
    applyCustomCss('a { color: blue }', true)
    expect(document.querySelectorAll(`#${CUSTOM_CSS_ELEMENT_ID}`)).toHaveLength(1)
    expect(sheet()?.textContent).toBe('a { color: blue }')
  })

  it('removes the element when switched off or emptied', () => {
    applyCustomCss('a { color: red }', true)
    applyCustomCss('a { color: red }', false)
    expect(sheet()).toBeNull()
    applyCustomCss('a { color: red }', true)
    applyCustomCss('  ', true)
    expect(sheet()).toBeNull()
  })
})

describe('useCustomCss', () => {
  it('applies the stored stylesheet at mount and follows the switch', () => {
    localStorage.setItem('agaric-custom-css', ':root { --radius: 0 }')
    const { result } = renderHook(() => useCustomCss())
    expect(sheet()?.textContent).toBe(':root { --radius: 0 }')

    act(() => result.current.setEnabled(false))
    expect(sheet()).toBeNull()
    expect(localStorage.getItem('agaric-custom-css-enabled')).toBe('false')
  })

  it('applies nothing when the stored switch is off', () => {
    localStorage.setItem('agaric-custom-css', '* { display: none }')
    localStorage.setItem('agaric-custom-css-enabled', 'false')
    const { result } = renderHook(() => useCustomCss())
    expect(result.current.enabled).toBe(false)
    expect(sheet()).toBeNull()
  })
})
