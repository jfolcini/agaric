/**
 * Tests for BlockContextMenu component.
 *
 * Validates:
 *  - Renders all menu items when callbacks are wired
 *  - Clicking Delete calls onDelete
 *  - Clicking Indent calls onIndent
 *  - Clicking Dedent calls onDedent
 *  - Clicking Set as TODO calls onToggleTodo
 *  - Clicking Set priority 1 calls onTogglePriority
 *  - Clicking Move Up calls onMoveUp
 *  - Clicking Move Down calls onMoveDown
 *  - Clicking Collapse/Expand calls onToggleCollapse
 *  - State-aware labels for TODO and Priority
 *  - Keyboard navigation (ArrowDown/Up, Home, End, Enter)
 *  - Shortcut hints rendered
 *  - Separators between groups
 *  - Collapse/Expand only shown when hasChildren
 *  - Clicking outside closes the menu
 *  - Pressing Escape closes the menu
 *  - Menu is rendered via portal (into document.body)
 *  - Position is correctly applied
 *  - a11y: axe audit passes
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { BlockContextMenu, type BlockContextMenuProps } from '@/components/editor/BlockContextMenu'
import type { BlockActions } from '@/hooks/useBlockActions'
import { writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'
import { resetAllShortcuts, setCustomShortcut } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { openUrl } from '@/lib/open-url'
import { __resetPlatformCacheForTests, isMac } from '@/lib/platform'
import { useBlockStore } from '@/stores/blocks'

vi.mock('@floating-ui/dom', () => ({
  // Base impl resolves anchor coords AND runs any size() middleware's `apply`
  // against the real floating element with a short available height, so the
  // #987 max-height/scroll wiring is exercised exactly as in production
  // (the real computePosition invokes size's apply during layout).
  computePosition: vi.fn(
    (_ref: unknown, floating: HTMLElement, opts?: { middleware?: unknown[] }) => {
      for (const m of opts?.middleware ?? []) {
        if (m && typeof m === 'object' && '_sizeApply' in m) {
          ;(m as { _sizeApply: (a: unknown) => void })._sizeApply({
            availableHeight: 150,
            elements: { floating },
          })
        }
      }
      return Promise.resolve({ x: 0, y: 0 })
    },
  ),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
  offset: vi.fn(() => ({})),
  size: vi.fn((opts: { apply: (a: unknown) => void }) => ({ _sizeApply: opts.apply })),
  // `autoUpdate(reference, floating, update)` invokes `update` once
  // synchronously and returns a cleanup function. Mirror that behavior
  // in the test mock so positioning is exercised exactly as in
  // production but without the resize/scroll listeners.
  autoUpdate: vi.fn((_ref: unknown, _floating: unknown, update: () => void) => {
    update()
    return () => {}
  }),
}))

// Mock the clipboard wrapper used by the "Copy URL" menu item so the test
// does not depend on `@tauri-apps/plugin-clipboard-manager` IPC.
vi.mock('@/lib/clipboard', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
const mockedWriteText = vi.mocked(writeText)

// Mock the openUrl wrapper used by the "Open link" menu item so the test does
// not depend on `@tauri-apps/plugin-shell` IPC.
vi.mock('@/lib/open-url', () => ({
  openUrl: vi.fn().mockResolvedValue(true),
}))
const mockedOpenUrl = vi.mocked(openUrl)

beforeEach(() => {
  vi.clearAllMocks()
  mockedWriteText.mockResolvedValue(undefined)
  mockedOpenUrl.mockResolvedValue(true)
  // #1018 — the menu now reads the global selection from the store when no
  // explicit `selectedBlockIds` prop is passed. Reset it so prop-less tests see
  // an empty (single-block) selection and don't leak between cases.
  useBlockStore.getState().clearSelected()
})

// A2 (#1020) — the menu now takes a single `actions: BlockActions` bag instead
// of ~15 individual callback props. To keep the (many) existing test call sites
// readable, `renderMenu` still accepts the action callbacks FLAT (e.g.
// `renderMenu({ onMerge: vi.fn() })`) and folds them into the bag internally;
// the returned `props` re-expose those callbacks flat too, so assertions like
// `expect(props.onDelete).toHaveBeenCalledWith(...)` keep working.
const ACTION_KEYS = [
  'onDelete',
  'onIndent',
  'onDedent',
  'onToggleTodo',
  'onTogglePriority',
  'onToggleCollapse',
  'onMoveUp',
  'onMoveDown',
  'onMerge',
  'onShowHistory',
  'onShowProperties',
  'onZoomIn',
  'onTurnInto',
  'onDuplicate',
  'onBatchDelete',
] as const satisfies ReadonlyArray<keyof BlockActions>

type ActionKey = (typeof ACTION_KEYS)[number]
const ACTION_KEY_SET = new Set<string>(ACTION_KEYS)

// Structural / non-action props of the menu.
type StructuralOverrides = Omit<BlockContextMenuProps, 'actions'>
// Flat-action overrides: any BlockActions key, individually settable.
type ActionOverrides = { [K in ActionKey]?: BlockActions[K] | undefined }
type MenuOverrides = { [K in keyof StructuralOverrides]?: StructuralOverrides[K] | undefined } & {
  [K in keyof ActionOverrides]?: ActionOverrides[K]
} & { actions?: BlockActions | undefined }

function renderMenu(overrides: MenuOverrides = {}) {
  const structuralDefaults = {
    blockId: 'BLOCK_01' as string,
    position: { x: 100, y: 200 },
    onClose: vi.fn(),
    hasChildren: true,
    isCollapsed: false,
    todoState: null as string | null,
    priority: null as string | null,
  }
  const actionDefaults: BlockActions = {
    onDelete: vi.fn(),
    onIndent: vi.fn(),
    onDedent: vi.fn(),
    onToggleTodo: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleCollapse: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
  }

  // Split the flat overrides into action vs. structural buckets.
  const actionOverrides: Partial<BlockActions> = {}
  const structuralOverrides: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'actions') continue
    if (ACTION_KEY_SET.has(key)) {
      ;(actionOverrides as Record<string, unknown>)[key] = value
    } else {
      structuralOverrides[key] = value
    }
  }

  // Build the action bag (defaults + per-action overrides + an explicit
  // `actions` bag override, the last winning). Drop keys explicitly set to
  // undefined so a missing action is truly absent from the bag.
  const actions: BlockActions = {
    ...actionDefaults,
    ...actionOverrides,
    ...overrides.actions,
  }
  for (const key of Object.keys(actions) as (keyof BlockActions)[]) {
    if (actions[key] === undefined) {
      delete actions[key]
    }
  }

  const structural = { ...structuralDefaults, ...structuralOverrides }
  for (const key of Object.keys(structural) as (keyof typeof structural)[]) {
    if (structural[key] === undefined) {
      delete structural[key]
    }
  }

  const finalProps = { ...structural, actions } as BlockContextMenuProps
  const result = render(<BlockContextMenu {...finalProps} />)
  // Re-expose the action callbacks flat on `props` so existing assertions
  // (`props.onDelete`, `props.onMerge`, …) keep working unchanged.
  return { ...result, props: { ...finalProps, ...actions } }
}

// #1109 — Move up / Move down / Duplicate / Merge are collapsed behind a "Move &
// arrange" disclosure toggle. Expand it so the nested rows become reachable.
async function expandMoveArrange(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.moveArrange')) }))
}

describe('BlockContextMenu', () => {
  it('renders all menu items when all callbacks are wired', async () => {
    const user = userEvent.setup()
    renderMenu()

    const menu = screen.getByRole('menu')
    // Top-level rows.
    expect(within(menu).getByText(t('contextMenu.delete'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.collapse'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.setTodo'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.setPriority1'))).toBeInTheDocument()
    // Indent / Dedent / Move up / Move down are nested under the "Move &
    // arrange" disclosure toggle and surface only when it expands.
    expect(within(menu).getByText(t('contextMenu.moveArrange'))).toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.indent'))).not.toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.dedent'))).not.toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.moveUp'))).not.toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.moveDown'))).not.toBeInTheDocument()

    await expandMoveArrange(user)
    expect(within(menu).getByText(t('contextMenu.indent'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.dedent'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.moveUp'))).toBeInTheDocument()
    expect(within(menu).getByText(t('contextMenu.moveDown'))).toBeInTheDocument()
  })

  it('clicking Delete calls onDelete with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.delete')))

    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Indent calls onIndent with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    // Indent is nested under the "Move & arrange" disclosure.
    await expandMoveArrange(user)
    await user.click(screen.getByText(t('contextMenu.indent')))

    expect(props.onIndent).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Dedent calls onDedent with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    // Dedent is nested under the "Move & arrange" disclosure.
    await expandMoveArrange(user)
    await user.click(screen.getByText(t('contextMenu.dedent')))

    expect(props.onDedent).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Set as TODO calls onToggleTodo with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.setTodo')))

    expect(props.onToggleTodo).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Set priority 1 calls onTogglePriority with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    await user.click(screen.getByText(t('contextMenu.setPriority1')))

    expect(props.onTogglePriority).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Move Up calls onMoveUp with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    // #1109 — Move up is nested under the "Move & arrange" disclosure.
    await expandMoveArrange(user)
    await user.click(screen.getByText(t('contextMenu.moveUp')))

    expect(props.onMoveUp).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Move Down calls onMoveDown with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    // #1109 — Move down is nested under the "Move & arrange" disclosure.
    await expandMoveArrange(user)
    await user.click(screen.getByText(t('contextMenu.moveDown')))

    expect(props.onMoveDown).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Collapse calls onToggleCollapse with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ hasChildren: true, isCollapsed: false })

    await user.click(screen.getByText(t('contextMenu.collapse')))

    expect(props.onToggleCollapse).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clicking Expand calls onToggleCollapse when isCollapsed is true', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ hasChildren: true, isCollapsed: true })

    await user.click(screen.getByText(t('contextMenu.expand')))

    expect(props.onToggleCollapse).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── State-aware labels ──────────────────────────────────────────

  it('shows "TODO → DOING" when todoState is TODO', () => {
    renderMenu({ todoState: 'TODO' })
    expect(screen.getByText(t('contextMenu.todoToDoing'))).toBeInTheDocument()
  })

  it('shows "DOING → DONE" when todoState is DOING', () => {
    renderMenu({ todoState: 'DOING' })
    expect(screen.getByText(t('contextMenu.doingToDone'))).toBeInTheDocument()
  })

  it('shows "DONE → CANCELLED" when todoState is DONE', () => {
    renderMenu({ todoState: 'DONE' })
    expect(screen.getByText(t('contextMenu.doneToCancelled'))).toBeInTheDocument()
  })

  it('shows "CANCELLED → Clear" when todoState is CANCELLED', () => {
    renderMenu({ todoState: 'CANCELLED' })
    expect(screen.getByText(t('contextMenu.cancelledToClear'))).toBeInTheDocument()
  })

  it('shows "Priority 1 → 2" when priority is 1', () => {
    renderMenu({ priority: '1' })
    expect(screen.getByText(t('contextMenu.priority1To2'))).toBeInTheDocument()
  })

  it('shows "Priority 2 → 3" when priority is 2', () => {
    renderMenu({ priority: '2' })
    expect(screen.getByText(t('contextMenu.priority2To3'))).toBeInTheDocument()
  })

  it('shows "Priority 3 → Clear" when priority is 3', () => {
    renderMenu({ priority: '3' })
    expect(screen.getByText(t('contextMenu.priority3ToClear'))).toBeInTheDocument()
  })

  // ── Collapse/Expand visibility ─────────────────────────────────

  it('does not show Collapse/Expand when hasChildren is false', () => {
    renderMenu({ hasChildren: false })
    expect(screen.queryByText(t('contextMenu.collapse'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('contextMenu.expand'))).not.toBeInTheDocument()
  })

  it('shows Collapse when hasChildren is true and isCollapsed is false', () => {
    renderMenu({ hasChildren: true, isCollapsed: false })
    expect(screen.getByText(t('contextMenu.collapse'))).toBeInTheDocument()
  })

  it('shows Expand when hasChildren is true and isCollapsed is true', () => {
    renderMenu({ hasChildren: true, isCollapsed: true })
    expect(screen.getByText(t('contextMenu.expand'))).toBeInTheDocument()
  })

  // Zoom in is ungated (2026-06-20): it works for ANY block, including leaves,
  // now that the inline any-block zoom bullet was removed. Collapse/Expand stays
  // children-gated, so a leaf shows Zoom in but no Collapse/Expand.
  it('shows Zoom in for a leaf block (hasChildren false) when onZoomIn is provided', () => {
    renderMenu({ hasChildren: false, onZoomIn: vi.fn() })
    expect(screen.getByText(t('contextMenu.zoomIn'))).toBeInTheDocument()
    expect(screen.queryByText(t('contextMenu.collapse'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('contextMenu.expand'))).not.toBeInTheDocument()
  })

  // ── Keyboard navigation ─────────────────────────────────────────

  it('ArrowDown moves focus to next item', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // First item should be focused initially
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
  })

  it('ArrowUp moves focus to previous item (wraps)', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // First item focused, ArrowUp wraps to last
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })
    expect(items.at(-1)).toHaveFocus()
  })

  it('Home moves focus to first item', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    // Move down a couple times first
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })

    fireEvent.keyDown(menu, { key: 'Home' })
    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()
  })

  it('End moves focus to last item', () => {
    renderMenu()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    const items = screen.getAllByRole('menuitem')
    expect(items.at(-1)).toHaveFocus()
  })

  it('ArrowDown wraps from last item to first', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    const items = screen.getAllByRole('menuitem')
    // Move to last item
    fireEvent.keyDown(menu, { key: 'End' })
    expect(items.at(-1)).toHaveFocus()

    // ArrowDown should wrap to first
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[0]).toHaveFocus()
  })

  it('Enter activates the focused menu item', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()

    // #1445 — the link group (now always present via "Copy block reference")
    // leads the menu, so the focused first item is "Copy block reference".
    // Enter activates it: it copies `((BLOCK_01))` and closes.
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(mockedWriteText).toHaveBeenCalledWith('((BLOCK_01))')
    })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('#217 A1 — destructive Delete is the last item, never the first', () => {
    renderMenu()
    const items = screen.getAllByRole('menuitem')
    expect(items.length).toBeGreaterThan(1)
    // Delete sits at the bottom so it can't be mis-clicked / Enter-activated
    // on open; the first item is a non-destructive action.
    expect(items.at(-1)).toHaveTextContent(t('contextMenu.delete'))
    expect(items[0]).not.toHaveTextContent(t('contextMenu.delete'))
  })

  // ── Shortcut hints ──────────────────────────────────────────────

  it('renders shortcut hints for top-level items', async () => {
    // #976 (items 16-19) — wire the actions whose hints were previously missing
    // (merge, zoom-in) so we can assert their newly-added shortcut hints too.
    const user = userEvent.setup()
    renderMenu({ onMerge: vi.fn(), onZoomIn: vi.fn(), onShowHistory: vi.fn() })

    const menu = screen.getByRole('menu')
    // Hints on rows that stay top-level (tasks, view, history, delete).
    expect(within(menu).getByText('Ctrl+.')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Enter')).toBeInTheDocument()
    // #976 (item 19) — alternation notation, no longer the ambiguous "1-3".
    expect(within(menu).getByText('Ctrl+Shift+1/2/3')).toBeInTheDocument()
    expect(within(menu).queryByText('Ctrl+Shift+1-3')).not.toBeInTheDocument()
    // #976 (item 16) — delete hint (positional: Backspace when empty).
    expect(within(menu).getByText('Backspace (when empty)')).toBeInTheDocument()
    // #976 (item 18) — zoom-in hint (Alt+.).
    expect(within(menu).getByText('Alt+.')).toBeInTheDocument()
    // #976 (item 15) — block-history keyboard binding hint.
    expect(within(menu).getByText('Ctrl+Shift+Y')).toBeInTheDocument()

    // Indent / Dedent moved behind the "Move & arrange" disclosure; their hints
    // surface once it expands.
    expect(within(menu).queryByText('Ctrl+Shift+→')).not.toBeInTheDocument()
    expect(within(menu).queryByText('Ctrl+Shift+←')).not.toBeInTheDocument()
    await expandMoveArrange(user)
    expect(within(menu).getByText('Ctrl+Shift+→')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Shift+←')).toBeInTheDocument()
  })

  // #1728 — the hints are no longer hardcoded literals; they are sourced from
  // the keyboard catalog via `getShortcutKeys(id)`, so a user rebind shows up
  // immediately and the platform modifier glyph (⌘ on macOS) is respected.
  describe('#1728 — shortcut hints reflect the live catalog binding', () => {
    const originalUserAgentData = Object.getOwnPropertyDescriptor(navigator, 'userAgentData')

    afterEach(() => {
      // Drop any override + platform spoofing so later tests see defaults.
      resetAllShortcuts()
      if (originalUserAgentData) {
        Object.defineProperty(navigator, 'userAgentData', originalUserAgentData)
      } else {
        // jsdom has no userAgentData by default; remove the spoof we set.
        Reflect.deleteProperty(navigator, 'userAgentData')
      }
      __resetPlatformCacheForTests()
    })

    it('reflects a user rebind of a context-menu action', async () => {
      // Rebind "indent" from the default Ctrl+Shift+→ to Alt+Shift+→.
      const user = userEvent.setup()
      setCustomShortcut('indentBlock', 'Alt + Shift + Arrow Right')
      renderMenu()
      const menu = screen.getByRole('menu')
      // Indent lives behind the "Move & arrange" disclosure; expand to reveal it.
      await expandMoveArrange(user)
      // The remapped binding is shown; the stale default is gone.
      expect(within(menu).getByText('Alt+Shift+→')).toBeInTheDocument()
      expect(within(menu).queryByText('Ctrl+Shift+→')).not.toBeInTheDocument()
    })

    it('uses the ⌘ glyph for the Ctrl modifier on macOS', () => {
      // Spoof macOS via UA-CH so `modKey()` resolves to ⌘ (mirrors platform.test.ts).
      Object.defineProperty(navigator, 'userAgentData', {
        value: { platform: 'macOS' },
        configurable: true,
        writable: true,
      })
      __resetPlatformCacheForTests()
      expect(isMac()).toBe(true)
      renderMenu()
      const menu = screen.getByRole('menu')
      // Collapse/expand hint becomes ⌘+. instead of Ctrl+.
      expect(within(menu).getByText('⌘+.')).toBeInTheDocument()
      expect(within(menu).queryByText('Ctrl+.')).not.toBeInTheDocument()
    })
  })

  it('#1109 — surfaces the move/merge hints once "Move & arrange" is expanded', async () => {
    // #1109 — the move/merge shortcut hints (the primary discoverability path
    // for those chords) must NOT be dropped — they relocate behind the
    // "Move & arrange" disclosure and appear when it expands.
    const user = userEvent.setup()
    renderMenu({ onMerge: vi.fn() })

    const menu = screen.getByRole('menu')
    // Collapsed: the nested hints are not yet rendered.
    expect(within(menu).queryByText('Ctrl+Shift+↑')).not.toBeInTheDocument()
    expect(within(menu).queryByText('Ctrl+Shift+↓')).not.toBeInTheDocument()
    expect(within(menu).queryByText('Backspace (at start)')).not.toBeInTheDocument()

    await expandMoveArrange(user)

    expect(within(menu).getByText('Ctrl+Shift+↑')).toBeInTheDocument()
    expect(within(menu).getByText('Ctrl+Shift+↓')).toBeInTheDocument()
    // #976 (item 17) — merge hint (positional: Backspace at block start).
    expect(within(menu).getByText('Backspace (at start)')).toBeInTheDocument()
  })

  // #976 (item 13) — Duplicate action: present in the menu and dispatches.
  // #1109 — Duplicate now lives under the "Move & arrange" disclosure.
  describe('duplicate action (#976)', () => {
    it('renders a Duplicate item when onDuplicate is wired (under Move & arrange)', async () => {
      const user = userEvent.setup()
      renderMenu({ onDuplicate: vi.fn() })
      await expandMoveArrange(user)
      const menu = screen.getByRole('menu')
      expect(within(menu).getByText(t('contextMenu.duplicate'))).toBeInTheDocument()
    })

    // #976 (item 13) — the Duplicate row surfaces its new keyboard binding hint.
    it('shows the Ctrl+Shift+J binding hint on the Duplicate row', async () => {
      const user = userEvent.setup()
      renderMenu({ onDuplicate: vi.fn() })
      await expandMoveArrange(user)
      const menu = screen.getByRole('menu')
      expect(within(menu).getByText('Ctrl+Shift+J')).toBeInTheDocument()
    })

    it('omits Duplicate when onDuplicate is not wired', async () => {
      const user = userEvent.setup()
      renderMenu()
      await expandMoveArrange(user)
      expect(screen.queryByText(t('contextMenu.duplicate'))).not.toBeInTheDocument()
    })

    it('dispatches onDuplicate with the block id on click', async () => {
      const user = userEvent.setup()
      const onDuplicate = vi.fn()
      renderMenu({ onDuplicate, blockId: 'BLOCK_99' })
      await expandMoveArrange(user)
      await user.click(screen.getByText(t('contextMenu.duplicate')))
      expect(onDuplicate).toHaveBeenCalledWith('BLOCK_99')
    })

    it('omits Duplicate in bulk (multi-selection) mode', async () => {
      const user = userEvent.setup()
      renderMenu({
        onDuplicate: vi.fn(),
        blockId: 'BLOCK_01',
        selectedBlockIds: ['BLOCK_01', 'BLOCK_02'],
      })
      // Even with the disclosure expanded, Duplicate stays absent in bulk mode.
      await expandMoveArrange(user)
      expect(screen.queryByText(t('contextMenu.duplicate'))).not.toBeInTheDocument()
    })
  })

  // ── Separators ──────────────────────────────────────────────────

  it('renders separators between groups', () => {
    renderMenu()

    const separators = screen.getAllByRole('separator')
    // #1445 — the link group is now always present ("Copy block reference"),
    // so the default menu has 5 groups (link · tasks · move/arrange · view ·
    // delete) → 4 separators.
    expect(separators.length).toBe(4)
  })

  // ── Existing tests (updated) ────────────────────────────────────

  it('clicking outside the menu closes it', async () => {
    const { props } = renderMenu()

    // The outside-click listener is registered via requestAnimationFrame
    // so the same pointerdown that opened the menu doesn't immediately
    // close it. Wait one frame before firing, mirroring real usage.
    await new Promise((resolve) => requestAnimationFrame(resolve))

    // Fire pointerdown on document body (outside menu)
    fireEvent.pointerDown(document.body)

    expect(props.onClose).toHaveBeenCalled()
  })

  it('pressing Escape closes the menu', () => {
    const { props } = renderMenu()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(props.onClose).toHaveBeenCalled()
  })

  it('restores focus to triggerRef element on Escape', () => {
    const triggerEl = document.createElement('div')
    triggerEl.tabIndex = -1
    document.body.append(triggerEl)
    const triggerRef = { current: triggerEl }
    const focusSpy = vi.spyOn(triggerEl, 'focus')

    renderMenu({ triggerRef })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(focusSpy).toHaveBeenCalled()
    document.body.removeChild(triggerEl)
  })

  it('falls back to the block gutter button when the trigger has been removed', () => {
    // Simulate a block whose trigger element was removed during the menu's
    // lifetime (e.g. block deleted by a remote sync). The menu should focus
    // the matching `[data-block-id]` gutter button rather than letting focus
    // Drop to <body>. the marker is `data-context-trigger="true"`
    // on the gutter drag handle (intentionally narrower than `[role="button"]`,
    // which would also match inline date chips, property chips, etc.).
    const blockEl = document.createElement('div')
    blockEl.setAttribute('data-block-id', 'BLOCK_01')
    const fallbackBtn = document.createElement('button')
    fallbackBtn.setAttribute('data-context-trigger', 'true')
    blockEl.append(fallbackBtn)
    document.body.append(blockEl)

    const fallbackFocusSpy = vi.spyOn(fallbackBtn, 'focus')

    // triggerRef.current === null simulates the trigger having been
    // unmounted (React clears the ref to null on unmount).
    const triggerRef = { current: null as HTMLElement | null }
    renderMenu({ triggerRef })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(fallbackFocusSpy).toHaveBeenCalled()
    document.body.removeChild(blockEl)
  })

  it('menu is rendered via portal into document.body', () => {
    renderMenu()

    // The menu should be a direct child of document.body (portal)
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
  })

  it('menu container has .block-context-menu class (B-15)', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(menu.classList.contains('block-context-menu')).toBe(true)
  })

  it('position is correctly applied as CSS style', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    const mockedComputePosition = vi.mocked(computePosition)
    mockedComputePosition.mockResolvedValueOnce({
      x: 150,
      y: 300,
      placement: 'bottom-start',
      strategy: 'absolute',
      middlewareData: {},
    })

    renderMenu({ position: { x: 150, y: 300 } })

    const menu = screen.getByRole('menu')
    await waitFor(() => {
      expect(menu.style.left).toBe('150px')
      expect(menu.style.top).toBe('300px')
    })
  })

  it('caps menu height and enables scrolling when the viewport is short (#987)', async () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    await waitFor(() => {
      // size() apply ran with availableHeight=150 (see the floating-ui mock).
      expect(menu.style.maxHeight).toBe('150px')
      expect(menu.style.overflowY).toBe('auto')
    })
  })

  it('renders only the always-present Copy block reference when no bag actions are wired (#1445)', () => {
    renderMenu({
      onDelete: undefined,
      onIndent: undefined,
      onDedent: undefined,
      onToggleTodo: undefined,
      onTogglePriority: undefined,
      onToggleCollapse: undefined,
      onMoveUp: undefined,
      onMoveDown: undefined,
      hasChildren: false,
    })

    // #1445 — "Copy block reference" is always actionable (it only needs the
    // BlockId), so the menu is never a dead end here: the short-circuit
    // (null when zero actionable items) no longer fires once the bag empties.
    // The menu renders with exactly the Copy block reference row; the old
    // bag-driven items stay absent.
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText(t('contextMenu.copyBlockRef'))).toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.delete'))).not.toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.indent'))).not.toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  })

  it('has no a11y violations', async () => {
    const { container } = renderMenu()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('menu items have role="menuitem"', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // Indent / Dedent / Move up / Move down live behind the collapsed "Move &
    // arrange" disclosure. #1445 — the link group is now always present,
    // contributing "Copy block reference" ("Copy page reference" is absent here
    // since no `pageRefId` prop is passed). So the default (collapsed) menu
    // shows 6 rows: Copy block reference, Set as TODO, Set priority 1, Move &
    // arrange (toggle), Collapse, Delete.
    expect(items.length).toBe(6)
  })

  it('menu has aria-label', () => {
    renderMenu()

    const menu = screen.getByRole('menu')
    expect(menu).toHaveAttribute('aria-label', t('contextMenu.blockActions'))
  })

  it('#1000 — interactive menu items carry the focus-visible ring (WCAG 2.4.7)', () => {
    renderMenu()

    const items = screen.getAllByRole('menuitem')
    // Every actionable row uses the app-wide `focus-ring-visible` recipe (a
    // visible ring, decoupled from hover) and contains the ring (`ring-inset`)
    // so it doesn't clip at the popover edge / separators. The redundant
    // `focus-visible:outline-none` is folded into the utility and removed.
    for (const item of items) {
      expect(item.className).toContain('focus-ring-visible')
      expect(item.className).toContain('ring-inset')
      expect(item.className).not.toContain('focus-visible:outline-none')
      expect(item.className).not.toContain('focus-visible:bg-accent')
    }
  })

  // ── History menu item ─────────────────────────────────────────────

  it('does not render History item when onShowHistory is not provided', () => {
    renderMenu({ onShowHistory: undefined })

    expect(screen.queryByText(t('contextMenu.history'))).not.toBeInTheDocument()
  })

  it('renders History item when onShowHistory is provided', () => {
    renderMenu({ onShowHistory: vi.fn() })

    expect(screen.getByText(t('contextMenu.history'))).toBeInTheDocument()
  })

  it('clicking History calls onShowHistory with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ onShowHistory: vi.fn() })

    await user.click(screen.getByText(t('contextMenu.history')))

    expect(props.onShowHistory).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('renders 5 separators when History group is present', () => {
    renderMenu({ onShowHistory: vi.fn() })

    const separators = screen.getAllByRole('separator')
    // #1445 — link group always present + History group: 6 groups → 5 separators.
    expect(separators.length).toBe(5)
  })

  // ── Merge menu item ──────────────────────────────────────────────

  it('renders Merge item when onMerge is provided (under Move & arrange)', async () => {
    const user = userEvent.setup()
    renderMenu({ onMerge: vi.fn() })

    await expandMoveArrange(user)
    expect(screen.getByText(t('contextMenu.merge'))).toBeInTheDocument()
  })

  it('does not render Merge item when onMerge is not provided', async () => {
    const user = userEvent.setup()
    renderMenu({ onMerge: undefined })

    await expandMoveArrange(user)
    expect(screen.queryByText(t('contextMenu.merge'))).not.toBeInTheDocument()
  })

  it('clicking Merge calls onMerge with blockId and closes menu', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ onMerge: vi.fn() })

    await expandMoveArrange(user)
    await user.click(screen.getByText(t('contextMenu.merge')))

    expect(props.onMerge).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── Error paths ───────────────────────────────────────────────────
  //
  // BlockContextMenu has no invoke calls.  The only async operation that can
  // fail is computePosition from @floating-ui/dom, called in a useEffect with
  // .then() but no .catch().  When it fails, setComputedPos is never called
  // and the menu gracefully stays at the initial `position` prop.
  //
  // We use mockImplementationOnce returning a non-settling thenable (same
  // observable effect as a rejection: the onFulfilled handler never fires)
  // so there is no unhandled-rejection noise in the test runner.

  /**
   * A thenable that never settles — the `.then(onFulfilled)` callback is never
   * invoked, which mirrors the observable effect of a rejected promise when the
   * consumer has no `.catch()` handler.  Unlike a real `Promise.reject`, this
   * does not trigger Node's unhandled-rejection tracking.
   */
  function failedPositioning() {
    const thenable: Record<string, () => typeof thenable> = {}
    // Define the promise-like methods via computed keys so no static `then`
    // member is declared (avoids unicorn/no-thenable) while preserving the
    // never-settling-thenable behaviour at runtime.
    for (const key of ['then', 'catch', 'finally']) {
      thenable[key] = () => thenable
    }
    return thenable as unknown as ReturnType<typeof import('@floating-ui/dom').computePosition>
  }

  it('falls back to initial position when computePosition rejects', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    vi.mocked(computePosition).mockImplementationOnce(() => failedPositioning())

    renderMenu({ position: { x: 120, y: 250 } })

    const menu = screen.getByRole('menu')
    // computePosition failed → setComputedPos never called → stays at initial position
    await waitFor(() => {
      expect(menu.style.left).toBe('120px')
      expect(menu.style.top).toBe('250px')
    })
  })

  it('menu items remain functional when computePosition rejects', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    vi.mocked(computePosition).mockImplementationOnce(() => failedPositioning())

    const user = userEvent.setup()
    const { props } = renderMenu({ position: { x: 100, y: 200 } })

    // Menu should still be interactive even though positioning failed
    await user.click(screen.getByText(t('contextMenu.delete')))

    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('keyboard navigation works when computePosition rejects', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    vi.mocked(computePosition).mockImplementationOnce(() => failedPositioning())

    const user = userEvent.setup()
    const { props } = renderMenu()

    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()

    // Navigate to second item and activate
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()

    await user.keyboard('{Enter}')

    // #1445 — the link group leads (item[0]=Copy block reference), so the
    // second item is the Tasks group's TODO cycle.
    expect(props.onToggleTodo).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onClose).toHaveBeenCalled()
  })

  // ── Open link menu item (#924) ──────────────────────────────────

  it('renders "Open link" item when linkUrl is provided', () => {
    renderMenu({ linkUrl: 'https://example.com' })

    expect(screen.getByText(t('contextMenu.openLink'))).toBeInTheDocument()
  })

  it('does not render "Open link" item when linkUrl is undefined', () => {
    renderMenu({ linkUrl: undefined })

    expect(screen.queryByText(t('contextMenu.openLink'))).not.toBeInTheDocument()
  })

  it('clicking "Open link" calls openUrl with the href and closes the menu', async () => {
    const { props } = renderMenu({ linkUrl: 'https://example.com/page' })

    fireEvent.click(screen.getByText(t('contextMenu.openLink')))

    await waitFor(() => {
      expect(mockedOpenUrl).toHaveBeenCalledWith('https://example.com/page')
    })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('"Open link" surfaces an error toast and closes when openUrl reports failure', async () => {
    const errorSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockedOpenUrl.mockResolvedValueOnce(false)
    const { props } = renderMenu({ linkUrl: 'https://example.com/page' })

    fireEvent.click(screen.getByText(t('contextMenu.openLink')))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(t('contextMenu.actionFailed'))
    })
    expect(props.onClose).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('"Open link" is the first menu item when linkUrl is provided', () => {
    renderMenu({ linkUrl: 'https://example.com' })

    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveTextContent(t('contextMenu.openLink'))
  })

  // ── Copy URL menu item ──────────────────────────────────────────

  it('renders "Copy URL" item when linkUrl is provided', () => {
    renderMenu({ linkUrl: 'https://example.com' })

    expect(screen.getByText(t('contextMenu.copyUrl'))).toBeInTheDocument()
  })

  it('does not render "Copy URL" item when linkUrl is undefined', () => {
    renderMenu({ linkUrl: undefined })

    expect(screen.queryByText(t('contextMenu.copyUrl'))).not.toBeInTheDocument()
  })

  it('clicking "Copy URL" copies to clipboard and shows toast', async () => {
    const { props } = renderMenu({ linkUrl: 'https://example.com/page' })

    fireEvent.click(screen.getByText(t('contextMenu.copyUrl')))

    await waitFor(() => {
      expect(mockedWriteText).toHaveBeenCalledWith('https://example.com/page')
    })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('"Copy URL" appears right after "Open link" in the link group when linkUrl is provided', () => {
    renderMenu({ linkUrl: 'https://example.com' })

    const items = screen.getAllByRole('menuitem')
    // #924 — the link group leads the menu: Open link, then Copy URL.
    expect(items[0]).toHaveTextContent(t('contextMenu.openLink'))
    expect(items[1]).toHaveTextContent(t('contextMenu.copyUrl'))
  })

  // ── Copy block / page reference menu items (#1445) ───────────────

  describe('copy block/page reference (#1445)', () => {
    it('renders "Copy block reference" even when not on a link', () => {
      renderMenu()
      expect(screen.getByText(t('contextMenu.copyBlockRef'))).toBeInTheDocument()
    })

    it('renders "Copy page reference" when pageRefId is provided', () => {
      renderMenu({ pageRefId: 'PAGE_01' })
      expect(screen.getByText(t('contextMenu.copyPageRef'))).toBeInTheDocument()
    })

    it('does not render "Copy page reference" when pageRefId is undefined', () => {
      renderMenu({ pageRefId: undefined })
      expect(screen.queryByText(t('contextMenu.copyPageRef'))).not.toBeInTheDocument()
    })

    it('clicking "Copy block reference" writes ((ULID)) and shows toast + closes', async () => {
      const { props } = renderMenu({ blockId: 'BLOCK_42' })

      fireEvent.click(screen.getByText(t('contextMenu.copyBlockRef')))

      await waitFor(() => {
        expect(mockedWriteText).toHaveBeenCalledWith('((BLOCK_42))')
      })
      expect(toast.success).toHaveBeenCalledWith(t('contextMenu.blockRefCopied'))
      expect(props.onClose).toHaveBeenCalled()
    })

    it('clicking "Copy page reference" writes [[ULID]] (not a bare ULID) and shows toast + closes', async () => {
      const { props } = renderMenu({ blockId: 'BLOCK_42', pageRefId: 'PAGE_07' })

      fireEvent.click(screen.getByText(t('contextMenu.copyPageRef')))

      await waitFor(() => {
        expect(mockedWriteText).toHaveBeenCalledWith('[[PAGE_07]]')
      })
      // Must NOT replicate the palette "copy id" bug that copies a bare ULID.
      expect(mockedWriteText).not.toHaveBeenCalledWith('PAGE_07')
      expect(toast.success).toHaveBeenCalledWith(t('contextMenu.pageRefCopied'))
      expect(props.onClose).toHaveBeenCalled()
    })

    it('page reference uses the containing page id when the target is not itself a page', async () => {
      // SortableBlock resolves pageRefId to the CONTAINING page when the block
      // is an ordinary block (block_type !== 'page'); the menu copies exactly
      // that id wrapped in [[…]]. Here blockId is the block, pageRefId its page.
      renderMenu({ blockId: 'CHILD_BLOCK', pageRefId: 'CONTAINING_PAGE' })

      fireEvent.click(screen.getByText(t('contextMenu.copyPageRef')))

      await waitFor(() => {
        expect(mockedWriteText).toHaveBeenCalledWith('[[CONTAINING_PAGE]]')
      })
      // The block's own id is the block ref, never the page ref.
      expect(mockedWriteText).not.toHaveBeenCalledWith('[[CHILD_BLOCK]]')
    })

    it('surfaces an error toast and still closes when the clipboard write fails', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
      mockedWriteText.mockRejectedValueOnce(new Error('clipboard boom'))
      const { props } = renderMenu({ blockId: 'BLOCK_42' })

      fireEvent.click(screen.getByText(t('contextMenu.copyBlockRef')))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(t('contextMenu.copyRefFailed'))
      })
      expect(props.onClose).toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('has no a11y violations with both reference items present', async () => {
      const { container } = renderMenu({ pageRefId: 'PAGE_01' })
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── Floating UI safeguards ───────────────────────────
  //
  // These tests cover the four AGENTS.md §"Floating UI lifecycle
  // logging" requirements: autoUpdate, isConnected stale-unmount
  // guard, rAF-deferred outside-click registration, and
  // computePosition rejection fallback.

  describe('floating-ui lifecycle safeguards', () => {
    it('safeguard #1 — registers an autoUpdate cleanup so the menu reflows on scroll/resize', async () => {
      const { autoUpdate, computePosition } = await import('@floating-ui/dom')
      const mockedAutoUpdate = vi.mocked(autoUpdate)
      const mockedComputePosition = vi.mocked(computePosition)
      mockedAutoUpdate.mockClear()
      mockedComputePosition.mockClear()

      const { unmount } = renderMenu({ position: { x: 100, y: 200 } })

      // autoUpdate should be invoked on mount with (virtualReference,
      // floatingElement, updateCallback).
      expect(mockedAutoUpdate).toHaveBeenCalledTimes(1)
      const [, floatingArg, updateCb] = mockedAutoUpdate.mock.calls[0] as [
        unknown,
        HTMLElement,
        () => void,
      ]
      expect(floatingArg).toBeInstanceOf(HTMLElement)
      expect(typeof updateCb).toBe('function')

      // The first synchronous tick from our mock invoked the update,
      // which calls computePosition once.
      expect(mockedComputePosition).toHaveBeenCalledTimes(1)

      // Manually re-invoking the update (simulating a scroll/resize
      // event under real autoUpdate) calls computePosition again —
      // the menu reflows.
      updateCb()
      expect(mockedComputePosition).toHaveBeenCalledTimes(2)

      // The cleanup function returned by autoUpdate is honoured on
      // unmount. (Our mock returns a no-op so we just assert no throw.)
      expect(() => unmount()).not.toThrow()
    })

    it('safeguard #2 — bails with logger.warn when the trigger is unmounted before the update fires', async () => {
      const { autoUpdate, computePosition } = await import('@floating-ui/dom')
      const mockedAutoUpdate = vi.mocked(autoUpdate)
      const mockedComputePosition = vi.mocked(computePosition)

      // Replace the default autoUpdate mock with one that does NOT
      // synchronously invoke the update — we want to drive it manually
      // after detaching the trigger from the DOM.
      let captured: (() => void) | null = null
      mockedAutoUpdate.mockImplementationOnce(((_ref, _floating, update) => {
        captured = update as () => void
        return () => {}
      }) as typeof autoUpdate)

      const triggerEl = document.createElement('button')
      document.body.append(triggerEl)
      const triggerRef = { current: triggerEl }

      const { logger: loggerMod } = await import('@/lib/logger')
      const warnSpy = vi.spyOn(loggerMod, 'warn').mockImplementation(() => {})
      mockedComputePosition.mockClear()

      renderMenu({ triggerRef })

      // Detach the trigger before the update tick runs.
      triggerEl.remove()
      expect(triggerEl.isConnected).toBe(false)

      // Drive the deferred update — should bail loudly.
      expect(captured).not.toBeNull()
      ;(captured as unknown as () => void)()

      expect(warnSpy).toHaveBeenCalledWith(
        'BlockContextMenu',
        'trigger unmounted, skipping update',
        expect.objectContaining({ blockId: 'BLOCK_01' }),
      )
      // computePosition must NOT run when the guard fires.
      expect(mockedComputePosition).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    it('safeguard #3 — outside-click handler does not fire on the SAME click that opened the menu', () => {
      const { props } = renderMenu()

      // Fire a pointerdown synchronously, BEFORE the next animation
      // frame: this simulates the same user gesture that triggered
      // mounting the menu (the regression we are guarding against).
      fireEvent.pointerDown(document.body)

      expect(props.onClose).not.toHaveBeenCalled()
    })

    it('safeguard #4 — falls back to anchor coords and warns when computePosition rejects', async () => {
      const { autoUpdate, computePosition } = await import('@floating-ui/dom')
      const mockedAutoUpdate = vi.mocked(autoUpdate)
      const mockedComputePosition = vi.mocked(computePosition)

      // Use a real (rejecting) promise so the .catch fires.
      const positioningError = new Error('boom')
      mockedComputePosition.mockRejectedValueOnce(positioningError)

      // Restore eager autoUpdate semantics for this test (mock is
      // shared across tests — the previous test replaced it).
      mockedAutoUpdate.mockImplementation(((_ref, _floating, update) => {
        update()
        return () => {}
      }) as typeof autoUpdate)

      const { logger: loggerMod } = await import('@/lib/logger')
      const warnSpy = vi.spyOn(loggerMod, 'warn').mockImplementation(() => {})

      renderMenu({ position: { x: 175, y: 325 } })

      // Wait for the rejected promise's catch handler to run.
      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'BlockContextMenu',
          'positioning failed, falling back to anchor coords',
          expect.objectContaining({ x: 175, y: 325 }),
          positioningError,
        )
      })

      // The menu should still be positioned at the original anchor
      // coordinates passed in via the `position` prop.
      const menu = screen.getByRole('menu')
      await waitFor(() => {
        expect(menu.style.left).toBe('175px')
        expect(menu.style.top).toBe('325px')
      })

      warnSpy.mockRestore()
    })
  })

  // ── hardening cluster ──────────────────────────────────
  //
  // 1. Action errors keep the menu open + surface as toast + log.
  // 2. First-item focus refires when the visible item set changes.
  // 3. Close-fallback uses `data-context-trigger="true"` (not `[role="button"]`).

  describe('action error handling', () => {
    it('synchronous action throw keeps menu open and shows toast', async () => {
      const user = userEvent.setup()
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
      const onClose = vi.fn()
      const onDelete = vi.fn(() => {
        throw new Error('sync boom')
      })

      renderMenu({ onClose, onDelete })

      await user.click(screen.getByText(t('contextMenu.delete')))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(t('contextMenu.actionFailed'))
      })
      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith(
        'BlockContextMenu',
        'action failed',
        expect.objectContaining({ blockId: 'BLOCK_01' }),
        expect.any(Error),
      )
      expect(onClose).not.toHaveBeenCalled()

      errorSpy.mockRestore()
    })

    it('asynchronous action rejection keeps menu open and shows toast', async () => {
      const user = userEvent.setup()
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
      const onClose = vi.fn()
      const onIndent = vi.fn(() => Promise.reject(new Error('async boom')))

      renderMenu({ onClose, onIndent })

      // Indent is nested under the "Move & arrange" disclosure.
      await expandMoveArrange(user)
      await user.click(screen.getByText(t('contextMenu.indent')))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(t('contextMenu.actionFailed'))
      })
      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith(
        'BlockContextMenu',
        'action failed',
        expect.objectContaining({ blockId: 'BLOCK_01' }),
        expect.any(Error),
      )
      expect(onClose).not.toHaveBeenCalled()

      errorSpy.mockRestore()
    })

    it('successful action calls onClose and does not show error toast', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onDelete = vi.fn(() => Promise.resolve())

      renderMenu({ onClose, onDelete })

      await user.click(screen.getByText(t('contextMenu.delete')))

      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1)
      })
      expect(onDelete).toHaveBeenCalledWith('BLOCK_01')
      expect(toast.error).not.toHaveBeenCalled()
    })
  })

  describe('first-item focus refires on item-set change', () => {
    it('refocuses the first item when the visible set grows (hasChildren toggle)', async () => {
      // Render initially without children — no Collapse/Expand item is shown.
      const { rerender, props } = renderMenu({ hasChildren: false })

      const initialItems = screen.getAllByRole('menuitem')
      expect(initialItems[0]).toHaveFocus()
      const initialCount = initialItems.length

      // Re-render with hasChildren=true — Collapse joins the visible set.
      rerender(<BlockContextMenu {...(props as BlockContextMenuProps)} hasChildren />)

      await waitFor(() => {
        expect(screen.getAllByRole('menuitem').length).toBe(initialCount + 1)
      })

      // Focus must land on the (current) first item — not on a stale ref.
      const updatedItems = screen.getAllByRole('menuitem')
      expect(updatedItems[0]).toHaveFocus()
    })

    it('refocuses the new first item when linkUrl appears (Open link becomes first)', async () => {
      // No linkUrl initially → the link group (Open link / Copy URL) is absent
      // and the Tasks group leads (#217 A1); the first item is some non-link
      // action with focus.
      const { rerender, props } = renderMenu()

      const initialItems = screen.getAllByRole('menuitem')
      expect(initialItems[0]).not.toHaveTextContent(t('contextMenu.openLink'))
      expect(initialItems[0]).toHaveFocus()
      const initialCount = initialItems.length

      // Add linkUrl → Open link + Copy URL are prepended; Open link owns focus.
      rerender(
        <BlockContextMenu
          {...(props as BlockContextMenuProps)}
          linkUrl="https://example.com/page"
        />,
      )

      await waitFor(() => {
        // Two items join: Open link and Copy URL.
        expect(screen.getAllByRole('menuitem').length).toBe(initialCount + 2)
      })

      const updatedItems = screen.getAllByRole('menuitem')
      expect(updatedItems[0]).toHaveTextContent(t('contextMenu.openLink'))
      expect(updatedItems[0]).toHaveFocus()
    })
  })

  describe('close-fallback selector', () => {
    it('focuses the [data-context-trigger="true"] gutter button, not a [role="button"] sibling', () => {
      // Same block has both a `[role="button"]` chip (e.g. an inline date
      // chip) and a `[data-context-trigger="true"]` gutter button. The
      // close-fallback must prefer the gutter marker.
      const blockEl = document.createElement('div')
      blockEl.setAttribute('data-block-id', 'BLOCK_01')

      const chip = document.createElement('span')
      chip.setAttribute('role', 'button')
      chip.tabIndex = 0
      blockEl.append(chip)

      const gutterBtn = document.createElement('button')
      gutterBtn.setAttribute('data-context-trigger', 'true')
      blockEl.append(gutterBtn)

      document.body.append(blockEl)

      const chipFocusSpy = vi.spyOn(chip, 'focus')
      const gutterFocusSpy = vi.spyOn(gutterBtn, 'focus')

      const triggerRef = { current: null as HTMLElement | null }
      renderMenu({ triggerRef })

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(gutterFocusSpy).toHaveBeenCalledTimes(1)
      expect(chipFocusSpy).not.toHaveBeenCalled()

      document.body.removeChild(blockEl)
    })
  })

  // ── "Turn into" context-menu UX (#999/#1001/#1003) ──────────────────
  describe('Turn into submenu UX (#999/#1001/#1003)', () => {
    const TEXT = t('contextMenu.turnIntoType.paragraph')

    function expandTurnInto() {
      const toggle = screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.turnInto')) })
      fireEvent.click(toggle)
      return toggle
    }

    it('#1003 — the toggle exposes aria-expanded and aria-controls, toggling with the submenu', () => {
      renderMenu({ onTurnInto: vi.fn(), activeBlockType: 'h1' })

      const toggle = screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.turnInto')) })
      // Collapsed by default.
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const controls = toggle.getAttribute('aria-controls')
      expect(controls).toBeTruthy()
      // No options rendered yet.
      expect(screen.queryByText(TEXT)).not.toBeInTheDocument()

      fireEvent.click(toggle)

      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      // The expanded options live in their own labelled group, linked via id.
      const group = screen.getByRole('group', { name: t('contextMenu.turnInto') })
      expect(group.id).toBe(controls)
      expect(within(group).getByText(TEXT)).toBeInTheDocument()

      // Collapses again.
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText(TEXT)).not.toBeInTheDocument()
    })

    it('#999 — child type rows carry the row-level indent class (not a per-icon ml-3)', () => {
      renderMenu({ onTurnInto: vi.fn(), activeBlockType: 'h1' })
      expandTurnInto()

      // Unchecked option (paragraph): an actionable button, indented at the row.
      const option = screen.getByRole('menuitem', { name: TEXT })
      expect(option.className).toContain('pl-7')
      // The old ad-hoc per-icon indent must be gone.
      expect(option.querySelector('.ml-3')).toBeNull()
    })

    it('#999/#1001 — the active type renders an indented, ring-less lucide Check (no bare ✓)', () => {
      // h1 is active → its row is the non-interactive indicator.
      renderMenu({ onTurnInto: vi.fn(), activeBlockType: 'h1' })
      expandTurnInto()

      const h1Label = t('contextMenu.turnIntoType.h1')
      const indicator = screen.getByText(h1Label).closest('[role="menuitem"]')
      expect(indicator).not.toBeNull()
      const row = indicator as HTMLElement
      // aria-current marks the active type; no bare unicode tick.
      expect(row).toHaveAttribute('aria-current', 'true')
      expect(row.textContent).not.toContain('✓')
      // Renders a lucide svg icon (the Check), and is indented at the row level.
      expect(row.querySelector('svg')).not.toBeNull()
      expect(row.className).toContain('pl-7')
      // The non-interactive indicator stays ring-less.
      expect(row.className).not.toContain('focus-ring-visible')
    })

    it('#1003 — the toggle shows a lucide chevron, not a unicode triangle', () => {
      renderMenu({ onTurnInto: vi.fn() })
      const toggle = screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.turnInto')) })
      // No raw ▸/▾ glyph in the shortcut slot; a lucide chevron svg instead.
      expect(toggle.textContent).not.toContain('▸')
      expect(toggle.textContent).not.toContain('▾')
      // svgs present: the leading Replace icon + the trailing chevron.
      expect(toggle.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
    })

    // #976 (item 14) — the Turn into toggle surfaces its new keyboard binding
    // hint alongside the disclosure chevron.
    it('shows the Ctrl+Shift+T binding hint on the Turn into toggle', () => {
      renderMenu({ onTurnInto: vi.fn() })
      const toggle = screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.turnInto')) })
      expect(within(toggle).getByText('Ctrl+Shift+T')).toBeInTheDocument()
      // The chevron still renders next to the hint (toggle keeps its disclosure
      // affordance — both svgs present).
      expect(toggle.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
    })

    it('clicking a non-active type converts the block and closes the menu', async () => {
      const user = userEvent.setup()
      const onTurnInto = vi.fn()
      const { props } = renderMenu({ onTurnInto, activeBlockType: 'h1' })
      expandTurnInto()

      await user.click(screen.getByRole('menuitem', { name: TEXT }))

      expect(onTurnInto).toHaveBeenCalledWith('BLOCK_01', 'paragraph')
      expect(props.onClose).toHaveBeenCalled()
    })
  })

  // ── "Move & arrange" disclosure (#1109) ─────────────────────────────
  //
  // The low-frequency block-ops (Move up/down, Duplicate, Merge) collapse
  // behind a single "Move & arrange" toggle, mirroring the "Turn into"
  // disclosure. These tests assert: the toggle renders top-level + collapsed by
  // default; expanding reveals every nested op (all reachable); the nested ops
  // still fire their action; the aria wiring (expanded/controls/labelled group);
  // and that the disclosure introduces no a11y violations.
  describe('Move & arrange disclosure (#1109)', () => {
    function getToggle() {
      return screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.moveArrange')) })
    }

    it('renders the toggle top-level and collapsed by default (ops hidden)', () => {
      renderMenu({ onMerge: vi.fn(), onDuplicate: vi.fn() })

      const toggle = getToggle()
      expect(toggle).toBeInTheDocument()
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      // None of the nested ops are rendered while collapsed.
      expect(screen.queryByText(t('contextMenu.moveUp'))).not.toBeInTheDocument()
      expect(screen.queryByText(t('contextMenu.moveDown'))).not.toBeInTheDocument()
      expect(screen.queryByText(t('contextMenu.duplicate'))).not.toBeInTheDocument()
      expect(screen.queryByText(t('contextMenu.merge'))).not.toBeInTheDocument()
    })

    it('expanding reveals all four ops in a labelled group; each remains reachable', async () => {
      const user = userEvent.setup()
      renderMenu({ onMerge: vi.fn(), onDuplicate: vi.fn() })

      const toggle = getToggle()
      const controls = toggle.getAttribute('aria-controls')
      expect(controls).toBeTruthy()

      await user.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')

      // The nested ops live in their own labelled group linked via the id.
      const group = screen.getByRole('group', { name: t('contextMenu.moveArrange') })
      expect(group.id).toBe(controls)
      expect(within(group).getByText(t('contextMenu.moveUp'))).toBeInTheDocument()
      expect(within(group).getByText(t('contextMenu.moveDown'))).toBeInTheDocument()
      expect(within(group).getByText(t('contextMenu.duplicate'))).toBeInTheDocument()
      expect(within(group).getByText(t('contextMenu.merge'))).toBeInTheDocument()

      // Collapses again, hiding the ops.
      await user.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText(t('contextMenu.moveUp'))).not.toBeInTheDocument()
    })

    it('nested Move up fires onMoveUp when activated from the expanded group', async () => {
      const user = userEvent.setup()
      const { props } = renderMenu({ onMerge: vi.fn(), onDuplicate: vi.fn() })
      await user.click(getToggle())
      await user.click(screen.getByText(t('contextMenu.moveUp')))
      expect(props.onMoveUp).toHaveBeenCalledWith('BLOCK_01')
      expect(props.onClose).toHaveBeenCalled()
    })

    it('nested Move down fires onMoveDown when activated from the expanded group', async () => {
      const user = userEvent.setup()
      const { props } = renderMenu({ onMerge: vi.fn(), onDuplicate: vi.fn() })
      await user.click(getToggle())
      await user.click(screen.getByText(t('contextMenu.moveDown')))
      expect(props.onMoveDown).toHaveBeenCalledWith('BLOCK_01')
    })

    it('nested Duplicate fires onDuplicate when activated from the expanded group', async () => {
      const user = userEvent.setup()
      const onDuplicate = vi.fn()
      renderMenu({ onMerge: vi.fn(), onDuplicate })
      await user.click(getToggle())
      await user.click(screen.getByText(t('contextMenu.duplicate')))
      expect(onDuplicate).toHaveBeenCalledWith('BLOCK_01')
    })

    it('nested Merge fires onMerge when activated from the expanded group', async () => {
      const user = userEvent.setup()
      const onMerge = vi.fn()
      renderMenu({ onMerge })
      await user.click(getToggle())
      await user.click(screen.getByText(t('contextMenu.merge')))
      expect(onMerge).toHaveBeenCalledWith('BLOCK_01')
    })

    it('the toggle shows a lucide chevron (collapsed→expanded), not a unicode triangle', async () => {
      const user = userEvent.setup()
      renderMenu()

      const toggle = getToggle()
      expect(toggle.textContent).not.toContain('▸')
      expect(toggle.textContent).not.toContain('▾')
      // svgs present: the leading move icon + the trailing chevron.
      expect(toggle.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
      await user.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
    })

    it('omits the toggle entirely when no nested op is wired', () => {
      // No move-arrange child wired (Indent/Dedent/Move up/Move down/Duplicate/
      // Merge all absent) → the disclosure has no children, so the toggle must
      // not render (no dead-end disclosure). Only a non-move action is wired.
      render(
        <BlockContextMenu
          blockId="BLOCK_01"
          position={{ x: 0, y: 0 }}
          onClose={vi.fn()}
          actions={{ onToggleTodo: vi.fn() }}
          hasChildren={false}
        />,
      )
      expect(
        screen.queryByRole('menuitem', { name: new RegExp(t('contextMenu.moveArrange')) }),
      ).not.toBeInTheDocument()
    })

    it('has no a11y violations with the disclosure expanded', async () => {
      const user = userEvent.setup()
      const { container } = renderMenu({ onMerge: vi.fn(), onDuplicate: vi.fn() })

      await user.click(getToggle())
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('keeps the two disclosures independent (Turn into vs Move & arrange)', async () => {
      // Both disclosures present: each toggle controls its OWN group id, and
      // expanding one does not expand the other.
      const user = userEvent.setup()
      renderMenu({ onMerge: vi.fn(), onTurnInto: vi.fn() })

      const moveToggle = getToggle()
      const turnToggle = screen.getByRole('menuitem', {
        name: new RegExp(t('contextMenu.turnInto')),
      })
      expect(moveToggle.getAttribute('aria-controls')).not.toBe(
        turnToggle.getAttribute('aria-controls'),
      )

      await user.click(moveToggle)
      expect(moveToggle).toHaveAttribute('aria-expanded', 'true')
      // Turn into stays collapsed.
      expect(turnToggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText(t('contextMenu.turnIntoType.paragraph'))).not.toBeInTheDocument()
      // The move ops are visible.
      expect(screen.getByText(t('contextMenu.merge'))).toBeInTheDocument()
    })
  })
})

/* ── A2 (#1020): single `actions` bag prop ───────────────────────────── */

describe('BlockContextMenu actions bag (#1020)', () => {
  it('accepts the action callbacks via a single `actions: BlockActions` prop', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    const onMerge = vi.fn()
    const onClose = vi.fn()

    // No flat callbacks — the menu receives ONLY the structural props plus the
    // cohesive `actions` bag (the production shape that SortableBlock forwards
    // verbatim from `useBlockActions()`).
    const actions: BlockActions = { onDelete, onMerge }
    render(
      <BlockContextMenu
        blockId="BLOCK_01"
        position={{ x: 0, y: 0 }}
        onClose={onClose}
        actions={actions}
        hasChildren={false}
      />,
    )

    // Both wired actions render and dispatch with the block id. #1109 — Merge
    // is nested under the "Move & arrange" disclosure; expand it first.
    await user.click(
      screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.moveArrange')) }),
    )
    await user.click(screen.getByText(t('contextMenu.merge')))
    expect(onMerge).toHaveBeenCalledWith('BLOCK_01')
    expect(onClose).toHaveBeenCalled()
  })

  it('renders only the items whose action is present in the bag — a missing action is omitted, never a dead row', async () => {
    // A deliberately partial bag: only Delete + Indent are wired. Every OTHER
    // action key is absent, so the menu must NOT render those items at all
    // (no dead/no-op buttons that would silently fail when clicked).
    const user = userEvent.setup()
    render(
      <BlockContextMenu
        blockId="BLOCK_01"
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
        actions={{ onDelete: vi.fn(), onIndent: vi.fn() }}
        hasChildren
      />,
    )

    const menu = screen.getByRole('menu')
    // Present:
    expect(within(menu).getByText(t('contextMenu.delete'))).toBeInTheDocument()
    // #1445 — "Copy block reference" is independent of the actions bag (it only
    // needs the blockId), so it is always present.
    expect(within(menu).getByText(t('contextMenu.copyBlockRef'))).toBeInTheDocument()
    // Indent is wired but nested under the (collapsed) "Move & arrange"
    // disclosure, so the toggle is present while Indent itself is hidden.
    expect(
      within(menu).getByRole('menuitem', { name: new RegExp(t('contextMenu.moveArrange')) }),
    ).toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.indent'))).not.toBeInTheDocument()
    // Absent (their bag keys were never provided):
    expect(within(menu).queryByText(t('contextMenu.setTodo'))).not.toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.setPriority1'))).not.toBeInTheDocument()
    // hasChildren=true but no onToggleCollapse → no Collapse row.
    expect(within(menu).queryByText(t('contextMenu.collapse'))).not.toBeInTheDocument()
    // #1445 — no `pageRefId` passed here → "Copy page reference" stays absent.
    expect(within(menu).queryByText(t('contextMenu.copyPageRef'))).not.toBeInTheDocument()

    // Top-level: Delete, Copy block reference, and the Move & arrange toggle —
    // no extra dead rows.
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)

    // Expanding the disclosure reveals Indent (the only wired child); Dedent /
    // Move up / Move down stay absent since their bag keys were never provided.
    await user.click(
      within(menu).getByRole('menuitem', { name: new RegExp(t('contextMenu.moveArrange')) }),
    )
    expect(within(menu).getByText(t('contextMenu.indent'))).toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.dedent'))).not.toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.moveUp'))).not.toBeInTheDocument()
    expect(within(menu).queryByText(t('contextMenu.moveDown'))).not.toBeInTheDocument()
  })

  it('still renders the Copy block reference row when the actions bag is empty (#1445)', () => {
    render(
      <BlockContextMenu
        blockId="BLOCK_01"
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
        actions={{}}
        hasChildren={false}
      />,
    )
    // #1445 — even with an empty bag the menu is not a dead end: "Copy block
    // reference" is always actionable, so the menu renders with that single row
    // (the null short-circuit only fired when there were ZERO actionable
    // items, which can no longer happen).
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText(t('contextMenu.copyBlockRef'))).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  })
})

/* ── Fix 6: bulk ops apply to the whole multi-selection ──────────────── */

describe('BlockContextMenu bulk mode (Fix 6)', () => {
  const SELECTION = ['BLOCK_01', 'B2', 'B3']

  it('Delete applies to EVERY selected id via the batch handler when in bulk mode', async () => {
    const user = userEvent.setup()
    const onBatchDelete = vi.fn()
    const { props } = renderMenu({ selectedBlockIds: SELECTION, onBatchDelete })

    // Label reflects the selection count.
    await user.click(screen.getByText(t('contextMenu.deleteSelected', { count: SELECTION.length })))

    expect(onBatchDelete).toHaveBeenCalledTimes(1)
    // The per-block onDelete is NOT looped when a batch handler is available.
    expect(props.onDelete).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
  })

  it('Delete loops per-block onDelete for every selected id when no batch handler', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ selectedBlockIds: SELECTION })

    await user.click(screen.getByText(t('contextMenu.deleteSelected', { count: SELECTION.length })))

    expect(props.onDelete).toHaveBeenCalledTimes(SELECTION.length)
    for (const id of SELECTION) {
      expect(props.onDelete).toHaveBeenCalledWith(id)
    }
    expect(props.onClose).toHaveBeenCalled()
  })

  it('TODO cycle applies to every selected id in bulk mode', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ selectedBlockIds: SELECTION })

    await user.click(screen.getByText(t('contextMenu.cycleTodoSelected')))

    expect(props.onToggleTodo).toHaveBeenCalledTimes(SELECTION.length)
    for (const id of SELECTION) {
      expect(props.onToggleTodo).toHaveBeenCalledWith(id)
    }
  })

  it('Priority cycle applies to every selected id in bulk mode', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ selectedBlockIds: SELECTION })

    await user.click(screen.getByText(t('contextMenu.cyclePrioritySelected')))

    expect(props.onTogglePriority).toHaveBeenCalledTimes(SELECTION.length)
    for (const id of SELECTION) {
      expect(props.onTogglePriority).toHaveBeenCalledWith(id)
    }
  })

  it('Move applies to every selected id in bulk mode', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ selectedBlockIds: SELECTION })

    // #1109 — Move up now lives behind the "Move & arrange" disclosure; expand
    // it first, then activate the (now-visible) Move up row.
    await user.click(
      screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.moveArrange')) }),
    )
    await user.click(screen.getByText(t('contextMenu.moveUp')))

    expect(props.onMoveUp).toHaveBeenCalledTimes(SELECTION.length)
    for (const id of SELECTION) {
      expect(props.onMoveUp).toHaveBeenCalledWith(id)
    }
  })

  it('stays single-block when the right-clicked block is NOT in the selection', async () => {
    const user = userEvent.setup()
    // Selection of others; the menu opened on BLOCK_01 which is not selected.
    const { props } = renderMenu({ selectedBlockIds: ['B2', 'B3'] })

    // The single-block delete label is shown, not the "N selected" one.
    expect(
      screen.queryByText(t('contextMenu.deleteSelected', { count: 2 })),
    ).not.toBeInTheDocument()
    await user.click(screen.getByText(t('contextMenu.delete')))

    expect(props.onDelete).toHaveBeenCalledTimes(1)
    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
  })

  it('stays single-block for a selection of exactly one block', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu({ selectedBlockIds: ['BLOCK_01'] })

    await user.click(screen.getByText(t('contextMenu.delete')))
    expect(props.onDelete).toHaveBeenCalledWith('BLOCK_01')
    expect(props.onDelete).toHaveBeenCalledTimes(1)
  })
})

/* ── #1018: the menu reads the LIVE store selection (no per-row array sub) ── */
//
// The perf fix moved the `selectedBlockIds` subscription out of every
// `SortableBlock` row and INTO this menu. These tests pass NO `selectedBlockIds`
// prop, so the menu must read the global store directly — proving bulk mode
// still engages purely from store state, AND that the original stale-snapshot
// regression (bulk mode silently not engaging on the 2nd selected block) does
// not return: the menu reflects whatever the store holds at render time.
describe('BlockContextMenu store-driven bulk mode (#1018)', () => {
  it('reads the global selection from the store when no prop is passed (bulk mode)', async () => {
    const user = userEvent.setup()
    // Two blocks selected in the GLOBAL store, including the right-clicked one.
    // This is the exact state after selecting a 2nd block — the regression the
    // original full-array subscription was added to fix.
    useBlockStore.getState().setSelected(['BLOCK_01', 'B2'])

    const { props } = renderMenu({ onBatchDelete: vi.fn() })

    // Bulk-delete label reflects the store count — bulk mode engaged from the
    // store alone, with no `selectedBlockIds` prop.
    await user.click(screen.getByText(t('contextMenu.deleteSelected', { count: 2 })))
    expect(props.onBatchDelete).toHaveBeenCalledTimes(1)
  })

  it('stays single-block when the store selection does not include this block', () => {
    // Selection of OTHER blocks; menu opened on BLOCK_01 (not selected).
    useBlockStore.getState().setSelected(['B2', 'B3'])

    renderMenu()

    expect(
      screen.queryByText(t('contextMenu.deleteSelected', { count: 2 })),
    ).not.toBeInTheDocument()
    expect(screen.getByText(t('contextMenu.delete'))).toBeInTheDocument()
  })

  it('stays single-block for an empty store selection', () => {
    // Default beforeEach already cleared the store.
    renderMenu()
    expect(screen.getByText(t('contextMenu.delete'))).toBeInTheDocument()
  })

  it('an explicit selectedBlockIds prop overrides the store read', async () => {
    const user = userEvent.setup()
    // Store says single-block, but the explicit prop says bulk — prop wins.
    useBlockStore.getState().setSelected(['BLOCK_01'])

    const { props } = renderMenu({
      selectedBlockIds: ['BLOCK_01', 'B2', 'B3'],
      onBatchDelete: vi.fn(),
    })

    await user.click(screen.getByText(t('contextMenu.deleteSelected', { count: 3 })))
    expect(props.onBatchDelete).toHaveBeenCalledTimes(1)
  })
})
